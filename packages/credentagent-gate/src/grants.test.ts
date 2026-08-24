import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { grantLifecycle } from "./grants.js";
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

  // BYPASS (#112 P2 — refusal replay): a REFUSED key must replay the refusal, never be repurposed.
  // Revert the cache check to successes-only and this goes red: the refused key buys the coffee.
  it("BYPASS: a refused idempotency key cannot be repurposed with a cheaper item", async () => {
    const g = await authorizedGrant(client());
    const refused = await g.spend({ idempotencyKey: "k", items: [{ sku: "espresso-machine" }] }); // $45 > $30 cap
    expect(refused).toMatchObject({ ok: false, code: "per-spend-exceeded" });
    const reused = await g.spend({ idempotencyKey: "k", items: [{ sku: "coffee" }] }); // same key, cheaper item
    expect(reused).toMatchObject({ ok: false, code: "per-spend-exceeded", replayed: true }); // the ORIGINAL refusal
    // …and the budget was never touched by either call:
    expect(await g.spend({ idempotencyKey: "k2", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true, remaining: 82 });
  });

  // BYPASS (#112 P1 — sealed bounds are immutable): mutating grant.allow after approval must not
  // widen enforcement. Remove the deepFreeze snapshot and this goes red: the push succeeds and
  // headphones — outside what the human approved — get bought.
  it("BYPASS: mutating grant.allow after approval cannot widen the sealed bounds", async () => {
    const g = await authorizedGrant(client(), { categories: ["Beverages"] });
    expect(() => g.allow!.categories!.push("Electronics")).toThrow(); // frozen — the mutation itself fails
    const s = await g.spend({ idempotencyKey: "m1", items: [{ sku: "headphones" }] });
    expect(s).toMatchObject({ ok: false, code: "not-allowed" }); // …and enforcement is unchanged
  });

  it("a multi-item or empty spend refuses invalid-request — no item is silently dropped (#112 P2)", async () => {
    const g = await authorizedGrant(client());
    expect(await g.spend({ idempotencyKey: "x1", items: [{ sku: "coffee" }, { sku: "wine" }] })).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await g.spend({ idempotencyKey: "x2", items: [] })).toMatchObject({ ok: false, code: "invalid-request" });
    // invalid-request does NOT consume the key — a corrected retry proceeds:
    expect(await g.spend({ idempotencyKey: "x1", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true });
  });

  it("a zero-qty spend refuses invalid-amount — never misreported as revoked (#112 P2)", async () => {
    const g = await authorizedGrant(client());
    const s = await g.spend({ idempotencyKey: "z1", items: [{ sku: "coffee", qty: 0 }] });
    expect(s).toMatchObject({ ok: false, code: "invalid-amount" });
    expect((await g.spend({ idempotencyKey: "z2", items: [{ sku: "coffee" }] })).ok).toBe(true); // still authorized
  });
});

describe("credentagent.grants — the approve page (grants.serve, #112 P1)", () => {
  function fakeApp() {
    const get = new Map<string, Function>();
    const post = new Map<string, Function>();
    return { get(p: string, ...h: unknown[]) { get.set(p, h[h.length - 1] as Function); }, post(p: string, ...h: unknown[]) { post.set(p, h[h.length - 1] as Function); }, _get: get, _post: post };
  }
  function fakeRes() {
    const r: any = { _status: 200, _body: "", _redirect: null };
    r.status = (c: number) => { r._status = c; return r; };
    r.type = () => r;
    r.send = (b: string) => { r._body = b; return r; };
    r.redirect = (c: number, url: string) => { r._redirect = { c, url }; };
    return r;
  }

  it("approveUrl serves a real page; POST approve authorizes; deny denies; unknown 404s", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] } });

    let res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toContain("Approve"); // the pending page offers the choice
    expect(res._body).toContain("$100");

    await app._post.get("/credentagent/grants/:id/approve")!({ params: { id: g.id } }, fakeRes());
    expect((await ca.grants.retrieve(g.id))!.status).toBe("authorized");

    const g2 = await ca.grants.create({ merchant: "utopia", budget: 50, perSpend: 10 });
    await app._post.get("/credentagent/grants/:id/deny")!({ params: { id: g2.id } }, fakeRes());
    expect((await ca.grants.retrieve(g2.id))!.status).toBe("denied");

    res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: "grant_nope" } }, res);
    expect(res._status).toBe(404);
  });
});

