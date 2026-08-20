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

  // ── #172: the approve page must DISCLOSE an age-restricted scope before the tap ──────────
  // The bug: "$300, Beverages only" over a catalog whose Beverages are 21+ is a grant that can
  // spend $0.00, and nothing said so. Both directions are asserted — a page that warns about
  // everything is as useless as one that warns about nothing.

  it("discloses the age-restricted items a CATEGORY grant covers, and names them", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] } });

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).toContain("age-restricted items (21+)");
    expect(res._body).toContain("wine"); // the only 21+ item inside Beverages, named
    expect(res._body).toContain("$21");
    // The choice the human is actually making, spelled out on the button.
    expect(res._body).toContain("Approve without them");
  });

  it("says NOTHING about age when the scope holds no restricted item", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Electronics"] } });

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).not.toContain("age-restricted");
    expect(res._body).toContain("✓ Approve"); // today's page, unchanged
  });

  // The approve page and the ceremony gate pages must look like ONE product: same chrome, same
  // stepper, same card language. This pins the shared design system rather than the old bespoke
  // inline styles — swap it back for hand-rolled markup and this goes red.
  it("wears the SHARED ceremony chrome — brand header, progress rail, cards", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] } });

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).toContain(`<div class="wrap">`); // theme.pageHead + the shared shell
    expect(res._body).toContain(`<span class="wordmark">CREDENTAGENT</span>`);
    expect(res._body).toContain(`<div class="rail" role="list" aria-label="Progress">`);
    expect(res._body).toContain(`<div class="rail-label">Age</div>`);
    expect(res._body).toContain(`<div class="rail-label">Approve</div>`);
    expect(res._body).toContain(`class="btn btn-primary"`);
    expect(res._body).toContain(`class="card summary"`);
    // The limits read as money, with the budget as the bold total row.
    expect(res._body).toContain("$100.00");
    expect(res._body).toContain("$30.00");
    // The page's own honesty posture — NOT the rails' presence-only line (a different claim).
    expect(res._body).toContain("delegated-demo");
  });

  it("renders NO stepper when the grant has a single step — a one-dot rail says nothing", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Electronics"] } });

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).not.toContain(`class="rail"`);
    expect(res._body).toContain("✓ Approve"); // just the decision
  });

  it("offers the wallet button ONLY when the age ceremony is actually mounted", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app); // serve() alone — no mount(), so no /age route exists
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] } });

    let res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).toContain("age-restricted items (21+)"); // the warning still lands
    expect(res._body).not.toContain("with your wallet"); // but never a link to a 404

    ca.grants._ageRailMounted = true; // what registerGrantAgeGate does at mount()
    res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).toContain("Verify 21+ with your wallet");
    expect(res._body).toContain(`/credentagent/grants/${g.id}/age`);
  });

  it("flips to the verified state once the human has proved their age", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] } });
    expect(await ca.grants._recordAgeProof(g.id, { provenAge: 21 })).toBe(true);

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: g.id } }, res);
    expect(res._body).toContain("✓ Age verified — 21+");
    expect(res._body).toContain("may buy the age-restricted items above while you're away");
    expect(res._body).toContain("✓ Approve"); // no longer "Approve without them"
    // The rail agrees with the card: Age ticked, Approve current.
    expect(res._body).toContain(`<div class="rail-step done"><div class="rail-dot">✓</div><div class="rail-label">Age</div>`);
  });
});

