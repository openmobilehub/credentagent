// Getting a mandate chain across the wire — a query parameter, a form field, a JSON body.
//
// Decoding is DELIBERATELY permissive and returns `undefined` rather than throwing: a caller
// must never be able to tell a malformed parameter from a forged one by watching for an
// exception, and `verifyChain` is the real gate. Nothing here validates; it only parses.
import type { MandateChain } from "./chain.js";

/** Wire form: base64url of the JSON `{ checkout, payment, openCheckout?, openPayment? }`. */
export function encodeMandateChainParam(chain: MandateChain): string {
  return Buffer.from(JSON.stringify(chain), "utf-8").toString("base64url");
}

/**
 * Parse a chain parameter. Accepts the base64url form, a raw JSON string, or an object that
 * already has the right shape (a JSON body). `undefined` for anything else.
 *
 * The shape check is structural and minimal — two string tokens — because a chain that
 * parses but does not verify is exactly what `verifyChain` exists to refuse. Rejecting more
 * here would only move the failure earlier and blur the reason.
 */
export function decodeMandateChainParam(value: unknown): MandateChain | undefined {
  if (value === null || value === undefined) return undefined;

  let candidate: unknown = value;
  if (typeof value === "string") {
    candidate = tryJson(value) ?? tryJson(safeB64(value));
  }
  if (typeof candidate !== "object" || candidate === null) return undefined;

  const c = candidate as Record<string, unknown>;
  if (typeof c.checkout !== "string" || typeof c.payment !== "string") return undefined;
  return {
    checkout: c.checkout,
    payment: c.payment,
    ...(typeof c.openCheckout === "string" ? { openCheckout: c.openCheckout } : {}),
    ...(typeof c.openPayment === "string" ? { openPayment: c.openPayment } : {}),
  };
}

function tryJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function safeB64(raw: string): string | undefined {
  try {
    return Buffer.from(raw, "base64url").toString("utf-8");
  } catch {
    return undefined;
  }
}
