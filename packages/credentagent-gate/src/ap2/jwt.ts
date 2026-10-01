// Compact JWS for the ONE payload AP2 carries as a plain JWT rather than an SD-JWT: the
// merchant-signed Checkout that a Checkout Mandate wraps in `checkout_jwt`.
//
// v1 signs it with the gate's own key, because in this library the gate IS the merchant
// surface. A distinct merchant key is a follow-up, and the `kid` makes that swap visible
// rather than silent.
import type { KeyObject } from "node:crypto";
import { es256Signer, es256Verifier } from "./sdjwt.js";
import type { PublicJwkP256 } from "./keys.js";

const b64uJson = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");

export function signCompactJwt(payload: object, privateKey: KeyObject, kid: string): string {
  const signingInput = `${b64uJson({ alg: "ES256", typ: "JWT", kid })}.${b64uJson(payload)}`;
  return `${signingInput}.${es256Signer(privateKey)(signingInput)}`;
}

/** Verify + decode. Returns `undefined` on ANY failure — a caller must not tell them apart. */
export function verifyCompactJwt<T>(token: string, publicJwk: PublicJwkP256): T | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts;
  if (!es256Verifier(publicJwk)(`${header}.${payload}`, signature)) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** Decode WITHOUT verifying — only for reading a `kid` to decide which key to check against. */
export function peekJwtHeader(token: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
