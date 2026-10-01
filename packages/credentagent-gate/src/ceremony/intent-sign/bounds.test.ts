// FR-1 stability tests for the canonical Intent-Mandate bounds encoding. The whole
// device-signature binding rests on /request and /verify producing the IDENTICAL
// boundsHash for the same grant — so this pins the encoding against drift in key
// order, array order, and number formatting. A change that alters these bytes would
// silently break every legitimate device signature; these tests catch it.
import { describe, it, expect } from "vitest";
import { canonicalIntentBounds, boundsHash, deriveNonce, type IntentBoundsInput } from "./bounds.js";

const BASE: IntentBoundsInput = {
  grantId: "grant_abc123",
  merchant: "utopia",
  budget: 200,
  perSpend: 130,
  allow: { categories: ["Beverages", "Electronics"], skus: [] },
  createdAt: "2026-07-28T00:00:00.000Z",
  nonce: "salt-01",
};

describe("canonicalIntentBounds — FR-1 stability", () => {
  it("is pinned byte-for-byte (a change here breaks every prior device signature)", () => {
    expect(canonicalIntentBounds(BASE)).toBe(
      '{"allow":{"categories":["Beverages","Electronics"],"skus":[]},"budget":200,"createdAt":"2026-07-28T00:00:00.000Z","grantId":"grant_abc123","merchant":"utopia","nonce":"salt-01","perSpend":130}',
    );
  });

  it("is independent of the input key order (recursive key sort)", () => {
    const reordered: IntentBoundsInput = {
      nonce: "salt-01",
      perSpend: 130,
      merchant: "utopia",
      createdAt: "2026-07-28T00:00:00.000Z",
      budget: 200,
      allow: { skus: [], categories: ["Beverages", "Electronics"] },
      grantId: "grant_abc123",
    };
    expect(canonicalIntentBounds(reordered)).toBe(canonicalIntentBounds(BASE));
  });

  it("sorts the allow arrays (order-independent)", () => {
    const shuffled: IntentBoundsInput = { ...BASE, allow: { categories: ["Electronics", "Beverages"], skus: [] } };
    expect(canonicalIntentBounds(shuffled)).toBe(canonicalIntentBounds(BASE));
    expect(boundsHash(shuffled)).toBe(boundsHash(BASE));
  });

  it("normalizes absent vs empty allow to the same bytes", () => {
    const noAllow: IntentBoundsInput = { ...BASE, allow: undefined };
    const emptyAllow: IntentBoundsInput = { ...BASE, allow: { skus: [], categories: [] } };
    expect(canonicalIntentBounds(noAllow)).toBe(canonicalIntentBounds(emptyAllow));
  });

  it("changes the hash when ANY bound changes (budget 200 → 2000)", () => {
    expect(boundsHash({ ...BASE, budget: 2000 })).not.toBe(boundsHash(BASE));
  });

  it("changes the hash when the per-grant salt changes", () => {
    expect(boundsHash({ ...BASE, nonce: "salt-02" })).not.toBe(boundsHash(BASE));
  });

  it("includes expiresAt only when present", () => {
    const withExpiry: IntentBoundsInput = { ...BASE, expiresAt: "2027-01-01T00:00:00.000Z" };
    expect(canonicalIntentBounds(withExpiry)).toContain('"expiresAt":"2027-01-01T00:00:00.000Z"');
    expect(canonicalIntentBounds(BASE)).not.toContain("expiresAt");
  });
});

// base64url of 16 random-ish bytes, the way request.ts mints the challenge.
const CHAL_A = Buffer.from("aaaaaaaaaaaaaaaa").toString("base64url");
const CHAL_B = Buffer.from("bbbbbbbbbbbbbbbb").toString("base64url");

describe("deriveNonce — bounds-bound ceremony nonce", () => {
  it("is deterministic in (challenge, boundsHash)", () => {
    const h = boundsHash(BASE);
    expect(deriveNonce(CHAL_A, h)).toBe(deriveNonce(CHAL_A, h));
  });

  it("differs when the challenge OR the boundsHash differ", () => {
    const h = boundsHash(BASE);
    const h2 = boundsHash({ ...BASE, budget: 2000 });
    expect(deriveNonce(CHAL_A, h)).not.toBe(deriveNonce(CHAL_B, h));
    expect(deriveNonce(CHAL_A, h)).not.toBe(deriveNonce(CHAL_A, h2));
  });
});

// ── #172: the wallet credentials the human presents before signing are TERMS ────────────────
// The page shows them, so the signature has to cover them. Without that, a claim recorded between
// /request and /verify would ride a signature the human gave for different terms — and the grant
// would authorize carrying a proof they never saw. Each of these goes red if the corresponding
// field is dropped from `canonicalIntentBounds`.
describe("canonicalIntentBounds — wallet credentials are inside the signed bytes (#172)", () => {
  it("a grant with NO credentials hashes exactly as it did before the fields existed", () => {
    // Additive by construction: absent ⇒ omitted from the bytes, so main's pins above still hold.
    expect(canonicalIntentBounds(BASE)).toBe(canonicalIntentBounds({ ...BASE, ageProof: undefined, membershipProof: undefined }));
  });

  it("BYPASS: attaching an age proof CHANGES the hash — a signature given without it stops verifying", () => {
    const before = boundsHash(BASE);
    const after = boundsHash({ ...BASE, ageProof: { provenAge: 21 } });
    expect(after).not.toBe(before);
  });

  it("BYPASS: raising the proven age CHANGES the hash — 18+ and 21+ are different terms", () => {
    expect(boundsHash({ ...BASE, ageProof: { provenAge: 18 } })).not.toBe(boundsHash({ ...BASE, ageProof: { provenAge: 21 } }));
  });

  it("BYPASS: attaching a membership, or moving its rate, CHANGES the hash", () => {
    const none = boundsHash(BASE);
    const ten = boundsHash({ ...BASE, membershipProof: { membershipNumber: "GOLD-1", discountPct: 10 } });
    const fifty = boundsHash({ ...BASE, membershipProof: { membershipNumber: "GOLD-1", discountPct: 50 } });
    expect(ten).not.toBe(none);
    expect(fifty).not.toBe(ten); // the RATE is a term, not a detail
  });

  it("is stable across the two round trips: the same credentials re-encode identically", () => {
    // /request seals the nonce from these bytes and /verify re-derives them from the same record;
    // an audit timestamp inside would make the two disagree, which is why only terms are encoded.
    const withCreds = { ...BASE, ageProof: { provenAge: 21 }, membershipProof: { membershipNumber: "GOLD-1", discountPct: 10 } };
    expect(canonicalIntentBounds(withCreds)).toBe(canonicalIntentBounds({ ...withCreds }));
  });
});
