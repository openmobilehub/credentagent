// The REAL mdoc DeviceAuth check — the crypto that makes this rail "device-signed"
// rather than presence-only.
//
// The presence-only rails (credential-gate, dc-payment) PARSE the ISO 18013-5
// DeviceResponse but do NOT verify the device's COSE signature — a self-crafted
// mdoc passes them (that is the honesty fence). This rail goes one step further: it
// verifies the wallet's `deviceSignature` (an ES256 COSE_Sign1, detached payload)
// over the ISO `DeviceAuthentication` structure, whose `SessionTranscript` carries
// the bounds-bound nonce. So a valid presentation PROVES the device key actually
// signed over exactly these grant bounds — holder-of-key + binding, not mere
// disclosure.
//
// What is STILL demo (FR-4): the device public key is read from the credential's
// Mobile Security Object (MSO), which this rail does NOT anchor to a trusted issuer
// (no issuer/VICAL check — that is issue #14). So the signature is real, but the
// KEY it is made with is a self-minted demo credential's. An attacker who crafts
// their own device key + MSO + signature is internally consistent and would pass —
// exactly the `trust_level` limitation the page states plainly.
import { Encoder, decode as cborDecode, Tag } from "cbor-x";
import { createHash, webcrypto } from "node:crypto";

// Deterministic (canonical) CBOR — the SAME encoder settings the org-iso-mdoc rail
// uses (minimal map headers, no tag-259 map wrapper), so the bytes the verifier
// reconstructs match what a conformant wallet signed. See mdoc-iso.ts for why each
// flag matters.
const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false } as ConstructorParameters<typeof Encoder>[0]);
function cbor(value: unknown): Buffer {
  return enc.encode(value);
}

const subtle = webcrypto.subtle;

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}
function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return null;
}
// COSE maps use integer keys. cbor-x may decode them as a Map or (with
// mapsAsObjects) as an object with stringified keys — read either shape.
function mapGet(m: unknown, key: number): unknown {
  if (m instanceof Map) return m.get(key) ?? m.get(String(key));
  if (m && typeof m === "object") return (m as Record<string, unknown>)[String(key)];
  return undefined;
}
function objGet(m: unknown, key: string): unknown {
  if (m instanceof Map) return m.get(key);
  if (m && typeof m === "object") return (m as Record<string, unknown>)[key];
  return undefined;
}
// A #6.24(bstr .cbor X) value: after decode it may be a Tag(24, bytes) or already
// the inner bytes — decode through ONE layer to X.
function decodeTagged(item: unknown): unknown {
  if (item instanceof Tag) return cborDecode(item.value as Uint8Array);
  const bytes = asBytes(item);
  if (bytes) return cborDecode(bytes);
  return item;
}

// Decode through NESTED #6.24 / bstr layers until a structured value (map/object) is
// reached — the COSE_Sign1 payload of issuerAuth is a bstr whose content is itself the
// #6.24-tagged MobileSecurityObjectBytes, so the MSO sits two layers deep.
function unwrap24(item: unknown): unknown {
  let cur = item;
  for (let i = 0; i < 4; i++) {
    if (cur instanceof Tag) { cur = cborDecode(cur.value as Uint8Array); continue; }
    const bytes = asBytes(cur);
    if (bytes) {
      try { cur = cborDecode(bytes); continue; } catch { return cur; }
    }
    return cur; // a map / object / primitive
  }
  return cur;
}

// Re-embed a DeviceNameSpacesBytes value as the SAME #6.24(bstr) it arrived as, so
// the reconstructed DeviceAuthentication is byte-identical to what the wallet signed
// (cbor-x may hand us the Tag or the bare bstr depending on its build).
function asTag24(item: unknown): Tag {
  if (item instanceof Tag) return item;
  const bytes = asBytes(item);
  if (bytes) return new Tag(Buffer.from(bytes), 24);
  return new Tag(cbor(item), 24);
}

/**
 * SessionTranscript for the OpenID4VP DC API path, bound to the ceremony nonce:
 *
 *   [ null, null, ["OpenID4VPDCAPIHandover", sha256(CBOR([origin, nonce])) ] ]
 *
 * ISO 18013-5 shape (`[DeviceEngagementBytes, EReaderKeyBytes, Handover]`, both
 * engagement slots null for the DC API). The nonce — bound to the grant bounds in
 * bounds.ts — is inside the handover, so the DeviceAuth signature over this
 * transcript covers the bounds. Both the simulated wallet (simulate.ts) and this
 * verifier build it identically, so the in-process flow is fully consistent.
 *
 * NOTE (interop, deferred to the maintainer's on-device test — FR-7): the exact
 * handover bytes a specific wallet build (Multipaz / `utopia.multipaz.org`) hashes
 * may differ from this shape as the OpenID4VP DC API session-transcript definition
 * settles. Align this ONE function with the wallet if the real-phone signature does
 * not verify; nothing else in the rail changes.
 */
export function buildIntentSessionTranscript(origin: string, nonce: string): Uint8Array {
  const handoverInfo = cbor([origin, nonce]);
  const handoverHash = createHash("sha256").update(handoverInfo).digest();
  return cbor([null, null, ["OpenID4VPDCAPIHandover", handoverHash]]);
}

/** A COSE_Key (EC2 / P-256) → public JWK, or null when it is not a P-256 EC key. */
export function coseKeyToJwk(coseKey: unknown): { kty: "EC"; crv: "P-256"; x: string; y: string } | null {
  const kty = mapGet(coseKey, 1); // 2 = EC2
  const crv = mapGet(coseKey, -1); // 1 = P-256
  const x = asBytes(mapGet(coseKey, -2));
  const y = asBytes(mapGet(coseKey, -3));
  if (Number(kty) !== 2 || Number(crv) !== 1 || !x || !y) return null;
  return { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) };
}

