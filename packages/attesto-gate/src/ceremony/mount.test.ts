// Foundational bypass tests for the ceremony seam contract + shared helpers.
// Every assertion pins a security control: mount() fails fast on a missing seam
// (CT2), the challenge nonce rejects a forged/expired token, completion re-prices
// a tampered amount from the catalog (invariant 2), and resolveOrder never trusts
// the inbound order (CT3). Each test FAILS if its control is removed.

import { describe, it, expect } from "vitest";
import { Attesto } from "../client.js";
import { MemoryVerificationStore } from "../store.js";
import { mountCeremony, resolveOrder, type CeremonyApp, type CeremonyContext, type CeremonySeams } from "./mount.js";
import { issueChallenge, verifyChallenge } from "./challengeToken.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "./completion.js";
import type { CeremonyCatalog, CompletionInput } from "./types.js";

// ── Fakes: a catalog that prices from a fixed map (the source of truth) ──────

const PRICES: Record<string, number> = { "oak-whiskey": 124, "aurora-headphones": 199 };

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const unitPrice = PRICES[it.productId] ?? 0;
      return { id: it.productId, name: it.productId, unitPrice, currency: "USD", quantity: it.quantity, lineTotal: unitPrice * it.quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};

function fakeApp(): CeremonyApp {
  return { locals: {} };
}

// A full, valid seam set; individual tests delete one to assert the fail-fast.
function validSeams(): CeremonySeams {
  return {
    verificationStore: new MemoryVerificationStore(),
    orderStore: { read: async () => null },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: "stable-test-secret",
  };
}

describe("mountCeremony — fail fast on missing seams (CT2)", () => {
  it("succeeds with a full, valid seam set and exposes the store on app.locals", () => {
    const app = fakeApp();
    const seams = validSeams();
    const ctx = mountCeremony(app, seams);
    expect(ctx.signingKey).toBe("stable-test-secret");
    expect((app.locals.attesto as { store?: unknown }).store).toBe(seams.verificationStore);
  });

  for (const seam of ["verificationStore", "orderStore", "catalog", "completion"] as const) {
    it(`throws when '${seam}' is missing`, () => {
      const seams = validSeams();
      delete (seams as Partial<CeremonySeams>)[seam];
      expect(() => mountCeremony(fakeApp(), seams)).toThrow(new RegExp(seam));
    });
  }

  it("throws when signingKey is missing (no allowEphemeralKey) — never infers serverless", () => {
    const seams = validSeams();
    delete seams.signingKey;
    expect(() => mountCeremony(fakeApp(), seams)).toThrow(/signingKey/);
  });

  it("allows a missing signingKey ONLY when allowEphemeralKey is explicitly true", () => {
    const seams = validSeams();
    delete seams.signingKey;
    seams.allowEphemeralKey = true;
    const ctx = mountCeremony(fakeApp(), seams);
    expect(ctx.signingKey).toMatch(/^[0-9a-f]{64}$/); // generated ephemeral key
  });

  it("reads seams from app.locals.attesto when not passed as options", () => {
    const app = fakeApp();
    app.locals.attesto = validSeams();
    expect(() => mountCeremony(app)).not.toThrow();
  });
});

describe("Attesto.mount — back-compat + ceremony delegation (T008)", () => {
  it("without ceremony seams: exposes the per-order store, never throws (002 storefront compose)", () => {
    const a = new Attesto({ walletOrigin: "https://shop.example" });
    const app = { locals: {} as Record<string, unknown> };
    a.mount(app);
    a.mount(app); // idempotent
    expect((app.locals.attesto as { store?: unknown }).store).toBe(a.store);
  });

  it("with ceremony seams: validates + injects Attesto's own store as the verificationStore", () => {
    const a = new Attesto({ walletOrigin: "https://shop.example" });
    const app = { locals: {} as Record<string, unknown> };
    a.mount(app, { orderStore: { read: async () => null }, catalog, completion: async () => ({ completed: true }), signingKey: "k" });
    expect((app.locals.attesto as { store?: unknown }).store).toBe(a.store);
  });

  it("with ceremony seams but a missing signingKey: the fail-fast flows through Attesto.mount", () => {
    const a = new Attesto();
    const app = { locals: {} as Record<string, unknown> };
    expect(() => a.mount(app, { orderStore: { read: async () => null }, catalog, completion: async () => ({ completed: true }) })).toThrow(/signingKey/);
  });
});

describe("challengeToken — stateless sealed nonce (replay / expiry rejected)", () => {
  const secret = "gate-secret";

  it("round-trips an issued challenge", () => {
    const { challenge, token } = issueChallenge(secret);
    expect(verifyChallenge(token, secret)).toBe(challenge);
  });

  it("rejects a forged/tampered signature", () => {
    const { token } = issueChallenge(secret);
    const [challenge, expiry] = token.split(".");
    const forged = `${challenge}.${expiry}.${Buffer.from("not-the-real-sig").toString("base64url")}`;
    expect(() => verifyChallenge(forged, secret)).toThrow(/signature/);
  });

  it("rejects a token signed with a different key", () => {
    const { token } = issueChallenge(secret);
    expect(() => verifyChallenge(token, "other-secret")).toThrow(/signature/);
  });

  it("rejects a token replayed after its expiry window", () => {
    const { token } = issueChallenge(secret, -1_000); // already expired
    expect(() => verifyChallenge(token, secret)).toThrow(/expired/);
  });
});

