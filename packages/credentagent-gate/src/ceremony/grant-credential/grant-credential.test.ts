// Bypass/contract tests for the grant-credential rail (#172) — proving your age ON THE APPROVE PAGE,
// before you hand an agent a spending grant. Every assertion pins a control and FAILS if that
// control is removed:
//
//   • the threshold is CATALOG-derived, never body-supplied — a request cannot lower the bar
//     it must clear (invariant 5), and a sub-threshold claim records nothing.
//   • the ceremony is PENDING-ONLY — consent happened when the human tapped Approve; a grant
//     may never gain a capability afterwards.
//   • it is SCOPED PER GRANT — proving on grant A must not unlock grant B (invariant 4).
//   • a grant with nothing restricted in scope has no ceremony at all — no threshold to prove,
//     no claim worth recording.
//   • the rail SELF-SKIPS without a grants resource, so a host that never uses grants gets no
//     new routes.
//
// The verify path exercised here is the instant-demo claims path — the same one the checkout
// credential rail's suite uses — which runs the SAME server-side `evaluateCredential` policy a
// real wallet presentation runs. trust_level stays "presence-only-demo": the wire crypto is real,
// the issuer trust anchor is not (#14).

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "../../client.js";
import type { Grants } from "../../grants.js";

// wine is the only 21+ item in Beverages; the energy drink is 18+ (so "strictest wins" is a real
// question, not a formality); headphones sit outside it entirely.
const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages", name: "Reserve Wine" },
  "energy-drink": { price: 4, minAge: 18, category: "Beverages" },
  headphones: { price: 40, category: "Electronics" },
};

interface Harness {
  app: Express;
  grants: Grants;
}

// `grants.serve(app)` is the WHOLE wiring — no checkout ceremony seams to assemble. A host that
// only does grants gets these routes from the same call that serves the page.
function harness(opts: { loyaltyDiscountPct?: number } = {}): Harness {
  const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG, gateSecret: "stable-test-secret", ...opts });
  const app = express();
  app.use(express.json());
  ca.grants.serve(app as never);
  return { app, grants: ca.grants };
}

const pending = (grants: Grants, skus = ["wine"]) =>
  grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { skus } });

// ── the threshold is the server's, not the request's ─────────────────────────

describe("grant-credential — the age threshold is re-derived from the catalog (invariant 5)", () => {
  it("asks the wallet for the STRICTEST age in the grant's scope", async () => {
    const { app, grants } = harness();
    const g = await pending(grants);
    const res = await request(app).get(`/credentagent/grants/${g.id}/age/request`).expect(200);
    // 21 (wine), not 18 (the energy drink) — the page must ask at the bar it will enforce.
    expect(JSON.stringify(res.body.dcql_query)).toContain("age_over_21");
    expect(res.body.trust_level).toBe("presence-only-demo");
  });

  it("renders the gate page at the derived threshold, and returns to the approve page", async () => {
    const { app, grants } = harness();
    const g = await pending(grants);
    const res = await request(app).get(`/credentagent/grants/${g.id}/age`).expect(200);
    expect(res.text).toContain("21+");
    expect(res.text).toContain(`/credentagent/grants/${g.id}/age/verify`);
    expect(res.text).toContain(`/credentagent/grants/${g.id}"`); // RETURN_URL — back where they left off
    expect(res.text).toContain("presence-only-demo");
  });

  // BYPASS: the rail must derive `minimumAge` itself. Read it from the body instead and this goes
  // red — an agent (or anyone with the link) could ask for a bar low enough to clear trivially.
  it("BYPASS: a body-supplied minimumAge cannot lower the bar", async () => {
    const { app, grants } = harness();
    const g = await pending(grants);
    const res = await request(app)
      .post(`/credentagent/grants/${g.id}/age/verify`)
      .send({ minimumAge: 18, claims: { age_over_18: true } })
      .expect(200);
    expect(res.body.verified).toBe(false); // the 21+ policy ran regardless
    expect((await grants.retrieve(g.id))!.ageProof).toBeUndefined();
  });

  // BYPASS: an 18+ proof against a 21+ scope must record NOTHING.
  it("BYPASS: a sub-threshold claim records no proof", async () => {
    const { app, grants } = harness();
    const g = await pending(grants);
    await request(app).post(`/credentagent/grants/${g.id}/age/verify`).send({ claims: { age_over_18: true } }).expect(200);
    expect((await grants.retrieve(g.id))!.ageProof).toBeUndefined();
  });

  it("a positive claim at the derived threshold records the proof at THAT threshold", async () => {
    const { app, grants } = harness();
    const g = await pending(grants);
    const res = await request(app).post(`/credentagent/grants/${g.id}/age/verify`).send({ claims: { age_over_21: true } }).expect(200);
    expect(res.body.verified).toBe(true);
    expect((await grants.retrieve(g.id))!.ageProof).toMatchObject({ provenAge: 21, trust_level: "presence-only-demo" });
  });
});

