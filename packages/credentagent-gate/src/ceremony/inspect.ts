// `inspectPresentations` (opt-in, default off): hand the wallet's decrypted ISO mdoc
// DeviceResponse back to the page that presented it, with a link that opens it in an
// independent inspector — so a developer (or a curious buyer) can see the actual
// verifiable credential the wallet sent: docType, issuer-signed claims, MSO validity,
// digests, device key.
//
// The inspector is Multipaz Tools' DeviceResponse viewer (tools.multipaz.org — the
// Multipaz SDK compiled to Kotlin/JS; it decodes entirely in the browser). The payload
// rides in the URL #fragment, which a browser never sends to the server.
//
// Off by default because a DeviceResponse from a REAL ID can carry personal data (the
// disclosed claims, the issuer chain, a device public key). It only ever goes back to
// the browser that just presented it — it is never stored or sent anywhere else.
//
// Honesty: this exposes the bytes; it verifies nothing new. The gate still does not
// check the issuer signature (trust_level presence-only-demo) and the page says so.
import { decode } from "cbor-x";

/** Multipaz Tools' ISO mdoc DeviceResponse viewer; the payload goes in the #fragment. */
export const INSPECTOR_URL = "https://tools.multipaz.org/mdocDeviceResponse";
/** Multipaz Tools' X.509 viewer — takes a base64url DER certificate in the #fragment. */
export const X509_URL = "https://tools.multipaz.org/x509";
/** Multipaz Tools' ISO 18013-7 / Digital Credentials verifier: it asks the wallet itself and runs
 *  the Multipaz SDK's signature checks — an independent check, not this gate's. */
export const VERIFIER_URL = "https://tools.multipaz.org/verifier";

/** What a verify response carries under `presentation` when `inspectPresentations` is on. */
export interface InspectablePresentation {
  format: "mso_mdoc";
  /** The decrypted ISO 18013-5 DeviceResponse the wallet presented (CBOR, base64url). */
  deviceResponse: string;
  /** Opens `deviceResponse` in the inspector (decoded client-side; nothing is uploaded). */
  inspectUrl: string;
  /** Opens the certificate that signed the credential (issuerAuth's x5chain leaf) in the X.509
   *  viewer — who the issuer claims to be. Absent when the credential carries no issuerAuth. */
  issuerCertUrl?: string;
}

export function presentationForInspection(deviceResponse: string): InspectablePresentation {
  const cert = issuerCertificate(deviceResponse);
  return {
    format: "mso_mdoc",
    deviceResponse,
    inspectUrl: `${INSPECTOR_URL}#${deviceResponse}`,
    ...(cert ? { issuerCertUrl: `${X509_URL}#${cert}` } : {}),
  };
}

/** The first document's issuer certificate (base64url DER): the leaf of the COSE `x5chain`
 *  header (label 33) in its issuerAuth, a COSE_Sign1 array. Undefined on anything unexpected. */
function issuerCertificate(deviceResponse: string): string | undefined {
  try {
    const dr = decode(Buffer.from(deviceResponse, "base64url")) as { documents?: { issuerSigned?: { issuerAuth?: unknown[] } }[] };
    const unprotected = dr.documents?.[0]?.issuerSigned?.issuerAuth?.[1];
    const x5chain = unprotected instanceof Map ? unprotected.get(33) : (unprotected as Record<string, unknown> | undefined)?.["33"];
    const leaf = Array.isArray(x5chain) ? x5chain[0] : x5chain;
    return leaf instanceof Uint8Array && leaf.length > 0 ? Buffer.from(leaf).toString("base64url") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ONE door a verify result leaves through: always strips the raw `deviceResponse`
 * the verifier carried, and adds `presentation` only when the host opted in. Every
 * route that answers with a presentation result goes through here, so the bytes can't
 * leak out of a route that forgot to check the flag.
 */
export function inspectionResponse<T extends { deviceResponse?: string }>(
  out: T,
  inspectPresentations: boolean | undefined,
): Omit<T, "deviceResponse"> & { presentation?: InspectablePresentation } {
  const { deviceResponse, ...rest } = out;
  return inspectPresentations === true && deviceResponse ? { ...rest, presentation: presentationForInspection(deviceResponse) } : rest;
}

/**
 * The first DeviceResponse in an OpenID4VP `vp_token` — `{ "<dcql-id>": "<b64url>" }`,
 * `{ "<dcql-id>": ["<b64url>"] }`, or the older bare array. Undefined when there is none.
 */
export function firstDeviceResponse(vpToken: unknown): string | undefined {
  if (!vpToken || typeof vpToken !== "object") return undefined;
  for (const entry of Array.isArray(vpToken) ? vpToken : Object.values(vpToken)) {
    const token = Array.isArray(entry) ? entry[0] : entry;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return undefined;
}
