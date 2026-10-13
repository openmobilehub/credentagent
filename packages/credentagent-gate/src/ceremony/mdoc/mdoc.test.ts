import { beforeEach, describe, expect, it, vi } from "vitest";
import { Encoder, Tag, decode } from "cbor-x";
import {
  decodeDeviceResponse,
  decodeVpToken,
  disclosedFromResponse,
  extractTransactionDataHash,
  extractTransactionDataHashAlg,
  inspectAuthBlocks,
  type MdocDocument,
} from "./mdoc.js";
import { disclosedFromDeviceResponse } from "./mdoc-iso.js";
import { buildDcMandateFromPresentation } from "../dc-payment/verify.js";

vi.mock("cbor-x", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cbor-x")>();
  return { ...actual, decode: vi.fn(actual.decode) };
});

const encoderOptions = { useRecords: false, variableMapSize: true, useTag259ForMaps: false };
const encoder = new Encoder(encoderOptions);
const cbor = (value: unknown): Buffer => encoder.encode(value);
const response = (documents: MdocDocument[]): Buffer => cbor({ version: "1.0", documents, status: 0 });

function document(docType: string, values: Record<string, unknown> = {}): MdocDocument {
  return {
    docType,
    issuerSigned: {
      nameSpaces: {
        [docType]: Object.entries(values).map(([elementIdentifier, elementValue], digestID) =>
          new Tag(cbor({ digestID, random: Buffer.alloc(16), elementIdentifier, elementValue }), 24)),
      },
    },
  };
}

beforeEach(() => { vi.mocked(decode).mockClear(); });

describe("shared mdoc parsing", () => {
  it("keeps all documents' claims in order and reports the last document's type", () => {
    const bytes = response([document("first", { value: true }), document("second", { value: false })]);
    expect(decodeVpToken({ mixed: bytes.toString("base64url") })).toEqual([{
      id: "mixed", format: "mso_mdoc", type: "second",
      claims: [{ label: "first / value", value: true }, { label: "second / value", value: false }],
    }]);
  });

  it("keeps each query's first presentation, including the legacy array shape", () => {
    const first = response([document("first", { value: true })]).toString("base64url");
    const second = response([document("second", { value: false })]).toString("base64url");
    const expected = [
      { id: "a", format: "mso_mdoc", type: "first", claims: [{ label: "first / value", value: true }] },
      { id: "b", format: "mso_mdoc", type: "second", claims: [{ label: "second / value", value: false }] },
    ];
    expect(decodeVpToken({ a: [first, "ignored"], b: second })).toEqual(expected);
    expect(decodeVpToken([first, second])).toEqual(expected.map((entry, i) => ({ ...entry, id: String(i) })));
  });

  it("preserves sanitized nested values without changing the original tagged bytes", () => {
    const bytes = response([document("doc", { facts: {
      bytes: Buffer.from([1, 2]),
      date: new Date("2020-01-02T00:00:00Z"),
      tagged: new Tag("2020-01-02", 1004),
      bigint: 9007199254740993n,
      nested: [Buffer.from([3])],
    } })]);
    const parsed = decodeDeviceResponse(bytes);
    const raw = parsed.documents![0].issuerSigned!.nameSpaces!.doc[0] as Tag;
    const originalBytes = Buffer.from(raw.value as Uint8Array);
    const disclosed = disclosedFromResponse(parsed, "query");
    expect(disclosed.claims).toEqual([{ label: "doc / facts", value: {
      bytes: { _bytes_b64url: "AQI" },
      date: "2020-01-02T00:00:00.000Z",
      tagged: { _tag: 1004, value: "2020-01-02" },
      bigint: "9007199254740993",
      nested: [{ _bytes_b64url: "Aw" }],
    } }]);
    expect(Buffer.from(raw.value as Uint8Array)).toEqual(originalBytes);
    expect(() => JSON.stringify(disclosed)).not.toThrow();
  });

  it("preserves the disclosure shape for both raw bytes and base64url input", () => {
    const bytes = response([document("doc", { positive: true })]);
    const expected = [{ id: "mdoc", format: "mso_mdoc", type: "doc", claims: [{ label: "doc / positive", value: true }] }];
    expect(disclosedFromDeviceResponse(bytes)).toEqual(expected);
    expect(decodeVpToken({ mdoc: bytes.toString("base64url") })).toEqual(expected);
  });

  it("preserves empty responses and a last document without a type", () => {
    expect(decodeVpToken(undefined)).toEqual([]);
    expect(disclosedFromDeviceResponse(response([]))).toEqual([{ id: "mdoc", format: "mso_mdoc", type: undefined, claims: [] }]);
    const parsed = decodeDeviceResponse(response([document("first"), {}]));
    expect(disclosedFromResponse(parsed, "query").type).toBeUndefined();
  });

  it("reads the first matching transaction hash and algorithm from mixed documents", () => {
    const namespace = "urn:eudi:sca:payment:1";
    const payment = (hash: unknown, alg: unknown): MdocDocument => ({
      deviceSigned: { nameSpaces: new Tag(cbor({ [namespace]: { transaction_data_hash: hash, transaction_data_hash_alg: alg } }), 24) },
    });
    const parsed = decodeDeviceResponse(response([
      payment("not bytes", "not a number"), payment(Buffer.from([1]), -43), payment(Buffer.from([2]), -44),
    ]));
    expect(extractTransactionDataHash(parsed)).toBe("AQ");
    expect(extractTransactionDataHashAlg(parsed)).toBe(-43);
  });

  it("inspects only the first document's auth blocks", () => {
    const parsed = decodeDeviceResponse(response([
      document("first"),
      { docType: "second", issuerSigned: { issuerAuth: [Buffer.alloc(64)] }, deviceSigned: { deviceAuth: { deviceSignature: [Buffer.alloc(64)] } } },
    ]));
    expect(inspectAuthBlocks(parsed)).toEqual({ hasIssuerAuth: false, hasDeviceAuth: false, docType: "first" });
    expect(inspectAuthBlocks({})).toEqual({ hasIssuerAuth: false, hasDeviceAuth: false, docType: null });
    expect(extractTransactionDataHash({})).toBeNull();
    expect(extractTransactionDataHashAlg({})).toBeNull();
  });

  it("decodes the payment response once for claims, auth blocks and transaction binding", () => {
    const doc = document("payment", { payment_instrument_id: "pi-1" });
    doc.issuerSigned!.issuerAuth = [Buffer.alloc(64)];
    doc.deviceSigned = {
      nameSpaces: new Tag(cbor({ "urn:eudi:sca:payment:1": { transaction_data_hash: Buffer.from([1]), transaction_data_hash_alg: -43 } }), 24),
      deviceAuth: { deviceSignature: [Buffer.alloc(64)] },
    };
    const bytes = response([doc]);
    const vpStr = bytes.toString("base64url");
    const mandate = buildDcMandateFromPresentation({
      order: { id: "ORD-PARSE", lines: [], subtotal: 0, discount: 0, total: 0, currency: "USD", itemCount: 0 },
      vpStr, transactionDataB64: "sealed-transaction-data",
    });
    expect(mandate.payment.instrument.instrumentId).toBe("pi-1");
    expect(mandate.userAuthorization).toMatchObject({
      vpToken: vpStr, transactionDataHash: "AQ", transactionDataHashAlg: -43,
      authBlocks: { hasIssuerAuth: true, hasDeviceAuth: true },
    });
    expect(vi.mocked(decode).mock.calls.filter(([input]) => Buffer.from(input).equals(bytes))).toHaveLength(1);
    expect(mandate.trust_level).toBe("presence-only-demo");
  });
});
