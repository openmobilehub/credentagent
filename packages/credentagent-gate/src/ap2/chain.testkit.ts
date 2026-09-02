// Test-only helpers for minting AP2 chains. NOT part of the published surface: nothing in
// the shipped graph imports this, and it is absent from tsconfig's `include`, so it never
// reaches `dist`.
//
// It exists so the rail tests can express "a well-formed chain for THIS order" in one line
// and spend their assertions on the control being pinned, not on ceremony setup.
import { Ap2Issuer, presentWithKeyBinding } from "./issue.js";
import { resolveSigningKey, type GateSigningKey } from "./keys.js";
import { checkoutFromOrder, merchantFor } from "./from-gate.js";
import { amountFrom } from "./money.js";
import { digestToken } from "./sdjwt.js";
import type { MandateChain } from "./chain.js";
import type { CeremonyOrder } from "../ceremony/types.js";
import type { UcpCheckout } from "./types.js";

export interface TestIssuer {
  key: GateSigningKey;
  ap2: Ap2Issuer;
  origin: string;
}

/** One issuer for a test file. Reuse it: chains signed by DIFFERENT keys fail at the
 *  signature, which would let a binding test pass without its binding ever being checked. */
export async function testIssuer(origin = "https://shop.example"): Promise<TestIssuer> {
  const key = await resolveSigningKey(origin);
  return { key, ap2: new Ap2Issuer(key), origin };
}

export interface MintChainOptions {
  /** Override the amount the payment mandate is signed for (to test amount binding). */
  payAmount?: number;
  /** Mutate the UCP checkout after it is built but before it is signed (to test tampering). */
  mutate?: (checkout: UcpCheckout) => UcpCheckout;
  ttlMs?: number;
}

/** A signed Checkout + Payment chain for one order. */
export async function mintChain(
  t: TestIssuer,
  order: CeremonyOrder,
  opts: MintChainOptions = {},
): Promise<MandateChain & { checkoutHash: string }> {
  const built = checkoutFromOrder(order, merchantFor(t.origin, "Test Shop"));
  const checkout = opts.mutate ? opts.mutate(built) : built;
  const co = await t.ap2.checkout({ checkout, ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}) });
  const pay = await t.ap2.payment({
    transactionId: co.checkoutHash,
    payee: merchantFor(t.origin, "Test Shop"),
    amount: amountFrom(opts.payAmount ?? order.total, order.currency),
    instrument: { type: "card", network: "visa" },
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
  });
  return { checkout: co.token, payment: pay.token, checkoutHash: co.checkoutHash };
}

/** A holder keypair standing in for a wallet, for the key-bound "open" mandates. */
export async function testHolder() {
  const { webcrypto } = await import("node:crypto");
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, cnf: { jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x!, y: jwk.y! } } };
}

/** Attach a grant's two key-bound "open" mandates to a chain. */
export async function withGrant(
  t: TestIssuer,
  chain: MandateChain,
  grant: { skus: string[]; perSpendMinor: number; budgetMinor: number; currency?: string },
  holder: Awaited<ReturnType<typeof testHolder>>,
  nonce = "test-nonce",
): Promise<MandateChain> {
  const currency = (grant.currency ?? "USD").toUpperCase();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const openCo = await t.ap2.openCheckout({
    constraints: [
      { type: "checkout.allowed_merchants", allowed: [merchantFor(t.origin, "Test Shop")] },
      { type: "checkout.line_items", allowed: grant.skus },
    ],
    cnf: holder.cnf,
    exp,
  });
  const openCoPresented = await presentWithKeyBinding({ token: openCo.token, holderKey: holder.privateKey, aud: t.origin, nonce });
  const openPay = await t.ap2.openPayment({
    constraints: [
      { type: "payment.reference", conditional_transaction_id: digestToken(openCoPresented) },
      { type: "payment.amount_range", currency, max: grant.perSpendMinor },
      { type: "payment.budget", currency, max: grant.budgetMinor },
    ],
    cnf: holder.cnf,
    exp,
  });
  const openPayPresented = await presentWithKeyBinding({ token: openPay.token, holderKey: holder.privateKey, aud: t.origin, nonce });
  return { ...chain, openCheckout: openCoPresented, openPayment: openPayPresented };
}