// ── Ported from the closed PR #106 (issue #104): concurrency + money-boundary coverage the
// merged suite lacked — which is exactly why the two bugs below shipped. Each BYPASS test goes
// red if its control is reverted (see the per-test note).
describe("credentagent.grants — concurrency + money boundary (#104 port-forward)", () => {
  // BYPASS (#104 fix 1 — per-grant serialization): two same-key spends that overlap in time both
  // miss the idempotency cache and reach the engine; without the per-grant lock the loser comes
  // back from the atomic single-use ledger as `consumed` → misreported "revoked"/terminal, even
  // though nothing was revoked and the purchase succeeded once. Remove `this.locks.run(...)` around
  // the spend body in grants.ts and this goes red (one result is { ok:false, code:"revoked" }).
  it("BYPASS: concurrent SAME-key spends collapse to one charge — both ok, one replayed, never a false 'revoked'", async () => {
    const g = await authorizedGrant(client());
    const [a, b] = await Promise.all([
      g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] }),
      g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] }),
    ]);
    expect(a.ok && b.ok).toBe(true); // neither is a spurious refusal
    expect([a, b].filter((r) => r.ok && r.replayed).length).toBe(1); // exactly one is the replay
    // ONE charge: a follow-up spend sees 100 − 18 − 18 = 64.
    expect(await g.spend({ idempotencyKey: "p2", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true, remaining: 64 });
  });

  // BYPASS (#104 fix 1 — lifecycle serialization): a revoke landing WHILE an authorize is in flight
  // (its async key-gen not yet resolved) must never leave a spendable grant. Without the lock the
  // revoke sees no engine yet (skips the ledger) and sets status "revoked", then the in-flight
  // authorize resolves and overwrites it back to "authorized" with a live, un-revoked engine — a
  // spendable grant the human tried to kill. Remove the lock on _authorize / revoke and this goes
  // red (status "authorized", spend ok). Order matters: authorize is started first so it is mid-flight.
  it("BYPASS: a revoke landing while authorize is in flight never leaves a spendable grant", async () => {
    const ca = client();
    const gc = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    const g = (await ca.grants.retrieve(gc.id))!;
    await Promise.all([ca.grants._authorize(gc.id), g.revoke()]); // authorize in flight, revoke lands
    expect((await ca.grants.retrieve(gc.id))!.status).toBe("revoked");
    expect((await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] })).ok).toBe(false);
  });

  // BYPASS (#104 fix 2 — integer cents): 4.9 + 4.9 + 4.9 === 14.700000000000001 in binary float, so
  // priced in dollars the third spend is wrongly refused budget-exceeded. Priced in integer cents it
  // lands exactly on the budget. Revert grants.ts to feed the engine dollars (drop toCents/centsCatalog)
  // and this goes red (the third spend refuses). (Control now lives in toCents/centsCatalogView.)
  it("BYPASS: $4.90 × 3 spends exactly to a $14.70 budget without a false refusal", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: { latte: 4.9 } });
    const gc = await ca.grants.create({ merchant: "utopia", budget: 14.7, perSpend: 4.9 });
    await ca.grants._authorize(gc.id);
    const g = (await ca.grants.retrieve(gc.id))!;
    for (const k of ["a", "b", "c"]) {
      expect(await g.spend({ idempotencyKey: k, items: [{ sku: "latte" }] })).toMatchObject({ ok: true, amount: 4.9 });
    }
    expect(await g.spend({ idempotencyKey: "d", items: [{ sku: "latte" }] })).toMatchObject({ ok: false, code: "budget-exceeded" });
  });

  // Regression (not a lock bypass — the engine's atomic commit already prevents this): concurrent
  // DISTINCT-key spends against a budget with room for one must not both settle. Pins that porting
  // the lock did not weaken the engine's cumulative-cap atomicity.
  it("concurrent DISTINCT-key spends never exceed the budget (exactly one settles)", async () => {
    const ca = client();
    const gc = await ca.grants.create({ merchant: "utopia", budget: 20, perSpend: 20 }); // room for ONE $18
    await ca.grants._authorize(gc.id);
    const g = (await ca.grants.retrieve(gc.id))!;
    const [a, b] = await Promise.all([
      g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] }),
      g.spend({ idempotencyKey: "p2", items: [{ sku: "coffee" }] }),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  });

  // Regression: a concurrent double-approve seals one grant and the budget cap still holds (no
  // rebind to a fresh, empty ledger that would allow 2× the budget).
  it("a concurrent double-approve seals one grant; the budget cap still holds", async () => {
    const ca = client();
    const gc = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await Promise.all([ca.grants._authorize(gc.id), ca.grants._authorize(gc.id)]);
    const g = (await ca.grants.retrieve(gc.id))!;
    expect(g.status).toBe("authorized");
    for (let i = 0; i < 5; i++) expect((await g.spend({ idempotencyKey: `b${i}`, items: [{ sku: "coffee" }] })).ok).toBe(true); // 90 of 100
    expect(await g.spend({ idempotencyKey: "b5", items: [{ sku: "coffee" }] })).toMatchObject({ ok: false, code: "budget-exceeded" });
  });

  // BYPASS (#104 Codex P1 — revoke-wins mid-spend): a revoke landing WHILE a spend is in flight
  // must refuse that spend. The engine's ledger revoke runs OUTSIDE the per-grant queue, so the
  // in-flight spend's atomic settle-time re-check sees it. Move the ledger revoke back inside the
  // mutex (behind the spend) and this goes red — the spend settles before revoke commits.
  it("BYPASS: a revoke while a spend is IN FLIGHT refuses that spend (revoke-wins mid-spend)", async () => {
    const g = await authorizedGrant(client());
    const spendP = g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] }); // start, do NOT await
    await g.revoke(); // lands mid-flight
    const s = await spendP;
    expect(s.ok).toBe(false); // ok:true here would mean the spend settled after revoke (the regression)
    expect(s).toMatchObject({ code: "revoked" });
  });

  // BYPASS (#104 Codex P1 — live catalog): the engine re-prices per spend from the LIVE catalog,
  // so an in-memory price change is honoured and the sealed cap is enforced against it. Snapshot
  // the catalog at engine construction and this goes red (the later spends price at the stale $18).
  it("BYPASS: prices each spend from the LIVE catalog — a re-price is honoured and the cap enforced against it", async () => {
    const catalog: Record<string, { price: number; category: string }> = { coffee: { price: 18, category: "Beverages" } };
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog });
    const gc = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 40 });
    await ca.grants._authorize(gc.id);
    const g = (await ca.grants.retrieve(gc.id))!;
    expect(await g.spend({ idempotencyKey: "p1", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true, amount: 18 });
    catalog.coffee.price = 25; // host re-prices in memory
    expect(await g.spend({ idempotencyKey: "p2", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true, amount: 25 }); // NEW price, not a stale $18
    catalog.coffee.price = 50; // now above the $40 per-spend cap
    expect(await g.spend({ idempotencyKey: "p3", items: [{ sku: "coffee" }] })).toMatchObject({ ok: false, code: "per-spend-exceeded" }); // cap enforced against the live price
  });

  // BYPASS (#104 Codex P2 — sub-cent): a value that can't be represented in whole cents is rejected
  // with a clear error, never silently rounded. Make toCents round instead of throw and both legs
  // go red (create resolves; the sub-cent price prices as $0.01 instead of throwing).
  it("BYPASS: rejects sub-cent precision — at config for a cap, and when a sub-cent price is used", async () => {
    await expect(client().grants.create({ merchant: "utopia", budget: 100, perSpend: 0.006 })).rejects.toThrow(/sub-cent/);
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: { trinket: 0.006 } });
    const gc = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await ca.grants._authorize(gc.id);
    const g = (await ca.grants.retrieve(gc.id))!;
    await expect(g.spend({ idempotencyKey: "p1", items: [{ sku: "trinket" }] })).rejects.toThrow(/sub-cent/);
  });
});