// ── Completion re-pricing (invariant 2) + idempotency ───────────────────────

function completionCtx(over: Partial<CompletionContext> = {}): { ctx: CompletionContext; records: Map<string, CompletedRecord> } {
  const records = new Map<string, CompletedRecord>();
  const ctx: CompletionContext = {
    catalog,
    verificationStore: new MemoryVerificationStore(),
    records: {
      read: async (id) => records.get(id),
      write: async (rec) => void records.set(rec.orderId, rec),
    },
    cart: { clear: async () => {} },
    ...over,
  };
  return { ctx, records };
}

const PASSING_GATES = [{ gate: "Amount integrity", pass: true, detail: "" }];

function input(total: number): CompletionInput {
  return {
    order: { id: "ORD-1", lines: [{ id: "oak-whiskey", unitPrice: 124, quantity: 1, lineTotal: 124 }], subtotal: 124, discount: 0, total, currency: "USD" },
    mandateId: "m1",
    amount: total,
    currency: "USD",
    method: "passkey",
    gates: PASSING_GATES,
  };
}

describe("completeOrder — re-prices from the catalog (invariant 2)", () => {
  it("refuses a tampered total (re-derived from the catalog, not the token)", async () => {
    const { ctx, records } = completionCtx();
    const res = await completeOrder(input(1), ctx); // claims $1 for a $124 item
    expect(res.completed).toBe(false);
    expect(res.reason).toBe("reprice");
    expect(records.size).toBe(0); // nothing recorded
  });

  it("completes when the total matches the catalog, clears verification, and is idempotent", async () => {
    const { ctx, records } = completionCtx();
    await ctx.verificationStore.write("ORD-1", { ageVerified: true });

    const first = await completeOrder(input(124), ctx);
    expect(first.completed).toBe(true);
    expect(records.get("ORD-1")?.amount).toBe(124);
    expect(await ctx.verificationStore.read("ORD-1")).toBeUndefined(); // cleared on completion

    // A replayed verify echoes the record — it does not write/settle twice.
    let writes = 0;
    ctx.records.write = async (rec) => void (records.set(rec.orderId, rec), writes++);
    const replay = await completeOrder(input(124), ctx);
    expect(replay.completed).toBe(true);
    expect(writes).toBe(0);
  });

  it("refuses when a gate failed (records nothing)", async () => {
    const { ctx, records } = completionCtx();
    const failed = { ...input(124), gates: [{ gate: "Amount integrity", pass: false, detail: "" }] };
    const res = await completeOrder(failed, ctx);
    expect(res.completed).toBe(false);
    expect(res.reason).toBe("gates");
    expect(records.size).toBe(0);
  });
});

// ── resolveOrder re-pricing + tamper rejection (CT3) ────────────────────────

function ctxWithOrder(stored: unknown, opts: { loyaltyApplied?: boolean } = {}): CeremonyContext {
  const verificationStore = new MemoryVerificationStore();
  if (opts.loyaltyApplied) verificationStore.write("ORD-1", { loyalty: { applied: true, membershipNumber: "M-1" } });
  return {
    verificationStore,
    orderStore: { read: async () => stored as never },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: "k",
    origin: () => ({ rpID: "shop.example", origin: "https://shop.example" }),
  };
}

describe("resolveOrder — re-prices from the catalog, refuses tampered ids (CT3)", () => {
  it("returns null for an unknown id", async () => {
    expect(await resolveOrder(ctxWithOrder(null), "ORD-1")).toBeNull();
  });

  it("returns null for a missing/empty id", async () => {
    expect(await resolveOrder(ctxWithOrder({ id: "ORD-1", lines: [] }), undefined)).toBeNull();
  });

  it("re-prices the total from the catalog, ignoring a tampered stored total", async () => {
    // The stored order CLAIMS $1; the catalog says oak-whiskey is $124.
    const stored = { id: "ORD-1", lines: [{ id: "oak-whiskey", quantity: 1, lineTotal: 1 }], subtotal: 1, discount: 0, total: 1, currency: "USD" };
    const order = await resolveOrder(ctxWithOrder(stored), "ORD-1");
    expect(order?.total).toBe(124);
  });

  it("applies the loyalty discount only when this order's verification opts in", async () => {
    const stored = { id: "ORD-1", lines: [{ id: "oak-whiskey", quantity: 1, lineTotal: 124 }], subtotal: 124, discount: 0, total: 124, currency: "USD" };
    const order = await resolveOrder(ctxWithOrder(stored, { loyaltyApplied: true }), "ORD-1");
    expect(order?.discount).toBeCloseTo(12.4);
    expect(order?.total).toBeCloseTo(111.6);
  });
});
