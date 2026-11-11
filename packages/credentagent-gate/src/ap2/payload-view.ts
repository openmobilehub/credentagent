// The AP2 payload of one delegated purchase, decoded for a person to read — demo-only.
//
// It shows the four mandates and NOTHING else: the open Checkout and open Payment mandates the
// wallet signed, and the closed Checkout and Payment mandates the agent signed. It never renders the
// credential at the root of the chain or any claim outside the mandates, so a reviewer can see that
// AP2 reached the server without the page disclosing the wallet's data.
//
// It DECODES, it does not verify: only a purchase `verifyDelegatedPurchase` accepted is ever recorded
// with this payload, and the `trustLevel` it carries is that verdict's — never a stronger one.
import { peekJson } from "./jwt.js";
import { splitChain } from "./chain/serialize.js";
import { VCT } from "./types.js";
import type { DelegatedPurchaseProof } from "./chain/purchase.js";

/** What the store keeps with a delegated order: the agent's proof and the open mandates it spent. */
export interface Ap2PayloadSource {
  proof: DelegatedPurchaseProof;
  intentMandates: Array<Record<string, unknown>>;
  trustLevel: string;
}

export interface Ap2PayloadView {
  trustLevel: string;
  /** Signed by the person's wallet: what the agent MAY do. */
  intent: { checkout: Record<string, unknown>; payment: Record<string, unknown> };
  /** Signed by the agent: this cart, and the payment for exactly it. */
  checkout: Record<string, unknown>;
  payment: Record<string, unknown>;
}

/** The mandate an agent hop discloses: the last link's single `[salt, content]` array disclosure. */
function closedMandate(chain: string): Record<string, unknown> {
  const last = splitChain(chain)?.at(-1);
  for (const d of last?.disclosures ?? []) {
    const arr = peekJson<unknown[]>(d);
    if (Array.isArray(arr) && arr.length === 2 && arr[1] && typeof arr[1] === "object") return arr[1] as Record<string, unknown>;
  }
  throw new Error("not an AP2 delegated purchase chain: no closed mandate was disclosed");
}

function openMandate(mandates: Array<Record<string, unknown>>, vct: string): Record<string, unknown> {
  const found = mandates.find((m) => m.vct === vct);
  if (!found) throw new Error(`the permission carries no ${vct} mandate`);
  return found;
}

export function ap2PayloadView(src: Ap2PayloadSource): Ap2PayloadView {
  return {
    trustLevel: src.trustLevel,
    intent: { checkout: openMandate(src.intentMandates, VCT.openCheckout), payment: openMandate(src.intentMandates, VCT.openPayment) },
    checkout: closedMandate(src.proof.checkout),
    payment: closedMandate(src.proof.payment),
  };
}
