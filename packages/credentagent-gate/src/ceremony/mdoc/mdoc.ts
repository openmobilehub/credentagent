// Structural-only decode of a presented mdoc DeviceResponse (ISO 18013-5 CBOR).
// Extracted FAITHFULLY from the demo's payment-gate/dc-payment/mdoc.ts — the
// SAME real wire parser both rails (credential-gate + dc-payment) feed their
// decrypted DeviceResponse into.
//
// What is REAL here: the ISO 18013-5 CBOR wire format is fully parsed — the
// DeviceResponse → documents → issuerSigned.nameSpaces → IssuerSignedItemBytes
// (#6.24 tagged) → elementIdentifier / elementValue, and the deviceSigned
// transaction_data_hash. What is NOT verified here: the issuer/device COSE
// SIGNATURES and the value digests — that issuer-trust check is the acknowledged
// future work (main self-signs its mdoc certs, so there is no real trust anchor
// yet). The crypto that IS real — JWE/HPKE decryption + nonce binding — runs in
// verify before this parser ever sees the bytes.
import { decode, Tag } from "cbor-x";

function b64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(String(s), "base64url"));
}

// IssuerSignedItemBytes = #6.24(bstr .cbor IssuerSignedItem). Depending on the
// cbor-x build, tag 24 arrives as a Tag wrapping bytes or already as bytes.
function decodeTagged(item: unknown): any {
  if (item instanceof Tag) return decode(item.value as Uint8Array);
  if (item instanceof Uint8Array) return decode(item);
  return item;
}

function sanitize(v: unknown): any {
  if (v instanceof Uint8Array) return { _bytes_b64url: Buffer.from(v).toString("base64url") };
  if (v instanceof Tag) return { _tag: v.tag, value: sanitize(v.value) };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) o[k] = sanitize(val);
    return o;
  }
  return v;
}

export interface DisclosedEntry {
  id: string;
  format: string;
  type?: string;
  claims: { label: string; value: any }[];
}

// vp_token from OpenID4VP DC API: { "<dcql-id>": "<base64url DeviceResponse>" }
// (older shape: an array, or a wrapping array per id). Returns a flattened shape.
export function decodeVpToken(vpToken: unknown): DisclosedEntry[] {
  const entries: [string, unknown][] = Array.isArray(vpToken)
    ? vpToken.map((v, i) => [String(i), v])
    : Object.entries((vpToken as Record<string, unknown>) ?? {});
  return entries.map(([id, token]) => {
    const str = Array.isArray(token) ? token[0] : token;
    const dr = decode(b64urlToBytes(str as string)) as any;
    const flat: { label: string; value: any }[] = [];
    let type: string | undefined;
    for (const doc of dr.documents ?? []) {
      type = doc.docType;
      const nameSpaces = doc.issuerSigned?.nameSpaces ?? {};
      for (const [ns, items] of Object.entries(nameSpaces)) {
        for (const raw of items as unknown[]) {
          const isi = decodeTagged(raw);
          flat.push({ label: `${ns} / ${isi.elementIdentifier}`, value: sanitize(isi.elementValue) });
        }
      }
    }
    return { id, format: "mso_mdoc", type, claims: flat };
  });
}

// The payment binding lives in deviceSigned, not issuerSigned. Returns the
// transaction_data_hash bytes as base64url, or null.
export function extractTransactionDataHash(
  vpStr: string | string[],
  namespace = "urn:eudi:sca:payment:1",
  element = "transaction_data_hash",
): string | null {
  const str = Array.isArray(vpStr) ? vpStr[0] : vpStr;
  const dr = decode(b64urlToBytes(str)) as any;
  for (const doc of dr.documents ?? []) {
    const ns = decodeTagged(doc.deviceSigned?.nameSpaces);
    const val = ns?.[namespace]?.[element];
    if (val instanceof Uint8Array) return Buffer.from(val).toString("base64url");
  }
  return null;
}

// The COSE hash-algorithm id the wallet bound the transaction_data with, read from
// `transaction_data_hash_alg` in the SAME deviceSigned namespace. Multipaz OMITS this
// element when it used its SHA-256 default (mdocPresentment.kt), so `null` means
// "SHA-256"; otherwise it is the raw COSE integer (e.g. -43 for SHA-384) that verify
// maps to a hash function.
export function extractTransactionDataHashAlg(
  vpStr: string | string[],
  namespace = "urn:eudi:sca:payment:1",
  element = "transaction_data_hash_alg",
): number | null {
  const str = Array.isArray(vpStr) ? vpStr[0] : vpStr;
  const dr = decode(b64urlToBytes(str)) as any;
  for (const doc of dr.documents ?? []) {
    const ns = decodeTagged(doc.deviceSigned?.nameSpaces);
    const val = ns?.[namespace]?.[element];
    if (typeof val === "number") return val;
  }
  return null;
}

export interface AuthBlocks {
  hasIssuerAuth: boolean;
  hasDeviceAuth: boolean;
  docType: string | null;
}

export function inspectAuthBlocks(vpStr: string | string[]): AuthBlocks {
  const str = Array.isArray(vpStr) ? vpStr[0] : vpStr;
  const dr = decode(b64urlToBytes(str)) as any;
  const doc = (dr.documents ?? [])[0] ?? {};
  const issuerAuth = doc.issuerSigned?.issuerAuth;
  const deviceAuth = doc.deviceSigned?.deviceAuth;
  return {
    hasIssuerAuth: Array.isArray(issuerAuth) && issuerAuth.length > 0,
    hasDeviceAuth: !!(deviceAuth && (deviceAuth.deviceSignature || deviceAuth.deviceMac)),
    docType: doc.docType ?? null,
  };
}
