// Single source of truth for the OpenID4VP transaction_data entry (amount binding).
// Extracted from the demo's payment-gate/dc-payment/txData.ts, but DEPENDENCY-FREE:
// `jose.base64url.encode` becomes a Buffer base64url and the SHA-256 stays on
// node:crypto. Amount + payee come from the order + origin via the shared
// `buildBindingFields`, so the hash the wallet would sign is derived from the SAME
// fields Gate 1 (verify.ts#runDcGates) re-checks. The wallet's SIGNATURE over this
// hash is the PR-in-flight crypto (request.ts scaffolds the signed request); the
// binding itself is real here.
import { createHash, randomUUID } from "node:crypto";
import { buildBindingFields } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";

export interface TransactionData {
  type: "urn:eudi:sca:payment:1";
  credential_ids: string[];
  payload: {
    transaction_id: string;
    amount: number;
    currency: string;
    payee: { id: string; name: string };
  };
}

export function buildTransactionData(order: CeremonyOrder, origin: Origin): TransactionData {
  const b = buildBindingFields(order, origin);
  return {
    type: "urn:eudi:sca:payment:1",
    credential_ids: ["dpc"],
    payload: {
      transaction_id: randomUUID(),
      amount: b.amount,
      currency: b.currency,
      payee: b.payee,
    },
  };
}

export function encodeTransactionData(txData: TransactionData): string {
  return Buffer.from(JSON.stringify(txData), "utf8").toString("base64url");
}

// SHA-256 of the base64url transaction_data string, itself base64url. This is the
// value the wallet signs over (transaction_data_hash) and Gate 1 re-derives.
export function hashTransactionData(txDataB64: string): string {
  return createHash("sha256").update(txDataB64).digest("base64url");
}

export function decodeTransactionData(txDataB64: string): TransactionData {
  return JSON.parse(Buffer.from(txDataB64, "base64url").toString("utf8")) as TransactionData;
}
