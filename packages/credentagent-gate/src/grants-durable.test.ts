// Durable grant store — the cross-instance behavior a serverless deployment needs (#104 follow-up).
// TWO CredentAgent instances share ONE grant store = two serverless instances that share no memory.
// Every assertion here fails when its control is removed (the bypass rule): rehydration must be
// faithful, revoke must win across instances, idempotency must replay after rehydration, and a
// store error must fail CLOSED (refuse), never fall through to a stale in-memory authorization.

import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { MemoryGrantStore, type GrantStore } from "./grants.js";

const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages" },
};

/** A CredentAgent wired to a shared grant store — one "serverless instance". */
const instance = (store: GrantStore) =>
  new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG, grantStore: store });

describe("grants durable store — cross-instance (the #104 serverless fix)", () => {
  it("create+approve on A, spend on B: B rehydrates the grant and remaining is faithful", async () => {
    const store = new MemoryGrantStore();
    const A = instance(store);
    const B = instance(store);
    const g = await A.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await A.grants._authorize(g.id);

    // B never saw create/authorize (a different instance) — it must rehydrate from the store.
    const gb = (await B.grants.retrieve(g.id))!;
    expect(gb).not.toBeNull();
    expect(gb.status).toBe("authorized");
    const s = await gb.spend({ idempotencyKey: "b1", items: [{ sku: "coffee" }] }); // $18
    expect(s).toMatchObject({ ok: true, amount: 18, remaining: 82 });
    expect(await gb.usage()).toEqual({ budget: 100, spent: 18, remaining: 82 });

    // And A, re-reading, sees B's spend — the store is the source of truth.
    const ga = (await A.grants.retrieve(g.id))!;
    expect(await ga.usage()).toEqual({ budget: 100, spent: 18, remaining: 82 });
  });

  it("faithful budget cap across instances: A draws most of it, B cannot exceed the remainder", async () => {
    const store = new MemoryGrantStore();
    const A = instance(store);
    const B = instance(store);
    const g = await A.grants.create({ merchant: "utopia", budget: 40, perSpend: 20 });
    await A.grants._authorize(g.id);
    await (await A.grants.retrieve(g.id))!.spend({ idempotencyKey: "a1", items: [{ sku: "coffee" }] }); // $18 → 22 left

    // B rehydrates with the stored spend seeded, so the budget cap holds against the REAL remainder.
    const gb = (await B.grants.retrieve(g.id))!;
    const ok = await gb.spend({ idempotencyKey: "b1", items: [{ sku: "coffee" }] }); // 18+18=36 ≤ 40 → 4 left
    expect(ok).toMatchObject({ ok: true, remaining: 4 });
    const over = await gb.spend({ idempotencyKey: "b2", items: [{ sku: "coffee" }] }); // 36+18 > 40
    expect(over).toMatchObject({ ok: false, code: "budget-exceeded" });
  });

  // BYPASS (cross-instance revoke-wins): delete the syncFromStore() at the spend door and B's stale
  // authorized engine would spend a grant A already revoked — this assertion goes red.
  it("BYPASS: revoke on A refuses a spend on B, even though B's memory still holds an authorized grant", async () => {
    const store = new MemoryGrantStore();
    const A = instance(store);
    const B = instance(store);
    const g = await A.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await A.grants._authorize(g.id);

    // B retrieves WHILE authorized → B's memory caches an authorized engine.
    const gb = (await B.grants.retrieve(g.id))!;
    expect(gb.status).toBe("authorized");
    // A revokes (durably, to the shared store).
    await (await A.grants.retrieve(g.id))!.revoke();
    // B's spend must re-read the store and refuse — not spend on its stale in-memory engine.
    const s = await gb.spend({ idempotencyKey: "b1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: false, code: "revoked" });
  });

  it("idempotency replays identically after rehydration: the same key on B echoes A's original outcome", async () => {
    const store = new MemoryGrantStore();
    const A = instance(store);
    const B = instance(store);
    const g = await A.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await A.grants._authorize(g.id);
    const first = await (await A.grants.retrieve(g.id))!.spend({ idempotencyKey: "k1", items: [{ sku: "coffee" }] });
    expect(first).toMatchObject({ ok: true, amount: 18, remaining: 82, replayed: false });

    // B rehydrates the door cache and replays the SAME key — one charge, remaining unchanged.
    const gb = (await B.grants.retrieve(g.id))!;
    const replay = await gb.spend({ idempotencyKey: "k1", items: [{ sku: "coffee" }] });
    expect(replay).toMatchObject({ ok: true, amount: 18, remaining: 82, replayed: true });
    // Repurposing the key with a DIFFERENT item still replays the original (a key can't be reused).
    const repurpose = await gb.spend({ idempotencyKey: "k1", items: [{ sku: "wine" }] });
    expect(repurpose).toMatchObject({ ok: true, amount: 18, replayed: true });
    expect(await gb.usage()).toEqual({ budget: 100, spent: 18, remaining: 82 });
  });

  it("rehydration stays honest: the rehydrated grant keeps trust_level server-issued-demo (no signed continuity)", async () => {
    const store = new MemoryGrantStore();
    const A = instance(store);
    const B = instance(store);
    const g = await A.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await A.grants._authorize(g.id);
    const gb = (await B.grants.retrieve(g.id))!;
    expect(gb.presence).toBe("delegated-demo");
    expect(gb.trustLevel).toBe("server-issued-demo");
  });

  // BYPASS (fail-closed): a store READ error at the spend door must REFUSE, not fall through to the
  // in-memory authorized engine. Flip the store to throw on read after B holds an authorized handle.
  it("BYPASS: a store read error at spend refuses (fail-closed), not fall-open to the cached engine", async () => {
    const backing = new MemoryGrantStore();
    let failReads = false;
    const flaky: GrantStore = {
      read: async (id) => {
        if (failReads) throw new Error("redis down");
        return backing.read(id);
      },
      write: (id, s) => backing.write(id, s),
    };
    const A = instance(backing); // A sets up over the healthy backing store
    const B = instance(flaky);
    const g = await A.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await A.grants._authorize(g.id);
    const gb = (await B.grants.retrieve(g.id))!; // reads OK now → authorized in B's memory
    expect(gb.status).toBe("authorized");

    failReads = true; // the store goes down
    const s = await gb.spend({ idempotencyKey: "b1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: false, code: "refused" }); // fail-closed, NOT ok:true
  });

  it("no store configured → the in-memory path is byte-for-byte unchanged (zero-config still works)", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG });
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    await ca.grants._authorize(g.id);
    const s = await (await ca.grants.retrieve(g.id))!.spend({ idempotencyKey: "m1", items: [{ sku: "coffee" }] });
    expect(s).toMatchObject({ ok: true, amount: 18, remaining: 82 });
  });
});
