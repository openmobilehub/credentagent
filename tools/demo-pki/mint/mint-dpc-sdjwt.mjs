// Mint the demo Digital Payment Credential as an SD-JWT VC (`dc+sd-jwt`).
//
// WHY THIS EXISTS (spec 014, FR-1). The demo credential set is minted as ISO mdoc
// `.mpzpass` bundles by the Kotlin generators in the Multipaz fork (see ../README.md). AP2's
// delegation mechanism is specified for SD-JWT VCs only — its chain serialization is SD-JWT
// syntax, and mdoc has no equivalent — so the delegated-intent work needs the same payment
// credential in the other format. This is that minting step, and nothing else: it produces a
// credential, it does not present one and it does not verify a chain.
//
// The `vct` is `com.emvco.dpc`, the value AP2's own example uses, so a verifier written
// against the specification matches this credential with no local convention to learn.
//
// The claim set is `PAYMENT_CLAIM_LEAVES` from the gate's DCQL
// (`ceremony/dc-payment/dcql.ts`) — the same six claims the mdoc DPC carries — so one DCQL
// shape serves both formats and a rail can request either.
//
// HONESTY: this mints a DEMO credential. The issuer key is a demo key, and a credential it
// signs proves only that this tool signed it. Nothing here is an issuer trust anchor (#14).
//
// Usage:
//   node mint-dpc-sdjwt.mjs                        # dev: generates both keys, writes them out
//   node mint-dpc-sdjwt.mjs --device-key dev.jwk   # bind to a real wallet's device key
//   node mint-dpc-sdjwt.mjs --issuer-key ds-key.pem --device-key dev.jwk
//   node mint-dpc-sdjwt.mjs --inspect ../out/dpc.sdjwt
//
// Flags:
//   --issuer-key <file>   EC P-256 private key (PEM or JWK). Absent ⇒ generated + written out.
//   --device-key <file>   EC P-256 PUBLIC JWK for `cnf`. Absent ⇒ a holder pair is generated.
//   --out <dir>           Output directory (default ../out).
//   --holder <name>       Cardholder name on the credential.
//   --inspect <file>      Decode and print an existing credential instead of minting.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDJwtInstance, decodeSdJwt, getClaims } from "@sd-jwt/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** AP2's own example `vct` for a Digital Payment Credential. */
const VCT = "com.emvco.dpc";

/** IANA hash name. `_sd_alg` records it; a verifier follows the token's own value. */
const SD_HASH_ALG = "sha-256";

/** One year. A demo credential that never expires is a demo credential nobody re-mints. */
const DEFAULT_TTL_DAYS = 365;

// ── argv ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i += 1, next) : true;
  }
  return out;
}

// ── crypto wiring (mirrors the gate's ap2/sdjwt.ts, deliberately) ─────────────

const utf8 = new TextEncoder();

const hasher = (data, alg) => {
  // @sd-jwt uses IANA names ("sha-256"); node wants "sha256".
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return new Uint8Array(createHash(alg.replace(/-/g, "")).update(input).digest());
};

const saltGenerator = (length) =>
  Buffer.from(webcrypto.getRandomValues(new Uint8Array(length))).toString("hex").slice(0, length);

// `ieee-p1363` is the raw r‖s encoding JWS requires — node's default for EC is DER, which
// would produce signatures no JWS verifier accepts. Same lesson as ap2/sdjwt.ts.
const es256Signer = (privateKey) => (data) =>
  nodeSign("sha256", utf8.encode(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");

// ── keys ──────────────────────────────────────────────────────────────────────

/** Load an EC P-256 private key from a PEM or a JWK file. */
function loadPrivateKey(file) {
  const raw = readFileSync(file, "utf-8").trim();
  if (raw.startsWith("-----BEGIN")) return createPrivateKey(raw);
  const jwk = JSON.parse(raw);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error(`${file}: expected an EC P-256 JWK (got kty=${jwk.kty} crv=${jwk.crv}) — DPC signing here is ES256`);
  }
  if (!jwk.d) throw new Error(`${file}: this is a PUBLIC JWK (no \`d\`); --issuer-key needs the private half`);
  return createPrivateKey({ key: jwk, format: "jwk" });
}

/** Load an EC P-256 PUBLIC JWK, stripping anything that is not the key itself. */
function loadPublicJwk(file) {
  const jwk = JSON.parse(readFileSync(file, "utf-8"));
  const key = jwk.jwk ?? jwk; // tolerate a wrapped { jwk: … } (a `cnf` pasted whole)
  if (key.kty !== "EC" || key.crv !== "P-256") {
    throw new Error(`${file}: expected an EC P-256 public JWK (got kty=${key.kty} crv=${key.crv})`);
  }
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y };
}

function generateP256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: (({ kty, crv, x, y }) => ({ kty, crv, x, y }))(publicKey.export({ format: "jwk" })),
  };
}

/** RFC 7638 thumbprint — a stable `kid` for a demo key, so a swap is visible. */
function thumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}

// ── mint ──────────────────────────────────────────────────────────────────────

/**
 * The instrument claims, matching `PAYMENT_CLAIM_LEAVES` in the gate's dc-payment DCQL.
 * Every one is selectively disclosable: a merchant asking for the masked account should not
 * receive the holder's name as a side effect.
 */