// The grant-widget projection (spec 011) reads the live money via `grant.usage()` and derives the
// display lifecycle via `grantLifecycle()`. These are the authority the widget must NOT re-derive
// (A2) — so they are tested as first-class behavior here, at the gate.
describe("credentagent.grants — usage() live money read (spec 011 FR-1)", () => {
  it("a pending grant reads the full budget: spent 0, remaining = budget", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(await g.usage()).toEqual({ budget: 100, spent: 0, remaining: 100 });
  });

  it("usage() draws down as the grant spends, reading the SAME ledger spend() returns", async () => {
    const g = await authorizedGrant(client());
    expect(await g.usage()).toEqual({ budget: 100, spent: 0, remaining: 100 });
    const s = await g.spend({ idempotencyKey: "u1", items: [{ sku: "coffee" }] }); // $18
    expect(s).toMatchObject({ ok: true, remaining: 82 });
    expect(await g.usage()).toEqual({ budget: 100, spent: 18, remaining: 82 });
  });

  it("a revoked grant still reports what was spent before it was stopped", async () => {
    const g = await authorizedGrant(client());
    await g.spend({ idempotencyKey: "u2", items: [{ sku: "coffee" }] }); // $18
    await g.revoke();
    expect(await g.usage()).toEqual({ budget: 100, spent: 18, remaining: 82 });
  });
});

