import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { usd } from "./money.js";
import type { GrantRecord } from "./grants.js";
import type { OrderStore } from "./orders.js";

const terms = () => ({ merchant: "utopia", budget: usd.dollars(100), perSpend: usd.dollars(30) });

describe("credentagent.grants — create / retrieve (the pending lifecycle)", () => {
  it("create() returns a pending grant with an approveUrl on this origin, terms echoed as Money", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const g = await ca.grants.create({ ...terms(), policy: [] });
    expect(g.id).toMatch(/^gr_/);
    expect(g.status).toBe("pending");
    expect(g.approveUrl).toBe(`https://shop.example/credentagent/grants/${g.id}`);
    expect(g.terms.budget.eq(usd.dollars(100))).toBe(true);
    expect(g.terms.perSpend.eq(usd.dollars(30))).toBe(true);
    expect(g.terms.merchant).toBe("utopia");
  });

  // Same control as orders.create: the approveUrl is only usable if the grant is READABLE
  // when it's handed out. Delete the `await` on the store write and this goes red.
  it("create() resolves only after the grant is persisted (async store)", async () => {
    const backing = new Map<string, GrantRecord>();
    const slowStore: OrderStore<GrantRecord> = {
      read: async (id) => backing.get(id),
      write: async (id, v) => {
        await new Promise((r) => setTimeout(r, 5));
        backing.set(id, v);
      },
      clear: async (id) => {
        backing.delete(id);
      },
    };
    const ca = new CredentAgent({ walletOrigin: "https://shop.example", grantStore: slowStore });
    const { id } = await ca.grants.create({ ...terms(), policy: [] });
    expect(backing.has(id)).toBe(true);
  });

  it("retrieve() rehydrates by id; an unknown id is a typed not-found, never a throw", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const { id } = await ca.grants.create({ ...terms(), policy: [] });
    const g = await ca.grants.retrieve(id);
    expect(g.status).toBe("pending");
    expect(g.id).toBe(id);
    expect((await ca.grants.retrieve("gr_nope")).status).toBe("not-found");
  });

  it("scopes per grant: two grants are isolated records (invariant 4)", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const a = await ca.grants.create({ ...terms(), policy: [] });
    const b = await ca.grants.create({ ...terms(), policy: [] });
    expect(a.id).not.toBe(b.id);
    expect((await ca.grants.retrieve(a.id)).id).toBe(a.id);
    expect((await ca.grants.retrieve(b.id)).id).toBe(b.id);
  });
});

// The spend catalog: prices live server-side; wine is age-restricted (21+).
const CATALOG = { coffee: 18, espresso: 25, wine: { price: 20, minAge: 21 } };
const client = () => new CredentAgent({ walletOrigin: "https://shop.example", catalog: CATALOG });
async function authorizedGrant(ca: CredentAgent, over: Partial<Parameters<typeof ca.grants.create>[0]> = {}) {
  const { id } = await ca.grants.create({ merchant: "utopia", budget: usd.dollars(40), perSpend: usd.dollars(20), policy: [], ...over });
  await ca.grants._authorize(id); // what the approve ceremony does when the human approves
  return ca.grants.retrieve(id);
}

