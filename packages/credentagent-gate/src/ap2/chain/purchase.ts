// A delegated purchase: the agent spends a permission the person signed on their phone, and the
// merchant checks it. The two halves of spec 014's flow, as two calls.
//
//   // Agent (`@openmobilehub/credentagent-gate/agent`) — keep the permission once, spend it per purchase.
//   const intent = DelegatedIntent.fromWalletPresentation(grant.mandate.intent);
//   const proof = await intent.spend({ agentKey, checkoutJwt, instrument, audience, nonce });
//
//   // Merchant — one call. `price` is your catalog: re-pricing still decides (invariant 2).
//   const verdict = await verifyDelegatedPurchase(proof, { trust: "presence-only-demo", audience, nonce, checkoutKey, spent, price });
//
// A purchase is TWO chains, one per AP2 mandate type, because the draft lets each chain disclose
// exactly one of the payloads the wallet signed: the checkout authority, and the payment authority.
// They must come from the same signature — `splice` is what refuses two permissions stapled together.
import { DEFAULT_MANDATE_TTL_MS } from "../issue.js";
import { permissionIdOf } from "../digest.js";
import { peekJson, verifyCompactJwt } from "../jwt.js";
import { digestToken, SD_HASH_ALG } from "../sdjwt.js";
import { rederiveTotal, totalOf } from "../from-gate.js";
import type { PublicJwkP256 } from "../keys.js";
import {
  VCT,
  type Amount,
  type CheckoutMandate,
  type OpenCheckoutMandate,
  type OpenPaymentMandate,
  type PaymentInstrument,
  type PaymentMandate,
  type UcpCheckout,
} from "../types.js";
import { agentPrivateKey, type AgentKey } from "./agent-key.js";
import { appendAgentHop } from "./hop.js";
import { walletChain } from "./serialize.js";
import { evaluateCheckout, evaluatePayment, merchantMatches, type Spent, type Violation } from "./constraints.js";
import { verifyChain, type ChainRefusalCode } from "./verify.js";

/** What the agent hands the merchant: one chain per mandate type. */
export interface DelegatedPurchaseProof {
  checkout: string;
  payment: string;
}

/** An array-element disclosure `[salt, value]`'s value, when it is an object. */
const decodeDisclosure = (d: string): Record<string, unknown> | undefined => {
  const arr = peekJson<unknown[]>(d);
  return Array.isArray(arr) && arr.length === 2 && typeof arr[1] === "object" ? (arr[1] as Record<string, unknown>) : undefined;
};

/**
 * The permission an agent holds: the wallet's presentation and the two open mandates it signed.
 * Plain data — `JSON.stringify` it to store it, {@link DelegatedIntent.fromJSON} to bring it back.
 *
 * Holding it is not a secret in itself: spending it needs the {@link AgentKey} its mandates name,
 * which this object never sees until `spend` is called with it.
 */
export class DelegatedIntent {
  readonly presentation: string;
  readonly disclosures: { checkout: string; payment: string };

  private constructor(presentation: string, disclosures: { checkout: string; payment: string }) {
    this.presentation = presentation;
    this.disclosures = disclosures;
  }

  /** From what the intent-sign rail holds after the ceremony: `vp_token` and the request's disclosures. */
  static fromWalletPresentation(args: { presentation: string; disclosures: readonly string[] }): DelegatedIntent {
    const byVct = (vct: string) => args.disclosures.find((d) => decodeDisclosure(d)?.vct === vct);
    const checkout = byVct(VCT.openCheckout);
    const payment = byVct(VCT.openPayment);
    if (!checkout || !payment) throw new Error("a delegated intent needs both an open checkout and an open payment mandate");
    return new DelegatedIntent(args.presentation, { checkout, payment });
  }

  static fromJSON(json: { presentation: string; disclosures: { checkout: string; payment: string } }): DelegatedIntent {
    return DelegatedIntent.fromWalletPresentation({
      presentation: json.presentation,
      disclosures: [json.disclosures.checkout, json.disclosures.payment],
    });
  }

  /** The open payment mandate — what the agent may spend. UNVERIFIED: read it to plan, not to decide. */
  get openPayment(): OpenPaymentMandate {
    return decodeDisclosure(this.disclosures.payment) as unknown as OpenPaymentMandate;
  }

  /** The open checkout mandate — what the agent may buy. UNVERIFIED, like `openPayment`. */
  get openCheckout(): OpenCheckoutMandate {
    return decodeDisclosure(this.disclosures.checkout) as unknown as OpenCheckoutMandate;
  }

