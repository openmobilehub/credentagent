// TEST UTILITY — a wallet and a grant, in-process, for the chain tests. Not exported from the
// package and not compiled into `dist/` (nothing the package entry imports reaches it).
//
// It produces what the intent-sign rail hands a gate after a ceremony: the wallet's presentation
// `<credential>~<disclosures>~<KB-SD-JWT>` and the `delegate` disclosures the request carried. The
// MANDATES and their disclosures come from the rail's own `openMandatesForGrant` /
// `delegateEntries`; the credential and the key binding are signed here, with the same dev-wallet
// helpers the shipped simulator uses — so the chain is tested against the terms the rail builds,
// signed the way a wallet signs them.
//
// The `override*` knobs each produce something a correct chain verifier MUST refuse.
import { SDJwtInstance } from "@sd-jwt/core";
import { hasher } from "../../ceremony/intent-sign/presentation.js";
import { delegateKeyBinding, p256, saltGenerator, selfSignedCert, type DevKeyPair } from "../../ceremony/intent-sign/dev-wallet.js";
import { DELEGATE_KB_TYP } from "../delegate.js";
import { es256Signer } from "../sdjwt.js";
import { mandateContentDigest } from "../digest.js";
import type { Merchant } from "../types.js";
import { AgentKey } from "./agent-key.js";
import { delegateEntries, disclosureDigest, openMandatesForGrant, type MandateContent } from "../../ceremony/intent-sign/mandates.js";


export const GATE_ORIGIN = "https://shop.example";

export interface TestGrant {
  /** The agent's key pair — `K_s`, named in both open mandates' `cnf`. Raw, for the hop tests. */
  agent: DevKeyPair;
  /** The same key as the agent's own `AgentKey` — what `DelegatedIntent.spend` takes. */
  agentKey: AgentKey;
  /** The wallet's presentation, as `vp_token` carries it. */
  presentation: string;
  /** The `delegate_payload_disclosure`s the request carried: [open checkout, open payment]. */
  disclosures: [string, string];
  /** The open mandates, decoded. */
  open: [MandateContent, MandateContent];
}

export interface TestGrantOptions {
  grantId?: string;
  perSpend?: number;
  budget?: number;
  skus?: string[];
  /** Reuse a wallet (credential + holder key) across grants — the splice tests need one key. */
  wallet?: { issuer: DevKeyPair; holder: DevKeyPair; x5c: string };
  /** The wallet hop's `typ`. Default `kb+sd-jwt+kb`: its payload names the next key in `cnf`. */
  walletTyp?: string;
  /** Sign the wallet hop with a key the credential does not name. */
  forgeWalletKey?: boolean;
  /** Omit the credential's `x5c` — a root with no key to check it against. */
  omitX5c?: boolean;
  agent?: DevKeyPair;
  /** Rewrite the open mandates before the wallet signs them — e.g. drop `cnf` or `exp`. */
  mapOpen?: (m: MandateContent, i: number) => MandateContent;
  /** The open mandates' expiry, seconds from now (default 3600). */
  openTtlSec?: number;
  /** Further merchants the permission names — the portability test's second store. */
  alsoAllowed?: Merchant[];
}

/** Add merchants to both halves, then re-point `payment.reference` at the widened checkout. */
function widen(open: [MandateContent, MandateContent], extra: Merchant[]): void {
  type C = { type: string; allowed?: Merchant[]; conditional_transaction_id?: string };
  for (const c of open[0].constraints as C[]) if (c.type === "checkout.allowed_merchants") c.allowed = [...c.allowed!, ...extra];
  for (const c of open[1].constraints as C[]) {
    if (c.type === "payment.allowed_payees") c.allowed = [...c.allowed!, ...extra];
    if (c.type === "payment.reference") c.conditional_transaction_id = mandateContentDigest(open[0]);
  }
}

export async function newWallet() {
  const issuer = p256();
  return { issuer, holder: p256(), x5c: await selfSignedCert(issuer, "CredentAgent Test Wallet Issuer") };
}

/** Run a grant's ceremony in-process: what the rail's `/verify` has in hand on success. */
export async function testGrant(opts: TestGrantOptions = {}): Promise<TestGrant> {
  const wallet = opts.wallet ?? (await newWallet());
  const agent = opts.agent ?? p256();
  const grantId = opts.grantId ?? "grant-1";
  const open = openMandatesForGrant({
    bounds: { grantId, merchant: "shop", budget: opts.budget ?? 200, perSpend: opts.perSpend ?? 50 } as never,
    origin: GATE_ORIGIN,
    delegate: agent.publicJwk,
    exp: Math.floor(Date.now() / 1000) + (opts.openTtlSec ?? 3600),
    allowedSkus: opts.skus ?? ["coffee", "tea"],
  }).map((m, i) => (opts.mapOpen ? opts.mapOpen(m, i) : m)) as [MandateContent, MandateContent];
  if (opts.alsoAllowed) widen(open, opts.alsoAllowed);
  const { disclosures } = delegateEntries({ mandates: open, credentialId: "dpc", secret: "s".repeat(32), grantId });

  const iat = Math.floor(Date.now() / 1000);
  const credential = await new SDJwtInstance<Record<string, unknown>>({
    hasher,
    hashAlg: "sha-256",
    saltGenerator,
    signAlg: "ES256",
    signer: es256Signer(wallet.issuer.privateKey),
  }).issue(
    {
      iss: "https://test-wallet.local",
      vct: "com.emvco.dpc",
      iat,
      exp: iat + 3600,
      cnf: { jwk: wallet.holder.publicJwk },
      payment_instrument_id: "pi_1",
    } as never,
    { _sd: ["payment_instrument_id"] } as never,
    { header: { typ: "dc+sd-jwt", ...(opts.omitX5c ? {} : { x5c: [wallet.x5c] }) } },
  );

  const kbKey = opts.forgeWalletKey ? p256().privateKey : wallet.holder.privateKey;
  return {
    agent,
    agentKey: AgentKey.fromJwk(agent.privateKey.export({ format: "jwk" }) as never),
    presentation: delegateKeyBinding({
      presented: credential,
      holderKey: kbKey,
      aud: `origin:${GATE_ORIGIN}`,
      nonce: "ceremony-nonce",
      delegatePayload: disclosures.map((d) => ({ "...": disclosureDigest(d, "sha-256") })),
      typ: opts.walletTyp ?? DELEGATE_KB_TYP.delegable,
      iat,
    }),
    disclosures: disclosures as [string, string],
    open,
  };
}