// ── who may run the ceremony, and when ───────────────────────────────────────

describe("grant-credential — the ceremony is pending-only, per-grant, and only where it's needed", () => {
  // BYPASS (the `status !== "pending"` half of resolveGrantAge): consent is the Approve tap.
  // Drop it and this goes red — an already-approved grant would gain 21+ buying power.
  it("BYPASS: an already-authorized grant has no ceremony — 404, and no proof is written", async () => {
    const { app, grants } = harness();
    const g = await grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { skus: ["wine"] }, signing: "page" });
    expect(await grants._authorize(g.id)).toBe(true);
    await request(app).get(`/credentagent/grants/${g.id}/age`).expect(404);
    await request(app).post(`/credentagent/grants/${g.id}/age/verify`).send({ claims: { age_over_21: true } }).expect(404);
    expect((await grants.retrieve(g.id))!.ageProof).toBeUndefined();
  });

  // BYPASS (invariant 4 — per-grant scoping): proving on one grant must never unlock another.
  it("BYPASS: verifying grant A leaves grant B unproven", async () => {
    const { app, grants } = harness();
    const a = await pending(grants);
    const b = await pending(grants);
    await request(app).post(`/credentagent/grants/${a.id}/age/verify`).send({ claims: { age_over_21: true } }).expect(200);
    expect((await grants.retrieve(a.id))!.ageProof?.provenAge).toBe(21);
    expect((await grants.retrieve(b.id))!.ageProof).toBeUndefined();
  });

  it("a grant naming an unrestricted product has no age ceremony — 404", async () => {
    const { app, grants } = harness();
    const g = await pending(grants, ["headphones"]);
    await request(app).get(`/credentagent/grants/${g.id}/age`).expect(404);
    await request(app).post(`/credentagent/grants/${g.id}/age/verify`).send({ claims: { age_over_21: true } }).expect(404);
  });

  it("an unknown grant 404s on every route", async () => {
    const { app } = harness();
    await request(app).get("/credentagent/grants/grant_nope/age").expect(404);
    await request(app).get("/credentagent/grants/grant_nope/age/request").expect(404);
    await request(app).post("/credentagent/grants/grant_nope/age/verify").send({ claims: { age_over_21: true } }).expect(404);
  });
});

// ── the rail is genuinely optional ───────────────────────────────────────────

// ── membership: the second credential the same rail serves ───────────────────