describe("grantLifecycle() — the ONE display-lifecycle derivation (spec 011 A2)", () => {
  // The 20%-of-budget "low" threshold is a UI-honesty boundary: the pair pins it from both sides.
  it("authorized: active above 20%, low at/under 20%, exhausted at 0", () => {
    expect(grantLifecycle({ status: "authorized", budget: 100, remaining: 21 })).toBe("active");
    expect(grantLifecycle({ status: "authorized", budget: 100, remaining: 20 })).toBe("low");
    expect(grantLifecycle({ status: "authorized", budget: 100, remaining: 1 })).toBe("low");
    expect(grantLifecycle({ status: "authorized", budget: 100, remaining: 0 })).toBe("exhausted");
  });

  it("terminal + pending statuses pass straight through (never re-derived from money)", () => {
    expect(grantLifecycle({ status: "pending", budget: 100, remaining: 100 })).toBe("pending");
    expect(grantLifecycle({ status: "denied", budget: 100, remaining: 100 })).toBe("denied");
    expect(grantLifecycle({ status: "revoked", budget: 100, remaining: 40 })).toBe("revoked");
  });

  it("end-to-end: a real grant transitions pending → active → low → exhausted as it drains", async () => {
    const ca = client();
    // budget 36, perSpend 18: two $18 coffees take it exactly to 0.
    const created = await ca.grants.create({ merchant: "utopia", budget: 36, perSpend: 18 });
    const pendingUsage = await created.usage();
    expect(grantLifecycle({ status: created.status, ...pendingUsage })).toBe("pending");

    await ca.grants._authorize(created.id);
    const g = (await ca.grants.retrieve(created.id))!;
    const active = await g.usage();
    expect(grantLifecycle({ status: g.status, ...active })).toBe("active");

    await g.spend({ idempotencyKey: "l1", items: [{ sku: "coffee" }] }); // remaining 18 (= 50%)… still active
    await g.spend({ idempotencyKey: "l2", items: [{ sku: "espresso-machine" }] }).catch(() => {}); // over budget → refused
    // Take it into the low band with a small draw against a fresh low-budget grant instead:
    const low = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 18 });
    await ca.grants._authorize(low.id);
    const lg = (await ca.grants.retrieve(low.id))!;
    for (const k of ["a", "b", "c", "d", "e"]) await lg.spend({ idempotencyKey: k, items: [{ sku: "coffee" }] }); // 5×18 = 90
    const lu = await lg.usage();
    expect(lu.remaining).toBe(10);
    expect(grantLifecycle({ status: lg.status, ...lu })).toBe("low");

    const eu = await g.usage(); // g spent 18 of 36 → remaining 18 (still active); spend the rest
    void eu;
    await g.spend({ idempotencyKey: "l3", items: [{ sku: "coffee" }] }); // remaining 0
    const exhausted = await g.usage();
    expect(exhausted.remaining).toBe(0);
    expect(grantLifecycle({ status: g.status, ...exhausted })).toBe("exhausted");
  });
});