describe("grant.spend() — the delegated draw door", () => {
  it("spends against the catalog price; remaining is Money and draws down", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    const s = await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.amount.eq(usd.dollars(18))).toBe(true);       // priced by the gate, never the caller
      expect(s.remaining.eq(usd.dollars(22))).toBe(true);    // 40 − 18
      expect(s.authorization).toBe("delegated");
      expect(s.trustLevel).toBe("server-issued-demo");       // honesty: server-minted key, no real value
      expect(s.mandateBundle.intentMandate.intentId).toBeTruthy();
    }
  });

  // BYPASS (budget): a spend that would exceed the cumulative budget is refused. Delete the
  // over-total → budget-exceeded path (or the engine's over-total check) and this goes red.
  it("BYPASS: refuses beyond the cumulative budget — code budget-exceeded", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    expect((await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] })).ok).toBe(true);
    expect((await g.spend({ idempotencyKey: "p2", items: [{ sku: "coffee" }] })).ok).toBe(true); // 36 of 40
    const third = await g.spend({ idempotencyKey: "p3", items: [{ sku: "coffee" }] });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("budget-exceeded");
    // and the refusal did NOT draw down the budget:
    const again = await g.spend({ idempotencyKey: "p4", items: [{ sku: "coffee" }] });
    expect(again.ok).toBe(false); // still over — but remaining stayed 4
    if (!again.ok) expect(again.remaining.eq(usd.dollars(4))).toBe(true);
  });

  // BYPASS (per-spend): one purchase over the per-spend ceiling is refused outright.
  it("BYPASS: refuses a single spend over perSpend — code per-spend-exceeded", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    const s = await g.spend({ idempotencyKey: "p1", items: [{ sku: "espresso" }] }); // 25 > 20
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.code).toBe("per-spend-exceeded");
  });

  // BYPASS (lifecycle): an unapproved grant must never sign a draw. Delete the status gate
  // in spend() and this goes red (the draw would run and complete).
  it("BYPASS: a PENDING grant refuses to spend — code not-authorized, no draw committed", async () => {
    const ca = client();
    const { id } = await ca.grants.create({ merchant: "utopia", budget: usd.dollars(40), perSpend: usd.dollars(20), policy: [] });
    const g = await ca.grants.retrieve(id);
    const s = await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.code).toBe("not-authorized");
      expect(s.remaining.eq(usd.dollars(40))).toBe(true); // untouched
    }
  });

  // BYPASS (invariant 5 / #104): age is NEVER on autopilot — an age-restricted item steps up
  // to a live human. Pins the shared completion-seam control from the grants surface.
  it("BYPASS: an age-restricted item refuses on autopilot — step-up, needs-human", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    const s = await g.spend({ idempotencyKey: "p1", items: [{ sku: "wine" }] });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.code).toBe("step-up");
      expect(s.retryable).toBe("needs-human");
    }
  });

  it("replays safely: the SAME idempotencyKey returns the original result once-charged", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    const first = await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    const retry = await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    expect(first.ok && retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.replayed).toBe(true);
      expect(retry.amount.eq(usd.dollars(18))).toBe(true);
      expect(retry.remaining.eq(usd.dollars(22))).toBe(true); // ONE charge — not 40−36
    }
    if (first.ok) expect(first.replayed).toBeUndefined();
  });

  it("distinct keys are distinct draws (two spends draw down twice)", async () => {
    const ca = client();
    const g = await authorizedGrant(ca);
    await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    const second = await g.spend({ idempotencyKey: "p2", items: [{ sku: "coffee" }] });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.remaining.eq(usd.dollars(4))).toBe(true);
  });

  it("scopes per grant: spending on A never draws down B (invariant 4)", async () => {
    const ca = client();
    const a = await authorizedGrant(ca);
    const b = await authorizedGrant(ca);
    await a.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    const sb = await b.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] }); // same key — different grant namespace
    expect(sb.ok).toBe(true);
    if (sb.ok) expect(sb.remaining.eq(usd.dollars(22))).toBe(true); // B's own 40 − 18
  });

  it("a completed spend fires order.settled with the spend's namespaced order id", async () => {
    const ca = client();
    const seen: string[] = [];
    ca.on("order.settled", ({ id }) => seen.push(id));
    const g = await authorizedGrant(ca);
    await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] });
    expect(seen).toEqual([`${g.id}-p1`]);
  });

  it("spend without a configured catalog throws a clear config error (programming error, not a refusal)", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" }); // no catalog
    const { id } = await ca.grants.create({ merchant: "utopia", budget: usd.dollars(40), perSpend: usd.dollars(20), policy: [] });
    await ca.grants._authorize(id);
    const g = await ca.grants.retrieve(id);
    await expect(g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] })).rejects.toThrow(/catalog/);
  });
});
