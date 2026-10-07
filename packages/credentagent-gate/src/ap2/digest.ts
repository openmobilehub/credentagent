// The digests two AP2 parts of this package must compute identically — the ceremony rail that
// mints a mandate and the chain verifier that checks it. One definition here, so neither depends
// on the other and the encoding cannot drift between them.
import { createHash } from "node:crypto";
import { canonical } from "../ceremony/mandate.js";

/**
 * The digest an Open Payment Mandate's `payment.reference` names: sha-256 over the canonical
 * encoding of the Open Checkout Mandate's content.
 */
export function mandateContentDigest(content: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(content)).digest("base64url");
}

/**
 * A delegated permission's stable id: sha-256 of the wallet's signed key binding — the one
 * signature both of a purchase's chains rest on. The same for every purchase under one
 * permission, at every merchant, and computable by the agent from its presentation alone.
 */
export function permissionIdOf(walletKbJwt: string): string {
  return createHash("sha256").update(walletKbJwt).digest("base64url");
}
