// Verify an iOS org-iso-mdoc presentation: open the sealed reader context, rebuild
// the dcapi session transcript (bound to the web origin), HPKE-decrypt the wallet's
// DeviceResponse, flatten its claims, and run the SAME evaluateCredential policy.
// Faithfully ported from the demo's payment-gate/credential-gate/mdoc-verify.ts.
//
// The wire crypto is REAL — HPKE (P-256 / HKDF-SHA256 / AES-128-GCM) decryption is
// bound to the origin via the session transcript (info), so a response captured for
// a different origin fails to open. What is NOT verified is the issuer/device COSE
// signature (trust anchor) — same posture as the OpenID4VP path; trust_level stays
// presence-only-demo.
import type { Origin } from "../origin.js";
import { evaluateDisclosed, evaluateDisclosedCustom, type PresentationResult } from "./verify.js";
import type { Credential } from "../../types.js";
import type { CredentialKind } from "./dcql.js";
import { mdocDocSpec } from "./doc-spec.js";
import {
  openMdocContext,
  buildSessionTranscript,
  decryptDeviceResponse,
  disclosedFromDeviceResponse,
} from "../mdoc/mdoc-iso.js";

export async function verifyMdocPresentation(args: {
  kind: CredentialKind;
  result: { protocol?: string; data?: unknown };
  mdocContextToken: string;
  origin: Origin;
  secret: string;
  minimumAge?: number;
  percent?: number;
  /** Custom credential (007): when present, its OWN `verify` runs on the disclosed
   *  claims instead of the built-in age/membership policy. */
  credential?: Credential;
}): Promise<PresentationResult> {
  const { kind, result, mdocContextToken, origin, secret, minimumAge, percent, credential } = args;
  const ctx = await openMdocContext(mdocContextToken, secret);

  let data: unknown = result?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }
  const responseB64Url =
    (data as { response?: string } | undefined)?.response ??
    (typeof data === "string" ? (data as string) : undefined);
  if (!responseB64Url) throw new Error("no .response in org-iso-mdoc result.data");

  const sessionTranscript = buildSessionTranscript(ctx.base64EncryptionInfo, origin.origin);
  const deviceResponse = await decryptDeviceResponse({
    responseB64Url,
    readerPrivateJwk: ctx.readerPrivateJwk,
    sessionTranscript,
  });
  const disclosed = disclosedFromDeviceResponse(deviceResponse);
  // The DeviceResponse the decision was made on (base64url) — returned to the page only
  // when the host opted in to inspectPresentations.
  const presented = { deviceResponse: Buffer.from(deviceResponse).toString("base64url") };
  if (credential) return { ...evaluateDisclosedCustom(credential, disclosed), ...presented };
  // The iOS DeviceRequest is built from this same doc spec; keep it referenced so
  // the request/verify pair stays aligned to one doctype definition.
  void mdocDocSpec(kind, minimumAge);
  return { ...evaluateDisclosed(kind, disclosed, { minimumAge, percent }), ...presented };
}
