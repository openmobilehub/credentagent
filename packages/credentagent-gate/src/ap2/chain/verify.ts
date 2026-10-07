// Walk a delegation chain — Delegate SD-JWT §6 — fail-closed at every link.
//
// What a PASS means, exactly: the credential verifies against its own certificate; the wallet's
// hop was signed by the key that credential names, discloses exactly one open mandate, and is
// bound to the credential it was made for; the agent's hop was signed by the key that open
// mandate names, carries one closed mandate, is bound to that exact wallet hop, and is addressed
// to this merchant with this merchant's nonce. Nothing expired.
//
// What it does NOT mean: that the closed mandate stays inside the open one's limits (that is
// `constraints.ts`), that the price is right (re-price: invariant 2), or that the credential came
// from a real issuer — its certificate is self-minted until #14 lands, which is why a chain
// verified here is presence-only.
import { createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { sdJwtInstance } from "../sdjwt.js";
import { linkToString, splitChain, type ChainLink } from "./serialize.js";
import { bindingHash, DELEGATE_PAYLOAD, HOP_TYP, peekLink } from "./hop.js";

export type ChainRefusalCode =
  | "malformed" // not a three-link dSD-JWT, or a claim of the wrong type
  | "root" // the credential carries no certificate to check it against
  | "signature" // a link does not verify against the key it must
  | "binding" // a hop's sd_hash does not name the link before it, or it binds by issuer_jwt_hash
  | "typ" // a hop's typ disagrees with whether it names a further key
  | "disclosure" // a hop discloses other than exactly one delegate payload, or one it never signed
  | "audience" // the agent's hop is addressed to another merchant
  | "nonce" // the agent's hop carries another nonce
  | "expired"
  | "not-yet-valid";

export interface ChainRefusal {
  ok: false;
  code: ChainRefusalCode;
  detail: string;
}

export interface ChainVerdict {
  ok: true;
  /** The credential's verified claims — the root of the chain. */
  credential: Record<string, unknown>;
  /** The open mandate the wallet signed and this chain disclosed. */
  open: Record<string, unknown>;
  /** The closed mandate the agent signed. */
  closed: Record<string, unknown>;
  /** The links, as verified — for a caller that must compare two chains' roots. */
  links: ChainLink[];
}

export interface VerifyChainOptions {
  /** Who the agent's hop must be addressed to — this merchant. */
  audience: string;
  /** The nonce this merchant issued for this purchase. */
  nonce: string;
  /** Epoch ms. Injectable for expiry tests. */
  nowMs?: number;
}

/** Clock tolerance on `iat` — the same minute `verifyMandate` allows. */
const SKEW_SECONDS = 60;

const refuse = (code: ChainRefusalCode, detail: string): ChainRefusal => ({ ok: false, code, detail });

/** Name a library failure on link `i` by the side of the check that failed. */
function linkRefusal(i: number, message: string): ChainRefusal {
  if (/is expired/i.test(message)) return refuse("expired", `link ${i}: ${message}`);
  if (/not yet valid/i.test(message)) return refuse("not-yet-valid", `link ${i}: ${message}`);
  if (/disclosure|digest/i.test(message)) return refuse("disclosure", `link ${i}: ${message}`);
  if (/must be a number/i.test(message)) return refuse("malformed", `link ${i}: ${message}`);
  return refuse("signature", `link ${i}: ${message}`);
}

/** The credential's issuer key, from its own `x5c` leaf. Demo trust: nothing anchors the certificate (#14). */
function rootKey(link: ChainLink): KeyObject | undefined {
  const leaf = (peekLink(link)?.header.x5c as unknown[] | undefined)?.[0];
  if (typeof leaf !== "string") return undefined;
  try {
    return new X509Certificate(Buffer.from(leaf, "base64")).publicKey;
  } catch {
    return undefined;
  }
}

function cnfKey(holder: Record<string, unknown>): KeyObject | undefined {
  const jwk = (holder.cnf as { jwk?: Record<string, unknown> } | undefined)?.jwk;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") return undefined;
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as never, format: "jwk" });
  } catch {
    return undefined;
  }
}

/**
 * Verify a dSD-JWT delegation chain: `<credential>~~<wallet hop>~~<agent hop>~`.
 *
 * Every link is verified as an SD-JWT in its own right (§6 steps 2-3): a disclosure its signer
 * never committed to is refused, not read.
 */
