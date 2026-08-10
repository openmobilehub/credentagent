// REAL OpenID4VP presentation tests for the dc-payment rail. These drive the actual
// crypto end-to-end: a real signed request (buildDcPaymentRequest, carrying the
// amount-bound transaction_data) → a simulated wallet that builds an ISO 18013-5
// mdoc DeviceResponse whose deviceSigned namespace carries the SHA-256 of exactly the
// transaction_data we sent, JWE-encrypts {vp_token:{dpc}} to the response key → the
// real verifyDcPresentation (decrypt + extract the device-signed hash + re-derive +
// run the four gates).
//
// What these PROVE is real: JWE/ECDH-ES decryption, the ISO-mdoc CBOR parse, and the
// amount/transaction_data hash BINDING (Gate 1 re-checks the wallet's signed hash
// equals SHA-256 of our transaction_data). What stays fenced (presence-only-demo) is
// the issuer/device COSE signature — these DeviceResponses are synthetic. The
// tampering test confirms a wallet hash bound to a DIFFERENT amount is REFUSED.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";
import { buildDcPaymentRequest } from "./request.js";
import { verifyDcPresentation } from "./verify.js";
import type { CeremonyCatalog, CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
const cbor = (v: unknown): Buffer => enc.encode(v);

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "127.0.0.1", origin: "http://127.0.0.1" };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const PRODUCTS: Record<string, { price: number }> = { "aurora-headphones": { price: 199 } };
const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal, discount: 0, total: round2(subtotal), currency: "USD" };
  },
};

const INSTRUMENT = {
  issuer_name: "Demo Bank",
  payment_instrument_id: "pi-77AABBCC",
  masked_account_reference: "•••• 4242",
  holder_name: "Demo Buyer",
  expiry_date: "2032-09-01",
};

// Build a synthetic ISO 18013-5 payment DeviceResponse: issuer-signed instrument
// claims + an issuerAuth + deviceAuth block + a deviceSigned transaction_data_hash.
// When `coseAlg` is given it also emits `transaction_data_hash_alg` (the COSE id),
// mirroring Multipaz's mdocPresentment.kt (which omits it for its SHA-256 default).
function paymentDeviceResponseB64(transactionDataHashHex: string | null, coseAlg?: number): string {
  const ns = "org.multipaz.payment.sca.1";
  const issuerItems = Object.entries(INSTRUMENT).map(([elementIdentifier, elementValue], digestID) =>
    new Tag(cbor({ digestID, random: Buffer.alloc(16), elementIdentifier, elementValue }), 24),
  );
  const deviceSignedNs = transactionDataHashHex
    ? new Tag(cbor({ "urn:eudi:sca:payment:1": {
        ...(coseAlg !== undefined ? { transaction_data_hash_alg: coseAlg } : {}),
        transaction_data_hash: Buffer.from(transactionDataHashHex, "hex"),
      } }), 24)
    : new Tag(cbor({}), 24);
  const dr = cbor({
    version: "1.0",
    documents: [{
      docType: ns,
      issuerSigned: {
        nameSpaces: { [ns]: issuerItems },
        // issuerAuth present (a COSE_Sign1 shape — structural presence only).
        issuerAuth: [Buffer.from("a10126", "hex"), new Map(), null, Buffer.alloc(64)],
      },
      deviceSigned: {
        nameSpaces: deviceSignedNs,
        deviceAuth: { deviceSignature: [Buffer.from("a10126", "hex"), new Map(), null, Buffer.alloc(64)] },
      },
    }],
    status: 0,
  });
  return Buffer.from(dr).toString("base64url");
}

async function walletEncrypt(encJwk: jose.JWK, dpc: string): Promise<string> {
  const pub = await jose.importJWK(encJwk, "ECDH-ES");
  return await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: { dpc: [dpc] } })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" })
    .encrypt(pub);
}

function encJwkOf(requestJwt: string): jose.JWK {
  const payload = jose.decodeJwt(requestJwt) as { client_metadata: { jwks: { keys: jose.JWK[] } } };
  return payload.client_metadata.jwks.keys[0];
}

// The wallet signs over SHA-256 of the transaction_data string (base64url), itself
// hex here so we can re-encode the bytes. extractTransactionDataHash returns it as
// base64url; the gate recomputes hashTransactionData (base64url) and compares.
function txHashHex(transactionDataB64: string): string {
  return createHash("sha256").update(transactionDataB64).digest("hex");
}

