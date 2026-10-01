// Single source of truth for the OpenID4VP transaction_data entry (amount binding).
// Extracted from the demo's payment-gate/dc-payment/txData.ts, but DEPENDENCY-FREE:
// `jose.base64url.encode` becomes a Buffer base64url and the hash stays on
// node:crypto. Amount + payee come from the order + origin via the shared
// `buildBindingFields`, so the hash the wallet would sign is derived from the SAME
// fields Gate 1 (verify.ts#runDcGates) re-checks. The wallet's SIGNATURE over this
// hash is the PR-in-flight crypto (request.ts scaffolds the signed request); the
// binding itself is real here.
//
// SCHEMA: this shape mirrors Multipaz's registered `urn:eudi:sca:payment:1` type,
// `PaymentTransaction` (multipaz-doctypes, github.com/openwallet-foundation/multipaz):
// the envelope is its `JsonData` (`type` / `credential_ids` / `transaction_data_hashes_alg`
// / `payload`) and `payload` is its `Payload`. Multipaz serializes with
// `JsonNamingStrategy.SnakeCase`, so the wire is snake_case (`transaction_id`, NOT
// `transactionId`) — matching Multipaz's own `PaymentTransaction.sampleData`
// `{ transaction_id, amount, currency, payee: { id, name } }`. Its decoder does not
// set `ignoreUnknownKeys`, so an extra/renamed key is HARD-REJECTED — keep these names.
import { createHash, randomUUID } from "node:crypto";
import { buildBindingFields } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";

// The hash algorithm we ask the wallet to bind the transaction_data with. This is the
// JOSE identifier Multipaz maps via `Algorithm.fromHashAlgorithmIdentifier` ("sha-256"
// → SHA-256). Declaring it makes the algorithm a stated contract instead of relying on
// Multipaz's implicit SHA-256 default (mdocPresentment.kt: when the request omits the
// list, the wallet uses SHA-256 and omits transaction_data_hash_alg from the response).
const REQUESTED_TX_HASH_JOSE_ALG = "sha-256";

/** node:crypto hash names for the SHA-2 algorithms Multipaz can answer with. */
export type TxHashName = "sha256" | "sha384" | "sha512";

// COSE hash-algorithm ids the wallet reports in `transaction_data_hash_alg`, mapped to
// the node:crypto name. Source: org.multipaz.crypto.Algorithm — SHA256=-16, SHA384=-43,
// SHA512=-44 (github.com/openwallet-foundation/multipaz).
const COSE_HASH_ALG: Record<number, TxHashName> = { [-16]: "sha256", [-43]: "sha384", [-44]: "sha512" };

/**
 * Resolve the node:crypto hash name from the COSE id the wallet reported. A MISSING id
 * (null/undefined) means Multipaz used its SHA-256 default (see above), so it maps to
 * "sha256"; a PRESENT-but-unrecognized id maps to `null` so verify can fail closed
 * rather than silently assume SHA-256.
 */
export function txHashNameFromCose(coseAlg: number | null | undefined): TxHashName | null {
  if (coseAlg == null) return "sha256";
  return COSE_HASH_ALG[coseAlg] ?? null;
}

export interface TransactionData {
  type: "urn:eudi:sca:payment:1";
  credential_ids: string[];
  /** JOSE hash-alg identifiers we accept the wallet binding with (Multipaz `JsonData.transactionDataHashesAlg`). */
  transaction_data_hashes_alg: string[];
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
    transaction_data_hashes_alg: [REQUESTED_TX_HASH_JOSE_ALG],
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

// Hash of the base64url transaction_data string, itself base64url. This is the value
// the wallet signs over (transaction_data_hash) and Gate 1 re-derives. `alg` honors the
// wallet's reported transaction_data_hash_alg (defaults to the SHA-256 we request).
// Multipaz hashes the same input — the bytes of the base64url string (TransactionData.
// computeHash over `serialized`) — so a matching alg reproduces the wallet's hash.
export function hashTransactionData(txDataB64: string, alg: TxHashName = "sha256"): string {
  return createHash(alg).update(txDataB64).digest("base64url");
}

export function decodeTransactionData(txDataB64: string): TransactionData {
  return JSON.parse(Buffer.from(txDataB64, "base64url").toString("utf8")) as TransactionData;
}
