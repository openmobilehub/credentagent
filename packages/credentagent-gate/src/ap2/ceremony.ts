// Minting a mandate chain for a HUMAN-PRESENT ceremony, and re-deriving the deterministic
// gates from it.
//
// This is what replaced `buildPasskeyMandate`'s `MOCK-DEV-SIGNER` — a SHA-256 digest of the
// payload with a note attached saying it was a mock. The ceremony evidence (the WebAuthn
// assertion, the mdoc presentation) does not become the signature here either; it rides as
// AP2 `risk_data`, which is what it honestly is: a signal the trusted surface collected. The
// mandate is signed by the gate's ES256 key, and that fact is checkable by anyone who reads
// the DID document.
import { Ap2Issuer } from "./issue.js";
import { checkoutFromOrder, merchantFor, rederiveTotal, totalOf } from "./from-gate.js";
import { amountFrom, amountsEqual, formatAmount } from "./money.js";
import type { MandateChain } from "./chain.js";
import type { CeremonyOrder, GateOutcome } from "../ceremony/types.js";
import type { Amount, PaymentInstrument } from "./types.js";

/** What the ceremony proved, recorded on the mandate as AP2 risk signals. */
export interface CeremonyEvidence {
  /** e.g. "webauthn.assertion" | "openid4vp.mdoc". */
  type: string;
  [signal: string]: unknown;
}

export interface CeremonyChain {
  chain: MandateChain;
  /** The amount the chain authorizes, re-derived from the cart's own parts. */
  amount: Amount;
  /** The Payment Mandate's id for the completion record — its `transaction_id`. */
  mandateId: string;
}

/**
 * Issue the Checkout + Payment pair for a completed ceremony.
 *
 * `order` must already be the RE-PRICED order (invariant 2). This function signs what it is
 * given; it is not a second chance to get the price right.
 */
export async function issueCeremonyChain(args: {
  issuer: Ap2Issuer;
  order: CeremonyOrder;
  origin: string;
  merchantName?: string;
  evidence: CeremonyEvidence;
  instrument?: PaymentInstrument;
}): Promise<CeremonyChain> {
  const payee = merchantFor(args.origin, args.merchantName);
  const checkout = checkoutFromOrder(args.order, payee);
  const co = await args.issuer.checkout({ checkout });
  const amount = amountFrom(args.order.total, args.order.currency);
  const pay = await args.issuer.payment({
    transactionId: co.checkoutHash,
    payee,
    amount,
    instrument: args.instrument ?? { type: "card" },
    riskData: { ceremony: args.evidence.type, ...args.evidence },
  });
  return { chain: { checkout: co.token, payment: pay.token }, amount, mandateId: co.checkoutHash };
}

/**
 * Mint the chain that CARRIES an order, before any ceremony has happened.
 *
 * The transport case, and it exists because the example needed it: minting through
 * {@link issueCeremonyChain} would have forced a caller with nothing to attest to invent an
 * `evidence` object, which is the API lying about what it knows. Same signed pair, no
 * pretend ceremony — the Payment Mandate here states the catalog total and carries no
 * `risk_data`, because nobody has authorized anything yet.
 */
export async function issueOrderChain(args: {
  issuer: Ap2Issuer;
  order: CeremonyOrder;
  origin: string;
  merchantName?: string;
  ttlMs?: number;
}): Promise<CeremonyChain> {
  const payee = merchantFor(args.origin, args.merchantName);
  const co = await args.issuer.checkout({
    checkout: checkoutFromOrder(args.order, payee),
    ...(args.ttlMs ? { ttlMs: args.ttlMs } : {}),
  });
  const amount = amountFrom(args.order.total, args.order.currency);
  const pay = await args.issuer.payment({
    transactionId: co.checkoutHash,
    payee,
    amount,
    instrument: { type: "unspecified" },
    ...(args.ttlMs ? { ttlMs: args.ttlMs } : {}),
  });
  return { chain: { checkout: co.token, payment: pay.token }, amount, mandateId: co.checkoutHash };
}

/**
 * The deterministic gates, re-derived from the order and the ceremony evidence.
 *
 * Every one re-computes from inputs rather than reading a `verified` flag — the rule the old
 * `runGates` established and the reason it is worth keeping. What changed is the arithmetic:
 * it is integer minor units now, so "the lines add up to the total" is an exact comparison
 * instead of a float one.
 */
export function runCeremonyGates(order: CeremonyOrder, evidence: CeremonyEvidence, signed: Amount): GateOutcome[] {
  const checkout = checkoutFromOrder(order, merchantFor("https://gate.invalid"));
  const stated = totalOf(checkout);
  const rederived = rederiveTotal(checkout);

  const amountOk = amountsEqual(stated, rederived) && amountsEqual(signed, rederived);
  const credentialId = typeof evidence.credentialID === "string" ? evidence.credentialID : "";
  const subject = typeof evidence.subject === "string" ? evidence.subject : credentialId;

  return [
    {
      gate: "Amount integrity",
      pass: amountOk,
      // Minor units, on purpose: this line is read when an amount dispute happens, and a
      // rounded decimal is exactly the wrong thing to be looking at then.
      detail: `lines−discount=${formatAmount(rederived)} · cart.total=${formatAmount(stated)} · signed=${formatAmount(signed)}`,
    },
    {
      gate: "Authorization present",
      pass: Boolean(evidence.type) && credentialId.length > 0,
      detail: `type=${evidence.type} · credentialID=${credentialId || "∅"}`,
    },
    {
      gate: "User verification",
      pass: evidence.userVerified === true,
      detail: `userVerified=${String(evidence.userVerified)} · hardwareBacked=${String(evidence.hardwareBacked)}`,
    },
    {
      gate: "Subject binding",
      pass: subject.length > 0 && subject === credentialId,
      detail: `subject=${subject || "∅"} · auth=${credentialId || "∅"}`,
    },
  ];
}
