// Minting AP2 mandates. Configure the issuer once with the gate's key, then make
// declarative calls — the shape the DX rubric asks of every public surface here.
//
// What this file will NOT do: decide a price, decide whether a spend is in bounds, or
// decide whether a human consented. It records decisions other code already made. The
// price authority stays the catalog (security invariant 2), and putting an amount into a
// mandate never makes it true.
import type { KeyObject } from "node:crypto";
import { digestToken, sdJwtInstance, SD_HASH_ALG } from "./sdjwt.js";
import { signCompactJwt } from "./jwt.js";
import type { GateSigningKey, PublicJwkP256 } from "./keys.js";
import {
  VCT,
  type Amount,
  type CheckoutConstraint,
  type Cnf,
  type Merchant,
  type PaymentConstraint,
  type PaymentInstrument,
  type UcpCheckout,
} from "./types.js";

/** Default mandate lifetime. Short: a mandate is evidence of a moment, not a standing grant. */
export const DEFAULT_MANDATE_TTL_MS = 15 * 60 * 1000;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A minted mandate: the compact SD-JWT, plus the digest other mandates bind to. */
export interface IssuedMandate {
  /** Compact SD-JWT serialization — what travels on the wire. */
  token: string;
  /** base64url `sd_hash` of `token`. The value a sibling mandate references. */
  digest: string;
}

export interface IssuedCheckout extends IssuedMandate {
  /** The merchant-signed Checkout JWT the mandate wraps — needed to bind a payment to it. */
  checkoutJwt: string;
  /** base64url hash of `checkoutJwt`. A Payment Mandate's `transaction_id`. */
  checkoutHash: string;
}

export interface IssueCheckoutArgs {
  checkout: UcpCheckout;
  ttlMs?: number;
}

export interface IssuePaymentArgs {
  /** The Checkout Mandate's `checkoutHash` — the binding to the cart being paid for. */
  transactionId: string;
  payee: Merchant;
  amount: Amount;
  instrument: PaymentInstrument;
  /**
   * Ceremony evidence (the WebAuthn assertion, the mdoc presentation). AP2 models this as
   * risk signals collected by the trusted surface — which is exactly what it is. It is
   * NOT the mandate's signature, and nothing downstream may treat it as one.
   */
  riskData?: Record<string, unknown>;
  executionDate?: string;
  ttlMs?: number;
}

export interface IssueOpenArgs<C> {
  constraints: C[];
  /** REQUIRED by AP2 on both open mandates. The holder key that authorized this. */
  cnf: Cnf;
  /** Absolute expiry (epoch seconds). Open mandates outlive a ceremony, so callers set it. */
  exp: number;
}

export interface IssueOpenPaymentArgs extends IssueOpenArgs<PaymentConstraint> {
  payee?: Merchant;
  amount?: Amount;
  instrument?: PaymentInstrument;
}

/**
 * Mints AP2 mandates with the gate's key.
 *
 * ```ts
 * const issuer = new Ap2Issuer(key);
 * const checkout = await issuer.checkout({ checkout: ucp });
 * const payment  = await issuer.payment({ transactionId: checkout.checkoutHash, ... });
 * ```
 */
export class Ap2Issuer {
  readonly #key: GateSigningKey;

  constructor(key: GateSigningKey) {
    this.#key = key;
  }

  /** The public half — what `mount()` publishes and what a verifier imports. */
  get publicJwk(): PublicJwkP256 {
    return this.#key.publicJwk;
  }

  get issuer(): string {
    return this.#key.issuer;
  }