  /** This permission's id — the same one a merchant's verdict reports as `permissionId`. */
  get permissionId(): string {
    return permissionIdOf(this.presentation.slice(this.presentation.lastIndexOf("~") + 1));
  }

  /**
   * Spend the permission on ONE purchase: sign a closed checkout mandate naming the merchant's
   * checkout, and a closed payment mandate bound to it, each as the agent's hop on its chain.
   *
   * The payee and the amount are the cart's own — its merchant and its total — so the agent names
   * only how it pays. `audience` and `nonce` are the merchant's. They are what keep this proof from
   * being replayed at another store, or twice at this one.
   */
  async spend(args: {
    /** The key the permission names in `cnf` — the agent's own, from `AgentKey`. */
    agentKey: AgentKey;
    /** The merchant-signed UCP Checkout (`Ap2Issuer.signCheckout`). */
    checkoutJwt: string;
    /** How the agent pays — the one fact of the payment the cart does not already state. */
    instrument: PaymentInstrument;
    audience: string;
    nonce: string;
    ttlMs?: number;
  }): Promise<DelegatedPurchaseProof> {
    // Said here, plainly, rather than as a `signature` refusal at the merchant: a permission
    // signed for one agent key is spendable by that key alone.
    for (const open of [this.openCheckout, this.openPayment]) {
      if (!args.agentKey.matches(open?.cnf?.jwk))
        throw new Error(
          "this permission names a different agent key — spend it with the AgentKey whose publicJwk the grant was created with",
        );
    }
    // Read, not verified: the agent spends against the cart it was quoted, and the merchant checks
    // its own signature on it. A cart that does not decode cannot be paid for.
    const cart = peekJson<UcpCheckout>(args.checkoutJwt.split(".")[1]);
    const problem = cart ? cartProblem(cart) : "it does not decode";
    if (!cart || problem)
      throw new Error(`checkoutJwt is not a UCP Checkout: ${problem} — pass the cart exactly as the merchant signed it`);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + Math.floor((args.ttlMs ?? DEFAULT_MANDATE_TTL_MS) / 1000);
    const checkoutHash = digestToken(args.checkoutJwt, SD_HASH_ALG);
    const closedCheckout: CheckoutMandate = { vct: VCT.checkout, checkout_jwt: args.checkoutJwt, checkout_hash: checkoutHash, iat, exp };
    const closedPayment: PaymentMandate = {
      vct: VCT.payment,
      transaction_id: checkoutHash,
      payee: cart.merchant!, // cartProblem refuses a cart with no merchant
      payment_amount: totalOf(cart),
      payment_instrument: args.instrument,
      iat,
      exp,
    };
    const hop = (disclosure: string, content: object) => {
      const chain = walletChain(this.presentation, disclosure);
      if (!chain) throw new Error("the presentation ends in no wallet key binding — there is no signed permission to spend");
      return appendAgentHop({
        chain,
        agentKey: agentPrivateKey(args.agentKey),
        content: content as Record<string, unknown>,
        audience: args.audience,
        nonce: args.nonce,
      });
    };
    return { checkout: await hop(this.disclosures.checkout, closedCheckout), payment: await hop(this.disclosures.payment, closedPayment) };
  }
}

export type PurchaseRefusalCode =
  | ChainRefusalCode
  | "trust" // the caller did not opt in to presence-only trust — the only kind this verifier has
  | "splice" // the two chains do not rest on the same signed permission
  | "unexpected-type" // a chain carries the other mandate type
  | "checkout-unbound" // the checkout is not this merchant's, or its hash does not match
  | "payment-unbound" // the payment's transaction_id names a different checkout
  | "payee" // the payment pays someone other than the merchant whose checkout it is
  | "constraint" // the purchase leaves the permission's limits (see `violations`)
  | "amount" // the payment does not pay the checkout's total, or the total does not add up
  | "price"; // the catalog prices the cart differently (invariant 2)

export interface PurchaseRefusal {
  ok: false;
  code: PurchaseRefusalCode;
  detail: string;
  /** Present for `constraint`: every limit the purchase broke. */
  violations?: Violation[];
}