// Same, for an arbitrary SHA-2 algorithm (used to prove the gate honors the wallet's
// declared transaction_data_hash_alg rather than assuming SHA-256).
function txHashHexWith(alg: "sha256" | "sha384" | "sha512", transactionDataB64: string): string {
  return createHash(alg).update(transactionDataB64).digest("hex");
}

describe("dc-payment REAL OpenID4VP presentation", () => {
  it("decrypts the wallet response, re-derives the transaction_data hash, and passes all four gates", async () => {
    const order: CeremonyOrder = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RP1");
    const req = await buildDcPaymentRequest(order, ORIGIN, SECRET);
    const txDataB64 = req.transaction_data[0];
    const dpc = paymentDeviceResponseB64(txHashHex(txDataB64));
    const response = await walletEncrypt(encJwkOf(req.request), dpc);

    const out = await verifyDcPresentation({
      order,
      origin: ORIGIN,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    expect(out.mandate.trust_level).toBe("presence-only-demo");
    expect(out.mandate.payment.amount).toBe(199);
    expect(out.gates).toHaveLength(4);
    expect(out.gates.every((g) => g.pass)).toBe(true); // amount binding incl. the wallet-signed hash
  });

  it("REJECTS a wallet hash bound to a DIFFERENT transaction_data (the amount-binding gate fails)", async () => {
    const order: CeremonyOrder = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RP2");
    const req = await buildDcPaymentRequest(order, ORIGIN, SECRET);
    // The wallet signs over the hash of SOME OTHER transaction_data — not what we sent.
    const dpc = paymentDeviceResponseB64(txHashHex("a-different-transaction-data-string"));
    const response = await walletEncrypt(encJwkOf(req.request), dpc);

    const out = await verifyDcPresentation({
      order,
      origin: ORIGIN,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    const amountGate = out.gates.find((g) => g.gate === "Amount binding");
    expect(amountGate?.pass).toBe(false); // FAILS if the gate stopped re-checking the device-signed hash
  });

  it("REJECTS a DeviceResponse with no device-signed transaction_data_hash at all", async () => {
    const order: CeremonyOrder = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RP3");
    const req = await buildDcPaymentRequest(order, ORIGIN, SECRET);
    const dpc = paymentDeviceResponseB64(null); // no hash disclosed
    const response = await walletEncrypt(encJwkOf(req.request), dpc);

    const out = await verifyDcPresentation({
      order,
      origin: ORIGIN,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    expect(out.gates.find((g) => g.gate === "Amount binding")?.pass).toBe(false);
  });

  it("HONORS a non-SHA-256 transaction_data_hash_alg: a SHA-384-bound wallet response verifies", async () => {
    const order: CeremonyOrder = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RP4");
    const req = await buildDcPaymentRequest(order, ORIGIN, SECRET);
    const txDataB64 = req.transaction_data[0];
    // The wallet bound the hash with SHA-384 (COSE -43) and declared it. The gate must
    // recompute with SHA-384 — not assume SHA-256 — to match.
    const dpc = paymentDeviceResponseB64(txHashHexWith("sha384", txDataB64), -43);
    const response = await walletEncrypt(encJwkOf(req.request), dpc);

    const out = await verifyDcPresentation({
      order,
      origin: ORIGIN,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    // RED-ON-REVERT: if verify ignores transaction_data_hash_alg and recomputes SHA-256,
    // this SHA-384 hash will not match and the amount-binding gate fails.
    expect(out.gates.find((g) => g.gate === "Amount binding")?.pass).toBe(true);
    expect(out.gates.every((g) => g.pass)).toBe(true);
  });

  it("REFUSES an unknown transaction_data_hash_alg (fails closed — no silent SHA-256 fallback)", async () => {
    const order: CeremonyOrder = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RP5");
    const req = await buildDcPaymentRequest(order, ORIGIN, SECRET);
    const txDataB64 = req.transaction_data[0];
    // A CORRECT SHA-256 hash, but the declared algorithm is unrecognized (-999). The gate
    // cannot know which algorithm produced the hash, so it must refuse rather than assume.
    const dpc = paymentDeviceResponseB64(txHashHex(txDataB64), -999);
    const response = await walletEncrypt(encJwkOf(req.request), dpc);

    const out = await verifyDcPresentation({
      order,
      origin: ORIGIN,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    expect(out.gates.find((g) => g.gate === "Amount binding")?.pass).toBe(false);
  });
});