  async #mint(payload: Record<string, unknown>, disclosable?: string[]): Promise<IssuedMandate> {
    const sdjwt = sdJwtInstance({ privateKey: this.#key.privateKey });
    const token = await sdjwt.issue(
      { iss: this.#key.issuer, ...payload } as never,
      disclosable?.length ? ({ _sd: disclosable } as never) : undefined,
      { header: { kid: this.#key.kid } },
    );
    return { token, digest: digestToken(token, SD_HASH_ALG) };
  }

  /** `mandate.checkout.1` — "I authorize THIS checkout." */
  async checkout(args: IssueCheckoutArgs): Promise<IssuedCheckout> {
    const iat = nowSeconds();
    const checkoutJwt = signCompactJwt(args.checkout, this.#key.privateKey, this.#key.kid);
    const checkoutHash = digestToken(checkoutJwt, SD_HASH_ALG);
    // `checkout_jwt` is selectively disclosable per the AP2 schema: the digest alone proves
    // WHICH cart was authorized, so a downstream party can be told the binding without
    // being handed the line items.
    const minted = await this.#mint(
      {
        vct: VCT.checkout,
        checkout_jwt: checkoutJwt,
        checkout_hash: checkoutHash,
        iat,
        exp: iat + Math.floor((args.ttlMs ?? DEFAULT_MANDATE_TTL_MS) / 1000),
      },
      ["checkout_jwt"],
    );
    return { ...minted, checkoutJwt, checkoutHash };
  }

  /** `mandate.payment.1` — "I authorize THIS payment", bound to a checkout. */
  async payment(args: IssuePaymentArgs): Promise<IssuedMandate> {
    const iat = nowSeconds();
    return this.#mint({
      vct: VCT.payment,
      transaction_id: args.transactionId,
      payee: args.payee,
      payment_amount: args.amount,
      payment_instrument: args.instrument,
      ...(args.executionDate ? { execution_date: args.executionDate } : {}),
      ...(args.riskData ? { risk_data: args.riskData } : {}),
      iat,
      exp: iat + Math.floor((args.ttlMs ?? DEFAULT_MANDATE_TTL_MS) / 1000),
    });
  }

  /** `mandate.checkout.open.1` — "I authorize FUTURE checkouts within these constraints." */
  async openCheckout(args: IssueOpenArgs<CheckoutConstraint>): Promise<IssuedMandate> {
    assertContains(args.constraints, "checkout.line_items", "Open Checkout Mandate");
    return this.#mint({ vct: VCT.openCheckout, constraints: args.constraints, cnf: args.cnf, iat: nowSeconds(), exp: args.exp });
  }

  /** `mandate.payment.open.1` — "I authorize FUTURE payments within these constraints." */
  async openPayment(args: IssueOpenPaymentArgs): Promise<IssuedMandate> {
    assertContains(args.constraints, "payment.reference", "Open Payment Mandate");
    return this.#mint({
      vct: VCT.openPayment,
      constraints: args.constraints,
      cnf: args.cnf,
      ...(args.payee ? { payee: args.payee } : {}),
      ...(args.amount ? { payment_amount: args.amount } : {}),
      ...(args.instrument ? { payment_instrument: args.instrument } : {}),
      iat: nowSeconds(),
      exp: args.exp,
    });
  }
}

/**
 * Append a key-bound delegation hop: the holder signs a KB-JWT over the token, proving
 * possession of the key the mandate's `cnf` names.
 *
 * `nonce` and `aud` are what stop a hop being replayed somewhere else — a caller that
 * passes a constant for either has defeated the point, so neither is optional.
 */
export async function presentWithKeyBinding(args: {
  token: string;
  holderKey: KeyObject;
  aud: string;
  nonce: string;
}): Promise<string> {
  const sdjwt = sdJwtInstance({ holderKey: args.holderKey });
  return sdjwt.present(args.token, undefined, {
    kb: { payload: { iat: nowSeconds(), aud: args.aud, nonce: args.nonce } },
  });
}

function assertContains(constraints: ReadonlyArray<{ type: string }>, required: string, what: string): void {
  if (!constraints.some((c) => c.type === required)) {
    throw new Error(`${what} must contain a \`${required}\` constraint (AP2 schema \`contains\`) — refusing to mint an unbounded mandate`);
  }
}