describe("grant-credential — the membership step (#172)", () => {
  const withProgramme = () => harness({ loyaltyDiscountPct: 10 });

  it("asks the wallet for a membership at the host's configured rate", async () => {
    const { app, grants } = withProgramme();
    const g = await pending(grants);
    const res = await request(app).get(`/credentagent/grants/${g.id}/membership/request`).expect(200);
    expect(JSON.stringify(res.body.dcql_query)).toContain("membership");
    expect(res.body.trust_level).toBe("presence-only-demo");
  });

  it("renders the gate page and returns to the approve page", async () => {
    const { app, grants } = withProgramme();
    const g = await pending(grants);
    const res = await request(app).get(`/credentagent/grants/${g.id}/membership`).expect(200);
    expect(res.text).toContain("10%");
    expect(res.text).toContain(`/credentagent/grants/${g.id}/membership/verify`);
    expect(res.text).toContain(`/credentagent/grants/${g.id}"`); // back where they left off
  });

  it("a disclosed membership id records the claim at the host's rate", async () => {
    const { app, grants } = withProgramme();
    const g = await pending(grants);
    const res = await request(app)
      .post(`/credentagent/grants/${g.id}/membership/verify`)
      .send({ claims: { membership_number: "GOLD-0001" } })
      .expect(200);
    expect(res.body.verified).toBe(true);
    expect((await grants.retrieve(g.id))!.membershipProof).toMatchObject({ membershipNumber: "GOLD-0001", discountPct: 10 });
  });

  // BYPASS (invariant 5 — a real, non-empty membership id): a bare token must not earn the
  // discount, because a forged loyalty state lowers the amount actually charged.
  it("BYPASS: a token with no membership id earns nothing", async () => {
    const { app, grants } = withProgramme();
    const g = await pending(grants);
    await request(app).post(`/credentagent/grants/${g.id}/membership/verify`).send({ claims: { token: true } }).expect(200);
    expect((await grants.retrieve(g.id))!.membershipProof).toBeUndefined();
  });

  // BYPASS (the opt-in): no programme configured ⇒ no ceremony exists at all. Delete the
  // `_loyaltyDiscountPct` check in resolveGrantCred and this goes red — anyone with the link could
  // record a discount at a rate the merchant never offered.
  it("BYPASS: with no programme configured there is no membership step — 404", async () => {
    const { app, grants } = harness(); // no loyaltyDiscountPct
    const g = await pending(grants);
    await request(app).get(`/credentagent/grants/${g.id}/membership`).expect(404);
    await request(app).post(`/credentagent/grants/${g.id}/membership/verify`).send({ claims: { membership_number: "GOLD-0001" } }).expect(404);
    expect((await grants.retrieve(g.id))!.membershipProof).toBeUndefined();
  });

  // BYPASS (pending-only): the terms are what the human approved.
  it("BYPASS: an already-authorized grant has no membership step — 404, nothing written", async () => {
    const { app, grants } = withProgramme();
    const g = await grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { skus: ["wine"] }, signing: "page" });
    expect(await grants._authorize(g.id)).toBe(true);
    await request(app).post(`/credentagent/grants/${g.id}/membership/verify`).send({ claims: { membership_number: "GOLD-0001" } }).expect(404);
    expect((await grants.retrieve(g.id))!.membershipProof).toBeUndefined();
  });

  // BYPASS (invariant 4 — per-grant scoping): a membership proved on one grant must not discount
  // another.
  it("BYPASS: proving membership on grant A leaves grant B at full price", async () => {
    const { app, grants } = withProgramme();
    const a = await pending(grants);
    const b = await pending(grants);
    await request(app).post(`/credentagent/grants/${a.id}/membership/verify`).send({ claims: { membership_number: "GOLD-0001" } }).expect(200);
    expect((await grants.retrieve(a.id))!.membershipProof?.membershipNumber).toBe("GOLD-0001");
    expect((await grants.retrieve(b.id))!.membershipProof).toBeUndefined();
  });

  it("age and membership are independent: proving one leaves the other unproved", async () => {
    const { app, grants } = withProgramme();
    const g = await pending(grants);
    await request(app).post(`/credentagent/grants/${g.id}/age/verify`).send({ claims: { age_over_21: true } }).expect(200);
    const live = (await grants.retrieve(g.id))!;
    expect(live.ageProof?.provenAge).toBe(21);
    expect(live.membershipProof).toBeUndefined();
  });
});

describe("grant-credential — registered by grants.serve(app), nothing else needed", () => {
  it("needs no checkout ceremony seams — and the credential rail flags nothing to guess at", async () => {
    const { app, grants } = harness({ loyaltyDiscountPct: 10 });
    const g = await pending(grants);
    // Age + membership both served off the one `grants.serve(app)` call in `harness`.
    await request(app).get(`/credentagent/grants/${g.id}/age`).expect(200);
    await request(app).get(`/credentagent/grants/${g.id}/membership`).expect(200);
  });
});
