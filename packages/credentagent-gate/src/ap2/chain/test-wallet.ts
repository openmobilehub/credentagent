// TEST UTILITY — a wallet and a grant, in-process, for the chain tests. Not exported from the
// package and not compiled into `dist/` (nothing the package entry imports reaches it).
//
// It produces exactly what the intent-sign rail hands a gate after a real ceremony: the
// wallet's presentation `<credential>~<disclosures>~<KB-SD-JWT>` and the `delegate` disclosures
// the request carried, built by the rail's own `openMandatesForGrant` / `delegateEntries` — so
// the chain is tested against the bytes the rail actually produces, not a shape invented here.
//
// The `override*` knobs each produce something a correct chain verifier MUST refuse.
import { generateKeyPairSync, webcrypto, type KeyObject } from "node:crypto";
import { es256Signer } from "../sdjwt.js";
import * as x509 from "@peculiar/x509";
import { SDJwtInstance } from "@sd-jwt/core";
import { hasher } from "../../ceremony/intent-sign/presentation.js";
import { mandateContentDigest } from "./constraints.js";
import type { Merchant } from "../types.js";
import { delegateEntries, disclosureDigest, openMandatesForGrant, type MandateContent } from "../../ceremony/intent-sign/mandates.js";

const b64uJson = (v: unknown) => Buffer.from(JSON.stringify(v), "utf-8").toString("base64url");
const saltGenerator = (n: number) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex").slice(0, n);
/** The package's own ES256 signer, so the test wallet signs exactly as the gate verifies. */
export const sign = (key: KeyObject) => es256Signer(key);

export function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" }) as { kty: "EC"; crv: "P-256"; x: string; y: string };
  return { privateKey, publicJwk: { kty, crv, x, y } };
}

export type P256 = ReturnType<typeof p256>;

async function selfSignedCert(key: P256): Promise<string> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const priv = await webcrypto.subtle.importKey("jwk", key.privateKey.export({ format: "jwk" }) as webcrypto.JsonWebKey, alg, false, ["sign"]);
  const pub = await webcrypto.subtle.importKey("jwk", { ...key.publicJwk, ext: true } as webcrypto.JsonWebKey, alg, true, ["verify"]);
  const notBefore = new Date(Date.now() - 60_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=CredentAgent Test Wallet Issuer",
      notBefore,
      notAfter: new Date(notBefore.getTime() + 86_400_000),
      signingAlgorithm: alg,
      keys: { privateKey: priv, publicKey: pub },
    },
    webcrypto as unknown as Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[1],
  );
  return Buffer.from(cert.rawData).toString("base64");
}

export const GATE_ORIGIN = "https://shop.example";

export interface TestGrant {
  /** The agent's key pair — `K_s`, named in both open mandates' `cnf`. */
  agent: P256;
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
  wallet?: { issuer: P256; holder: P256; x5c: string };
  /** The wallet hop's `typ`. Default `kb+sd-jwt+kb`: its payload names the next key in `cnf`. */
  walletTyp?: string;
  /** Sign the wallet hop with a key the credential does not name. */
  forgeWalletKey?: boolean;
  /** Omit the credential's `x5c` — a root with no key to check it against. */
  omitX5c?: boolean;
  agent?: P256;
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
  return { issuer, holder: p256(), x5c: await selfSignedCert(issuer) };
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
    signer: sign(wallet.issuer.privateKey),
  }).issue(
    { iss: "https://test-wallet.local", vct: "com.emvco.dpc", iat, exp: iat + 3600, cnf: { jwk: wallet.holder.publicJwk }, payment_instrument_id: "pi_1" } as never,
    { _sd: ["payment_instrument_id"] } as never,
    { header: { typ: "dc+sd-jwt", ...(opts.omitX5c ? {} : { x5c: [wallet.x5c] }) } },
  );

  const sdHash = Buffer.from(hasher(credential, "sha-256")).toString("base64url");
  const kbHeader = { alg: "ES256", typ: opts.walletTyp ?? "kb+sd-jwt+kb" };
  const kbPayload = {
    iat,
    aud: `origin:${GATE_ORIGIN}`,
    nonce: "ceremony-nonce",
    sd_hash: sdHash,
    delegate_payload: disclosures.map((d) => ({ "...": disclosureDigest(d, "sha-256") })),
  };
  const input = `${b64uJson(kbHeader)}.${b64uJson(kbPayload)}`;
  const kbKey = opts.forgeWalletKey ? p256().privateKey : wallet.holder.privateKey;
  return {
    agent,
    presentation: `${credential}${input}.${sign(kbKey)(input)}`,
    disclosures: disclosures as [string, string],
    open,
  };
}
