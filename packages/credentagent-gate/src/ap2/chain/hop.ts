// One delegation hop: a KB-SD-JWT (Delegate SD-JWT §5.1.4) appended to a chain by the holder of
// the key the previous link names in `cnf`.
//
// The agent signs its purchase this way — a TERMINAL hop carrying one closed mandate, typed
// `kb+sd-jwt`, addressed to the merchant with the merchant's nonce, and bound to the exact link
// before it by `sd_hash`. That binding is what stops the hop being lifted onto a different
// permission signed by the same wallet.
import type { KeyObject } from "node:crypto";
import { digestToken, SD_HASH_ALG, sdJwtInstance } from "../sdjwt.js";
import { joinChain, linkToString, splitChain, type ChainLink } from "./serialize.js";

/** §5.1.4: a hop whose payload names a further key, and one that ends the chain. */
export const HOP_TYP = { delegable: "kb+sd-jwt+kb", terminal: "kb+sd-jwt" } as const;

/** The claim a KB-SD-JWT carries its Delegate Payload in (AP2's spelling of §5.1.4's). */
export const DELEGATE_PAYLOAD = "delegate_payload";

const decode = (segment: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** A link's header and payload, UNVERIFIED — for routing (which key, which hash), never a decision. */
export function peekLink(link: ChainLink): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  const [h, p] = link.jwt.split(".");
  const header = decode(h);
  const payload = decode(p);
  return header && payload ? { header, payload } : undefined;
}

/**
 * The `sd_hash` binding a hop to the link before it: the digest of that link's exact
 * serialization, disclosures included (§5.1.3). Hashed with the previous link's own `_sd_alg`,
 * sha-256 when it names none — the AP2 Python SDK's rule, so the two compute the same bytes.
 */
export function bindingHash(prev: ChainLink): string {
  const alg = peekLink(prev)?.payload._sd_alg;
  return digestToken(linkToString(prev), typeof alg === "string" ? alg : SD_HASH_ALG);
}

/** The `issuer_jwt_hash` alternative: the previous link's signed JWT only, no disclosures. */
export function issuerJwtHash(prev: ChainLink): string {
  const alg = peekLink(prev)?.payload._sd_alg;
  return digestToken(prev.jwt, typeof alg === "string" ? alg : SD_HASH_ALG);
}

/**
 * Append the agent's hop to a chain. `audience` and `nonce` are the MERCHANT's: they are what
 * keep this purchase from being replayed at another store or a second time at this one.
 */
export async function appendAgentHop(args: {
  chain: string;
  agentKey: KeyObject;
  /** The closed mandate this purchase is. A content carrying `cnf` delegates further. */
  content: Record<string, unknown>;
  audience: string;
  nonce: string;
}): Promise<string> {
  if (!args.audience || !args.nonce) throw new Error("a delegation hop needs the merchant's audience and nonce — without them it replays anywhere");
  const links = splitChain(args.chain);
  if (!links) throw new Error("not a delegation chain: expected `<credential>~~<wallet hop>~…~`");
  const typ = args.content.cnf ? HOP_TYP.delegable : HOP_TYP.terminal;
  const hop = await sdJwtInstance({ privateKey: args.agentKey }).issue(
    {
      iat: Math.floor(Date.now() / 1000),
      aud: args.audience,
      nonce: args.nonce,
      sd_hash: bindingHash(links[links.length - 1]),
      [DELEGATE_PAYLOAD]: [args.content],
    } as never,
    { [DELEGATE_PAYLOAD]: { _sd: [0] } } as never,
    { header: { typ } },
  );
  return joinChain([...links.map(linkToString), hop]);
}