export async function verifyChain(token: string, opts: VerifyChainOptions): Promise<ChainVerdict | ChainRefusal> {
  if (typeof token !== "string") return refuse("malformed", "a chain is a string");
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const libOptions = { currentDate: nowSec, skewSeconds: SKEW_SECONDS, allowedIssuerAlgorithms: ["ES256"] };

  const links = splitChain(token);
  // The AP2 shape is exactly three links. A longer chain (an agent delegating to a sub-agent) is
  // something the draft allows and this verifier does not yet evaluate — so it is refused rather
  // than half-checked.
  if (!links || links.length !== 3) return refuse("malformed", "expected `<credential>~~<wallet hop>~~<agent hop>~`");

  const key = rootKey(links[0]);
  if (!key) return refuse("root", "link 0: the credential carries no x5c certificate to verify it against");

  let holder: Record<string, unknown>;
  let credential: Record<string, unknown>;
  try {
    credential = (await sdJwtInstance({ publicKey: key }).verify(linkToString(links[0]), libOptions)).payload as Record<string, unknown>;
    holder = credential;
  } catch (err) {
    return linkRefusal(0, (err as Error).message);
  }

  const elements: Record<string, unknown>[] = [];
  for (let i = 1; i < links.length; i++) {
    const last = i === links.length - 1;
    const signer = cnfKey(holder);
    if (!signer) return refuse("signature", `link ${i}: the link before it names no P-256 cnf key`);

    let payload: Record<string, unknown>;
    try {
      payload = (await sdJwtInstance({ publicKey: signer }).verify(linkToString(links[i]), libOptions)).payload as Record<string, unknown>;
    } catch (err) {
      return linkRefusal(i, (err as Error).message);
    }

    // §5.1.4: a hop names the link before it, so a hop signed by a reused key cannot slot under any
    // other predecessor that key ever signed (§8.1). Only `sd_hash` is accepted. The draft's other
    // binding, `issuer_jwt_hash`, covers the previous JWT but not its disclosures, so it is the
    // weaker one, and nothing here or in the AP2 SDK emits it. It is refused until a sender needs it.
    if ("issuer_jwt_hash" in payload) return refuse("binding", `link ${i}: binds by issuer_jwt_hash, which this verifier does not accept — use sd_hash`);
    if (payload.sd_hash !== bindingHash(links[i - 1])) return refuse("binding", `link ${i}: sd_hash does not name link ${i - 1}`);
    if (typeof payload.iat !== "number") return refuse("malformed", `link ${i}: a key-binding hop needs a numeric iat`);

    // Undisclosed elements were dropped by the verify above; what is left is what this chain shows.
    const disclosed = Array.isArray(payload[DELEGATE_PAYLOAD])
      ? (payload[DELEGATE_PAYLOAD] as unknown[]).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !("..." in e))
      : [];
    if (disclosed.length !== 1) return refuse("disclosure", `link ${i}: discloses ${disclosed.length} delegate payloads — exactly one is required`);
    const element = disclosed[0];

    // `typ` says whether this hop may be delegated again, and must agree with whether it names
    // the key that would do it. A wallet hop typed terminal while naming the agent is refused —
    // it is also what the AP2 Python SDK refuses.
    const typ = peekLink(links[i])?.header.typ;
    const wants = element.cnf ? HOP_TYP.delegable : HOP_TYP.terminal;
    if (typ !== wants) return refuse("typ", `link ${i}: typed ${String(typ)} but ${element.cnf ? "names" : "names no"} further key — expected ${wants}`);
    if (last && element.cnf) return refuse("typ", `link ${i}: the last hop names a further key, so the chain is not finished`);
    if (!last && !element.cnf) return refuse("typ", `link ${i}: names no key for the next hop`);

    // The open mandate's own lifetime. The library saw the hop's claims, not the mandate's.
    if (element.exp !== undefined && typeof element.exp !== "number") return refuse("malformed", `link ${i}: exp is not a number`);
    if (!last && typeof element.exp !== "number") return refuse("malformed", `link ${i}: an open mandate needs an exp — without one it never ends`);
    if (typeof element.exp === "number" && nowSec >= element.exp) return refuse("expired", `link ${i}: exp=${element.exp} now=${nowSec}`);

    if (last) {
      if (payload.aud !== opts.audience) return refuse("audience", `link ${i}: addressed to ${String(payload.aud)}`);
      if (payload.nonce !== opts.nonce) return refuse("nonce", `link ${i}: nonce is not the one this merchant issued`);
    }
    elements.push(element);
    holder = element;
  }

  return { ok: true, credential, open: elements[0], closed: elements[1], links };
}
