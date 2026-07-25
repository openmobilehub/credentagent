import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import type { Grant } from "./grants.js";

// A priced catalog in dollars — the ONE price source. wine is age-restricted (non-delegable);
// headphones sit OUTSIDE the Beverages allow-bounds used below.
const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  "espresso-machine": { price: 45, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages" },
  headphones: { price: 40, category: "Electronics" },
};

const client = () => new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG });

/** create + approve (the demo authorize seam) in one step, for tests past the lifecycle. */
async function authorizedGrant(ca: CredentAgent, allow?: { skus?: string[]; categories?: string[] }): Promise<Grant> {
  const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, ...(allow ? { allow } : {}) });
  await ca.grants._authorize(g.id);
  return (await ca.grants.retrieve(g.id))!;
}

describe("credentagent.grants — lifecycle (FR-007)", () => {
  it("create() returns a pending grant with an id + approveUrl; authorize flips it", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(g.id).toMatch(/^grant_/);
    expect(g.status).toBe("pending");
    expect(g.approveUrl).toContain(`/credentagent/grants/${g.id}`);
    await ca.grants._authorize(g.id);
    expect((await ca.grants.retrieve(g.id))!.status).toBe("authorized");
  });

  // BYPASS (status gate — NEW control in grants.ts): a grant the human never approved must not
  // spend. Delete the `rec.status !== "authorized"` check and this goes red: a pending grant
  // would reach the engine... which was never minted — worse, an attacker-created record spends.
  it("BYPASS: a PENDING grant cannot spend — refused not-authorized", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    const s = await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: false, code: "not-authorized" });
  });

  it("denied is TERMINAL: authorize after deny fails; spending refuses", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(await ca.grants._deny(g.id)).toBe(true);
    expect(await ca.grants._authorize(g.id)).toBe(false); // never authorizable after deny
    const s = await (await ca.grants.retrieve(g.id))!.spend({ idempotencyKey: "d1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: false, code: "not-authorized" });
  });
});

describe("credentagent.grants — the sealed bounds enforce", () => {
  it("an allowed spend succeeds: server-priced amount, remaining drawdown, delegated authorization", async () => {
    const g = await authorizedGrant(client());
    const s = await g.spend({ idempotencyKey: "s1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: true, amount: 18, remaining: 82, authorization: "delegated", replayed: false });
  });

  // BYPASS (allow bounds — NEW control in grants.ts): the grant bounds WHAT may be bought, not
  // just how much (#95 review). Delete the `allowed()` check and this goes red: headphones —
  // outside the Beverages bounds, well under every cap — would be bought while the human is away.
  it("BYPASS: an item outside the allow bounds is refused not-allowed (money caps alone don't save it)", async () => {
    const g = await authorizedGrant(client(), { categories: ["Beverages"] });
    const s = await g.spend({ idempotencyKey: "a1", items: [{ sku: "headphones" }] });
    expect(s).toMatchObject({ ok: false, code: "not-allowed" });
    // …while a Beverages item passes the same bounds:
    expect(await g.spend({ idempotencyKey: "a2", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true });
  });

  it("maps the engine caps to the door vocabulary: per-spend-exceeded / budget-exceeded", async () => {
    const g = await authorizedGrant(client());
    // one $45 purchase > $30 per-spend cap
    expect(await g.spend({ idempotencyKey: "c1", items: [{ sku: "espresso-machine" }] })).toMatchObject({ ok: false, code: "per-spend-exceeded" });
    // five $18 coffees = $90 ok; the sixth would cross the $100 budget
    for (let i = 0; i < 5; i++) expect((await g.spend({ idempotencyKey: `b${i}`, items: [{ sku: "coffee" }] })).ok).toBe(true);
    expect(await g.spend({ idempotencyKey: "b5", items: [{ sku: "coffee" }] })).toMatchObject({ ok: false, code: "budget-exceeded" });
  });

  it("age is NON-delegable: wine refuses step-up (needs a live human) even under every cap", async () => {
    const g = await authorizedGrant(client());
    const s = await g.spend({ idempotencyKey: "w1", items: [{ sku: "wine" }] });
    expect(s).toMatchObject({ ok: false, code: "step-up", retryable: "needs-human" });
  });

  it("revoke(): the very next spend is refused revoked, fail-closed", async () => {
    const g = await authorizedGrant(client());
    expect((await g.spend({ idempotencyKey: "r1", items: [{ sku: "coffee" }] })).ok).toBe(true);
    await g.revoke();
    expect(g.status).toBe("revoked");
    expect(await g.spend({ idempotencyKey: "r2", items: [{ sku: "coffee" }] })).toMatchObject({ ok: false, code: "revoked" });
  });

  it("idempotent replay: the same key echoes the ORIGINAL outcome and never double-draws the budget", async () => {
    const g = await authorizedGrant(client());
    const first = await g.spend({ idempotencyKey: "same", items: [{ sku: "coffee" }] });
    const again = await g.spend({ idempotencyKey: "same", items: [{ sku: "coffee" }] });
    expect(first).toMatchObject({ ok: true, remaining: 82, replayed: false });
    expect(again).toMatchObject({ ok: true, remaining: 82, replayed: true }); // remaining unchanged — charged once
  });
});