// ── #172: age at approval — the human proves once, on their phone, and the claim is SEALED into
// the grant. Every test below goes red if its control is reverted.
describe("credentagent.grants — the age claim sealed at approval (#172)", () => {
  /** create → prove `provenAge` → approve. The order the approve page enforces. */
  async function grantWithAgeProof(ca: CredentAgent, provenAge: number): Promise<Grant> {
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(await ca.grants._recordAgeProof(g.id, { provenAge })).toBe(true);
    await ca.grants._authorize(g.id);
    return (await ca.grants.retrieve(g.id))!;
  }

  // BYPASS (the reversal's guard — completion.ts's delegated branch): a grant nobody proved an
  // age for must still refuse an age-restricted item. Delete the `!ageProofCovers(...)` half of
  // that condition and this goes red — every grant would suddenly buy alcohol unattended.
  it("BYPASS: a grant with NO age proof still refuses a 21+ item — step-up", async () => {
    const g = await authorizedGrant(client());
    const s = await g.spend({ idempotencyKey: "np1", items: [{ sku: "wine" }] });
    expect(s).toMatchObject({ ok: false, code: "step-up" });
  });

  // BYPASS (the threshold comparison in ageProofCovers): an 18+ proof must NOT open a 21+ item.
  // Drop the `proof.provenAge < requiredAge` check and this goes red.
  it("BYPASS: an 18+ proof does not open a 21+ item — step-up", async () => {
    const g = await grantWithAgeProof(client(), 18);
    const s = await g.spend({ idempotencyKey: "u18", items: [{ sku: "wine" }] });
    expect(s).toMatchObject({ ok: false, code: "step-up" });
  });

  // The positive path — without it the reversal is unproven: the whole point of #172 is that a
  // proved grant CAN buy what it was approved for.
  it("a 21+ proof lets the agent buy the 21+ item, priced + drawn down like any other spend", async () => {
    const g = await grantWithAgeProof(client(), 21);
    const s = await g.spend({ idempotencyKey: "ok21", items: [{ sku: "wine" }] });
    expect(s).toMatchObject({ ok: true, amount: 21, remaining: 79, authorization: "delegated" });
  });

  // BYPASS (the `status !== "pending"` gate in _recordAgeProof): consent happened when the human
  // tapped Approve. A grant must never gain a capability afterwards. Delete that check and this
  // goes red — an approved grant would start buying 21+ goods the human never blessed.
  it("BYPASS: a proof recorded AFTER approval is refused, and the sealed grant is unchanged", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await ca.grants._authorize(g.id);

    expect(await ca.grants._recordAgeProof(g.id, { provenAge: 21 })).toBe(false);
    const live = (await ca.grants.retrieve(g.id))!;
    expect(live.ageProof).toBeUndefined();
    expect(await live.spend({ idempotencyKey: "late", items: [{ sku: "wine" }] })).toMatchObject({ ok: false, code: "step-up" });
  });

  it("a second, WEAKER ceremony cannot lower what the first one proved", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await ca.grants._recordAgeProof(g.id, { provenAge: 21 });
    await ca.grants._recordAgeProof(g.id, { provenAge: 18 });
    await ca.grants._authorize(g.id);
    expect((await ca.grants.retrieve(g.id))!.ageProof?.provenAge).toBe(21);
  });

  it("refuses a malformed threshold rather than sealing it", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(await ca.grants._recordAgeProof(g.id, { provenAge: Number.NaN })).toBe(false);
    expect(await ca.grants._recordAgeProof(g.id, { provenAge: 0 })).toBe(false);
    expect((await ca.grants.retrieve(g.id))!.ageProof).toBeUndefined();
  });

  // BYPASS (the expiry half of ageProofCovers): a snapshot claim must respect the credential's
  // own validity. Delete the `expiry <= nowMs` check and this goes red.
  it("BYPASS: an EXPIRED proof refuses the 21+ item — a snapshot fails closed", async () => {
    const ca = client();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await ca.grants._recordAgeProof(g.id, { provenAge: 21, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await ca.grants._authorize(g.id);
    const live = (await ca.grants.retrieve(g.id))!;
    expect(await live.spend({ idempotencyKey: "exp", items: [{ sku: "wine" }] })).toMatchObject({ ok: false, code: "step-up" });
  });

  it("the proof is SEALED: it rides the authorized intent, and is stated presence-only", async () => {
    const g = await grantWithAgeProof(client(), 21);
    expect(g.ageProof).toMatchObject({ provenAge: 21, trust_level: "presence-only-demo" });
    expect(typeof g.ageProof!.verifiedAt).toBe("string");
  });

  it("changes NOTHING for an unrestricted purchase", async () => {
    const g = await grantWithAgeProof(client(), 21);
    expect(await g.spend({ idempotencyKey: "c1", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true, amount: 18, remaining: 82 });
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