export interface PurchaseVerdict {
  ok: true;
  /**
   * This permission's stable id — the same for every purchase under it, at every merchant. Key what
   * you record as spent on it; `spent` is called with it.
   */
  permissionId: string;
  checkout: UcpCheckout;
  payment: PaymentMandate;
  open: { checkout: OpenCheckoutMandate; payment: OpenPaymentMandate };
  /** No issuer trust anchor yet (#14): the credential's certificate is self-minted. */
  trust_level: "presence-only-demo";
}

export interface VerifyPurchaseOptions {
  /**
   * REQUIRED, and the only value there is: `"presence-only-demo"`.
   *
   * The credential at the root of the chain is checked against the certificate it carries itself,
   * and nothing anchors that certificate to a real issuer yet (#14). So an agent can mint its own
   * "permission", with any limits it likes, and it verifies. The limits are enforced; nothing proves
   * a person set them. Saying so here is the opt-in — demo use only, never a real safety control.
   */
  trust: "presence-only-demo";
  /** This merchant — who the agent's hops must be addressed to. */
  audience: string;
  /** The nonce this merchant issued for this purchase. Consuming it is yours (invariant 6). */
  nonce: string;
  /** The key that signed the checkout — this merchant's (`credentagent.ap2.checkoutPublicJwk`). */
  checkoutKey: PublicJwkP256;
  /**
   * What THIS merchant already spent under the permission. Required by budget / recurrence limits.
   *
   * Pass a function and it is called with the VERIFIED `permissionId`, after the chains check out —
   * so you look your ledger up by an id the signatures vouch for, never by bytes read from an
   * unverified token. A budget holds per merchant: one permission works at every store it names,
   * and each store sees only its own spending.
   */
  spent?: Spent | ((permissionId: string) => Spent | Promise<Spent>);
  /** Your catalog's total for this cart, in minor units. The price authority — never the proof. */
  price: (checkout: UcpCheckout) => number | Promise<number>;
  nowMs?: number;
}

const refuse = (code: PurchaseRefusalCode, detail: string, violations?: Violation[]): PurchaseRefusal => ({
  ok: false,
  code,
  detail,
  ...(violations ? { violations } : {}),
});

/**
 * Verify a delegated purchase. Fail-closed: every chain link, both chains resting on the same
 * permission, the checkout being this merchant's, the payment paying exactly that checkout, every
 * limit the person set, and the catalog's own price.
 */