function instrumentClaims(holder) {
  const issued = new Date();
  const expiry = new Date(Date.UTC(issued.getUTCFullYear() + 5, issued.getUTCMonth(), issued.getUTCDate()));
  return {
    issuer_name: "Bank of Utopia",
    payment_instrument_id: `dpc-${Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex")}`,
    masked_account_reference: "•••• 4444",
    holder_name: holder,
    issue_date: issued.toISOString().slice(0, 10),
    expiry_date: expiry.toISOString().slice(0, 10),
  };
}

async function mint({ issuerKey, issuerJwk, deviceJwk, holder, ttlDays }) {
  const sdjwt = new SDJwtInstance({
    hasher,
    hashAlg: SD_HASH_ALG,
    saltGenerator,
    signAlg: "ES256",
    signer: es256Signer(issuerKey),
  });

  const iat = Math.floor(Date.now() / 1000);
  const claims = instrumentClaims(holder);

  const payload = {
    iss: "https://demo-pki.credentagent.local",
    vct: VCT,
    iat,
    exp: iat + ttlDays * 24 * 60 * 60,
    // RFC 7800 §3.1. THIS is what makes the credential presentable with key binding: the
    // wallet proves possession of this key, and AP2's delegation rides on that proof.
    cnf: { jwk: deviceJwk },
    ...claims,
  };

  const token = await sdjwt.issue(
    payload,
    { _sd: Object.keys(claims) },
    { header: { kid: thumbprint(issuerJwk), typ: "dc+sd-jwt" } },
  );

  return { token, payload, disclosableClaims: Object.keys(claims) };
}

// ── inspect ───────────────────────────────────────────────────────────────────

async function inspect(file) {
  const token = readFileSync(file, "utf-8").trim();
  const decoded = await decodeSdJwt(token, hasher);
  const claims = await getClaims(decoded.jwt.payload, decoded.disclosures, hasher);
  console.log(`\n  ${path.relative(process.cwd(), file)}\n`);
  console.log("  header     ", JSON.stringify(decoded.jwt.header));
  console.log("  vct        ", claims.vct);
  console.log("  iss        ", claims.iss);
  console.log("  exp        ", new Date(claims.exp * 1000).toISOString());
  console.log("  cnf.jwk    ", JSON.stringify(claims.cnf?.jwk));
  console.log("  key binding", decoded.kbJwt ? "present" : "none (an issued credential carries none)");
  console.log("\n  disclosures (each one is separately withholdable):");
  for (const d of decoded.disclosures) console.log(`    ${d.key} = ${JSON.stringify(d.value)}`);
  console.log();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspect) {
    await inspect(path.resolve(process.cwd(), args.inspect));
    return;
  }

  const outDir = path.resolve(HERE, typeof args.out === "string" ? args.out : "../out");
  mkdirSync(outDir, { recursive: true });
  const holder = typeof args.holder === "string" ? args.holder : "Demo Buyer";
  const written = [];

  // The issuer key. `gen-pki.sh` keeps the demo Document Signer's private key OUT of the
  // repository, so there is nothing to default to — generate one and say so loudly rather
  // than silently minting under a key the caller did not choose.
  let issuerKey;
  let issuerJwk;
  if (typeof args["issuer-key"] === "string") {
    issuerKey = loadPrivateKey(path.resolve(process.cwd(), args["issuer-key"]));
    issuerJwk = issuerKey.export({ format: "jwk" });
  } else {
    const gen = generateP256();
    issuerKey = gen.privateKey;
    issuerJwk = gen.privateJwk;
    const file = path.join(outDir, "dpc-issuer-key.jwk");
    writeFileSync(file, `${JSON.stringify(gen.privateJwk, null, 2)}\n`, { mode: 0o600 });
    written.push([file, "GENERATED issuer private key — pass --issuer-key next time to keep one identity"]);
  }

  // The device key that goes in `cnf`. A real run passes the wallet's key; a dev run gets a
  // local holder pair so the whole flow is exercisable before any phone is involved.
  let deviceJwk;
  if (typeof args["device-key"] === "string") {
    deviceJwk = loadPublicJwk(path.resolve(process.cwd(), args["device-key"]));
  } else {
    const gen = generateP256();
    deviceJwk = gen.publicJwk;
    const file = path.join(outDir, "dpc-holder-key.jwk");
    writeFileSync(file, `${JSON.stringify(gen.privateJwk, null, 2)}\n`, { mode: 0o600 });
    written.push([file, "GENERATED holder private key — the simulated wallet signs with this"]);
  }

  const { token, payload, disclosableClaims } = await mint({
    issuerKey,
    issuerJwk,
    deviceJwk,
    holder,
    ttlDays: DEFAULT_TTL_DAYS,
  });

  const tokenFile = path.join(outDir, "dpc.sdjwt");
  writeFileSync(tokenFile, `${token}\n`);
  written.push([tokenFile, "the credential — compact SD-JWT, issuer JWT + one disclosure per claim"]);

  const jsonFile = path.join(outDir, "dpc.json");
  writeFileSync(jsonFile, `${JSON.stringify({ vct: VCT, format: "dc+sd-jwt", payload, disclosableClaims, token }, null, 2)}\n`);
  written.push([jsonFile, "the same thing decoded, for reading"]);

  console.log(`\n  Minted a demo Digital Payment Credential (${VCT}, dc+sd-jwt)\n`);
  for (const [file, why] of written) console.log(`    ${path.relative(process.cwd(), file)}\n      ${why}`);
  console.log(`\n  Inspect it:\n    node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} --inspect ${path.relative(process.cwd(), tokenFile)}`);
  console.log(`\n  DEMO ONLY. A credential this signs proves this tool signed it — nothing about a\n  real card issuer. Issuer trust is #14 and is still open.\n`);
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
