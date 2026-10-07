// Compact JWS for the ONE payload AP2 carries as a plain JWT rather than an SD-JWT: the
// merchant-signed Checkout that a Checkout Mandate wraps in `checkout_jwt`.
//
// Signed with the merchant's CHECKOUT key, distinct from the key that issues mandates (spec 014,
// FR-6). The `kid` names which key signed, and a verifier given a key with a `kid` holds the
// token to it — so a token signed in one role is never read as a statement of the other.
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
  if (publicJwk.kid !== undefined && peekJwtHeader(token)?.kid !== publicJwk.kid) return undefined;
  if (!es256Verifier(publicJwk)(`${header}.${payload}`, signature)) return undefined;
  return peekJson<T>(payload);
}

/**
 * Decode one base64url JSON segment — a JWS header or payload, a disclosure, a `transaction_data`
 * entry — WITHOUT verifying it. `undefined` when it is not JSON. The one decoder in this package:
 * read with it to route (which key, which claim), never to decide.
 */
export function peekJson<T = Record<string, unknown>>(segment: string | undefined): T | undefined {
  if (typeof segment !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** Decode WITHOUT verifying — only for reading a `kid` to decide which key to check against. */
export function peekJwtHeader(token: string): Record<string, unknown> | undefined {
  return peekJson(token.split(".")[0]);
}
