// Offline transcript solver: given the wallet's REAL DeviceResponse, find which
// SessionTranscript construction its deviceSignature actually verifies against.
// Enumerates every candidate in on-device-interop.md §4.4 (plus neighbours) in one pass.
import fs from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { Encoder, decode as cborDecode, Tag } from "cbor-x";
import { parseDeviceResponse } from "./packages/credentagent-gate/dist/ceremony/intent-sign/deviceAuth.js";

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
const cbor = (v) => enc.encode(v);
const subtle = webcrypto.subtle;
const sha256 = (b) => createHash("sha256").update(b).digest();

const cap = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { deviceResponseB64url, origin, rpID, nonce, thumbprint } = cap;
console.log(`origin=${origin}\nrpID=${rpID}\nnonce=${nonce}\nthumbprint=${thumbprint}\n`);

const parsed = parseDeviceResponse(deviceResponseB64url);
if (!parsed) { console.error("unparseable"); process.exit(1); }
console.log(`docType=${parsed.docType}`);
console.log(`deviceKey=${parsed.deviceKeyJwk ? "present" : "MISSING"}`);
const protectedHeader = Buffer.from(parsed.deviceSignature[0]);
const signature = Buffer.from(parsed.deviceSignature[3]);
console.log(`sigLen=${signature.length} protectedHex=${protectedHeader.toString("hex")}\n`);

const key = await subtle.importKey("jwk", { ...parsed.deviceKeyJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);

function asTag24(v) {
  if (v instanceof Tag) return v;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return new Tag(Buffer.from(v), 24);
  return new Tag(cbor(v), 24);
}

async function check(label, transcriptBytes) {
  const da = ["DeviceAuthentication", cborDecode(transcriptBytes), parsed.docType, asTag24(parsed.deviceNameSpacesTag)];
  const daBytes = cbor(new Tag(cbor(da), 24));
  const sig1 = cbor(["Signature1", protectedHeader, Buffer.alloc(0), daBytes]);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, sig1);
  console.log(`${ok ? "  ✓ MATCH  " : "  ·        "} ${label}`);
  return ok;
}

const thumbBstr = Buffer.from(thumbprint, "base64url");
const clientId = `x509_san_dns:${rpID}`;
const originNoSlash = origin.replace(/\/+$/, "");
const originSlash = `${originNoSlash}/`;

// [label, handoverLabel, handoverInfoArray]
const handovers = [];
for (const [oLabel, o] of [["origin", originNoSlash], ["origin+/", originSlash]]) {
  handovers.push([`DRAFT_29 [${oLabel}, nonce, thumb(tstr)]`, "OpenID4VPDCAPIHandover", [o, nonce, thumbprint]]);
  handovers.push([`A″       [${oLabel}, nonce, thumb(bstr)]`, "OpenID4VPDCAPIHandover", [o, nonce, thumbBstr]]);
  handovers.push([`A′ D24   [${oLabel}, clientId, nonce]`,    "OpenID4VPDCAPIHandover", [o, clientId, nonce]]);
  handovers.push([`2-elem   [${oLabel}, nonce]`,              "OpenID4VPDCAPIHandover", [o, nonce]]);
  handovers.push([`swap     [${oLabel}, thumb(tstr), nonce]`, "OpenID4VPDCAPIHandover", [o, thumbprint, nonce]]);
}

let hit = false;
for (const [label, hLabel, info] of handovers) {
  for (const lbl of [hLabel, "OpenID4VPHandover"]) {
    const t = cbor([null, null, [lbl, sha256(cbor(info))]]);
    if (await check(`${label}  label=${lbl}`, t)) hit = true;
  }
}

// Fix C — the response_uri-style OID4VPHandover [clientIdHash, responseUriHash, nonce]
for (const responseUri of [`${originNoSlash}/credentagent/grants/sign/verify`, originNoSlash]) {
  const t = cbor([null, null, ["OID4VPHandover", sha256(cbor([clientId])), sha256(cbor([responseUri])), nonce]]);
  if (await check(`Fix C OID4VPHandover responseUri=${responseUri}`, t)) hit = true;
}

if (!hit) console.log("\n  ✗ no candidate matched — dump the DeviceResponse and inspect the wallet build.");