interface ParsedDoc {
  docType: string;
  /** The device public key from the MSO (unverified issuer anchor — see file header). */
  deviceKeyJwk: { kty: "EC"; crv: "P-256"; x: string; y: string } | null;
  /** The detached COSE_Sign1 [protectedBytes, unprotected, null, signature]. */
  deviceSignature: unknown[] | null;
  /** DeviceNameSpacesBytes — the #6.24 tagged bstr, re-embedded verbatim. */
  deviceNameSpacesTag: unknown;
  /** Disclosed issuer-signed claims (elementId → value) for the required-claim check. */
  disclosed: Record<string, unknown>;
}

/** Structurally parse one DeviceResponse document down to the fields DeviceAuth
 *  verification needs. Returns null on a shape it cannot read (fail-closed). */
export function parseDeviceResponse(deviceResponseB64url: string): ParsedDoc | null {
  let dr: unknown;
  try {
    dr = cborDecode(Buffer.from(deviceResponseB64url, "base64url"));
  } catch {
    return null;
  }
  const docs = objGet(dr, "documents");
  const doc = Array.isArray(docs) ? docs[0] : undefined;
  if (!doc) return null;
  const docType = String(objGet(doc, "docType") ?? "");

  // Device public key ← issuerSigned.issuerAuth payload (MSO). NOT issuer-verified.
  const issuerSigned = objGet(doc, "issuerSigned");
  const issuerAuth = objGet(issuerSigned, "issuerAuth");
  let deviceKeyJwk: ParsedDoc["deviceKeyJwk"] = null;
  if (Array.isArray(issuerAuth) && issuerAuth.length >= 3) {
    try {
      const mso = unwrap24(issuerAuth[2]); // COSE payload → MobileSecurityObjectBytes → MSO
      const deviceKeyInfo = objGet(mso, "deviceKeyInfo");
      const deviceKey = objGet(deviceKeyInfo, "deviceKey");
      deviceKeyJwk = coseKeyToJwk(deviceKey);
    } catch {
      deviceKeyJwk = null;
    }
  }

  // Disclosed issuer-signed claims (for the required-payment-claim check).
  const disclosed: Record<string, unknown> = {};
  const nameSpaces = objGet(issuerSigned, "nameSpaces");
  if (nameSpaces && typeof nameSpaces === "object") {
    for (const items of Object.values(nameSpaces as Record<string, unknown>)) {
      for (const raw of (items as unknown[]) ?? []) {
        const isi = decodeTagged(raw) as Record<string, unknown>;
        const id = isi?.elementIdentifier;
        if (typeof id === "string") disclosed[id] = isi.elementValue;
      }
    }
  }

  // deviceSigned: the detached signature + DeviceNameSpacesBytes.
  const deviceSigned = objGet(doc, "deviceSigned");
  const deviceAuth = objGet(deviceSigned, "deviceAuth");
  const deviceSignature = objGet(deviceAuth, "deviceSignature");
  const deviceNameSpacesTag = objGet(deviceSigned, "nameSpaces");

  return {
    docType,
    deviceKeyJwk,
    deviceSignature: Array.isArray(deviceSignature) ? deviceSignature : null,
    deviceNameSpacesTag,
    disclosed,
  };
}

export interface DeviceAuthResult {
  ok: boolean;
  reason?: string;
  docType?: string;
  disclosed?: Record<string, unknown>;
}

/**
 * Verify the wallet's DeviceAuth `deviceSignature` (ES256 COSE_Sign1, detached)
 * over `DeviceAuthentication = ["DeviceAuthentication", SessionTranscript, DocType,
 * DeviceNameSpacesBytes]`, using the device key from the parsed MSO. The transcript
 * MUST be the one the caller re-derived from the bounds-bound nonce — that is what
 * ties the signature to the grant.
 */
export async function verifyDeviceAuth(args: {
  deviceResponseB64url: string;
  sessionTranscript: Uint8Array;
}): Promise<DeviceAuthResult> {
  const parsed = parseDeviceResponse(args.deviceResponseB64url);
  if (!parsed) return { ok: false, reason: "unparseable DeviceResponse" };
  if (!parsed.deviceKeyJwk) return { ok: false, reason: "no device key in MSO" };
  if (!parsed.deviceSignature) return { ok: false, reason: "no deviceSignature" };

  const protectedHeader = asBytes(parsed.deviceSignature[0]);
  const signature = asBytes(parsed.deviceSignature[3]);
  if (!protectedHeader || !signature) return { ok: false, reason: "malformed deviceSignature" };

  // DeviceAuthenticationBytes = #6.24(bstr .cbor DeviceAuthentication).
  const deviceAuthentication = [
    "DeviceAuthentication",
    cborDecode(args.sessionTranscript),
    parsed.docType,
    asTag24(parsed.deviceNameSpacesTag),
  ];
  const deviceAuthenticationBytes = cbor(new Tag(cbor(deviceAuthentication), 24));

  // COSE_Sign1 detached Sig_structure = ["Signature1", protected, external_aad(∅), payload].
  const sigStructure = cbor(["Signature1", Buffer.from(protectedHeader), Buffer.alloc(0), deviceAuthenticationBytes]);

  let ok = false;
  try {
    const key = await subtle.importKey(
      "jwk",
      { ...parsed.deviceKeyJwk, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, sigStructure);
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: "device signature does not verify" };
  return { ok: true, docType: parsed.docType, disclosed: parsed.disclosed };
}