export async function verifyDelegatedPurchase(
  proof: DelegatedPurchaseProof,
  opts: VerifyPurchaseOptions,
): Promise<PurchaseVerdict | PurchaseRefusal> {
  // Checked at runtime too: a JavaScript caller, or one casting past the type, gets a refusal — not
  // a verdict whose trust nobody asked for.
  if (!proof || typeof proof !== "object" || typeof proof.checkout !== "string" || typeof proof.payment !== "string") {
    return refuse("malformed", "a delegated purchase proof is { checkout: string, payment: string }");
  }
  if (opts.trust !== "presence-only-demo") {
    return refuse(
      "trust",
      'pass trust: "presence-only-demo" — the credential is checked against its own certificate, so this verifies presence, not that a person set these limits (#14)',
    );
  }
  if (!opts.checkoutKey)
    return refuse("checkout-unbound", "no checkout key configured — there is nothing to check the cart's signature against");
  const chainOpts = { audience: opts.audience, nonce: opts.nonce, ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}) };
  const c = await verifyChain(proof.checkout, chainOpts);
  if (!c.ok) return refuse(c.code, `checkout chain: ${c.detail}`);
  const p = await verifyChain(proof.payment, chainOpts);
  if (!p.ok) return refuse(p.code, `payment chain: ${p.detail}`);

  // ONE permission: the same credential and the same wallet signature under both chains. Without
  // this, a strict checkout authority could be paired with a generous payment authority from
  // another grant — every signature genuine, the combination never signed.
  if (c.links[0].jwt !== p.links[0].jwt || c.links[1].jwt !== p.links[1].jwt) {
    return refuse("splice", "the checkout and payment chains rest on different wallet signatures");
  }
  const permissionId = permissionIdOf(c.links[1].jwt);
  if (c.open.vct !== VCT.openCheckout || c.closed.vct !== VCT.checkout)
    return refuse("unexpected-type", "the checkout chain does not carry checkout mandates");
  if (p.open.vct !== VCT.openPayment || p.closed.vct !== VCT.payment)
    return refuse("unexpected-type", "the payment chain does not carry payment mandates");
  const openCheckout = c.open as unknown as OpenCheckoutMandate;
  const closedCheckout = c.closed as unknown as CheckoutMandate;
  const openPayment = p.open as unknown as OpenPaymentMandate;
  const payment = p.closed as unknown as PaymentMandate;

  // The cart: signed by this merchant, and the one the closed mandate's hash names.
  if (!closedCheckout.checkout_jwt || digestToken(closedCheckout.checkout_jwt, SD_HASH_ALG) !== closedCheckout.checkout_hash) {
    return refuse("checkout-unbound", "checkout_jwt does not hash to checkout_hash");
  }
  const checkout = verifyCompactJwt<UcpCheckout>(closedCheckout.checkout_jwt, opts.checkoutKey);
  if (!checkout) return refuse("checkout-unbound", "the checkout is not signed by this merchant's key");
  // Signed is not well-formed: a cart or a payment missing a field is refused, never read.
  const shape = cartProblem(checkout) ?? paymentProblem(payment);
  if (shape) return refuse("malformed", shape);
  if (payment.transaction_id !== closedCheckout.checkout_hash)
    return refuse("payment-unbound", "the payment's transaction_id names a different checkout");
  // The payee is the merchant that signed the cart. A permission naming several stores lets each
  // be paid — but only for its OWN checkout, never for another's.
  if (!merchantMatches(payment.payee, checkout.merchant)) {
    return refuse("payee", `the payment pays ${payment.payee?.id ?? "∅"}, not ${checkout.merchant?.id ?? "∅"} whose checkout it is`);
  }

  const spent = typeof opts.spent === "function" ? await opts.spent(permissionId) : opts.spent;
  // The ledger is the caller's, so it is checked like any input: `undefined + 450` is NaN, and
  // `NaN > max` is false — a ledger that answered `{}` would pass every budget.
  if (spent !== undefined && !(isCount(spent?.amount) && isCount(spent?.uses))) {
    return refuse(
      "malformed",
      "spent must be { amount, uses } as non-negative integers — what this store already spent under the permission",
    );
  }
  const violations = [
    ...evaluateCheckout(openCheckout, checkout),
    ...evaluatePayment(openPayment, payment, {
      openCheckout,
      ...(spent ? { spent } : {}),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    }),
  ];
  if (violations.length) {
    const code = violations.some((v) => v.code === "malformed") ? "malformed" : "constraint";
    return refuse(code, violations.map((v) => `${v.constraint ?? v.code}: ${v.detail}`).join("; "), violations);
  }

  // Invariant 3: the total adds up from its parts, and the payment pays exactly it.
  let total: Amount;
  try {
    total = totalOf(checkout);
    if (rederiveTotal(checkout).amount !== total.amount) return refuse("amount", "the checkout's total does not add up from its lines");
  } catch (err) {
    return refuse("amount", (err as Error).message);
  }
  if (payment.payment_amount.amount !== total.amount || payment.payment_amount.currency !== total.currency) {
    return refuse(
      "amount",
      `payment ${payment.payment_amount.amount} ${payment.payment_amount.currency} does not pay the total ${total.amount} ${total.currency}`,
    );
  }
  // Invariant 2: the catalog decides, however perfect the signatures.
  const priced = await opts.price(checkout);
  if (priced !== total.amount) return refuse("price", `the catalog prices this cart at ${priced}, the checkout says ${total.amount}`);

  return {
    ok: true,
    permissionId,
    checkout,
    payment,
    open: { checkout: openCheckout, payment: openPayment },
    trust_level: "presence-only-demo",
  };
}

const isCount = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

/** What a cart needs before anything reads it: a merchant, and lines with an item id and a count. */
function cartProblem(cart: UcpCheckout): string | undefined {
  if (!cart || typeof cart !== "object") return "the checkout is not an object";
  if (!cart.merchant || typeof cart.merchant !== "object") return "the checkout names no merchant";
  if (!Array.isArray(cart.line_items) || !Array.isArray(cart.totals)) return "the checkout has no line_items or totals list";
  for (const line of cart.line_items) {
    if (!line?.item || typeof line.item.id !== "string" || !Number.isSafeInteger(line.quantity))
      return "a checkout line has no item id or no integer quantity";
  }
  return undefined;
}

/** What a closed payment needs before anything reads it: an integer amount in a named currency. */
function paymentProblem(payment: PaymentMandate): string | undefined {
  const amount = payment.payment_amount;
  if (!amount || !Number.isSafeInteger(amount.amount) || typeof amount.currency !== "string")
    return "the payment has no integer payment_amount in a named currency";
  return undefined;
}
