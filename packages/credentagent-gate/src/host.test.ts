// Tests for defineHost() — the typed "bring your own host" seam contract (issue #24).
// The load-bearing assertions are BYPASS tests: a gated action completed through a defined
// host is refused server-side when unproven (invariant 1), and a well-formed host is
// behaviorally identical to the hand-wired seams — so defineHost adds NO weaker path.

import { describe, it, expect } from "vitest";
import { defineHost, type HostApp } from "./host.js";
import { CredentAgent } from "./client.js";
import { completeOrder, type CompletedRecord } from "./ceremony/completion.js";
import { issueCartMandate } from "./ceremony/cartMandate.js";
import { MemoryVerificationStore } from "./store.js";
import { professionalLicense } from "./ceremony/credential-gate/__fixtures__/customCredential.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder, CeremonyOrderStore, CompletionInput } from "./ceremony/types.js";

const PRODUCTS: Record<string, { price: number; minimumAge?: number; category?: string }> = {
  widget: { price: 10 },
  wine: { price: 20, minimumAge: 21 },
  drill: { price: 50, category: "Licensed" }, // the custom gate's applicable line
};

const catalog: CeremonyCatalog = {
  createOrder(items: CartItemRef[], orderId: string): CeremonyOrder {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity, ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}), ...(p.category ? { category: p.category } : {}) };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};

// A host's created-order store + completed-order store, backed by Maps.
function stores() {
  const created = new Map<string, CeremonyOrder>();
  const completedMap = new Map<string, CompletedRecord>();
  const orderStore: CeremonyOrderStore = { read: (id) => created.get(id) ?? null };
  const records = { read: (id: string) => completedMap.get(id), write: (rec: CompletedRecord) => void completedMap.set(rec.orderId, rec) };
  return { created, completedMap, orderStore, records };
}

// A CompletionInput for `items` priced through the catalog (all deterministic gates pass).
function inputFor(items: CartItemRef[], orderId = "ORD-1"): CompletionInput {
  const order = catalog.createOrder(items, orderId);
  return { order, mandateId: "m", amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }] };
}

describe("defineHost — construction validation (one error door)", () => {
  const s = stores();
  const ok = { catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true };

  it("throws naming the missing required seam", () => {
    expect(() => defineHost({ ...ok, catalog: undefined as unknown as CeremonyCatalog })).toThrow(/catalog/);
    expect(() => defineHost({ ...ok, orderStore: undefined as unknown as CeremonyOrderStore })).toThrow(/orderStore/);
  });
  it("throws when neither records nor a completion seam is given", () => {
    expect(() => defineHost({ catalog, orderStore: s.orderStore, allowEphemeralKey: true })).toThrow(/records.*completion|completion/i);
  });
  it("throws when BOTH records and a completion seam are given (contradictory)", () => {
    expect(() => defineHost({ catalog, orderStore: s.orderStore, records: s.records, completion: async () => ({ completed: true }), allowEphemeralKey: true })).toThrow(/not both|EITHER/i);
  });
  it("throws when neither signingKey nor allowEphemeralKey is given (fail-closed, like mount)", () => {
    expect(() => defineHost({ catalog, orderStore: s.orderStore, records: s.records })).toThrow(/signingKey/);
  });
  it("returns a host with a verification store, publish(), and complete()", () => {
    const host = defineHost(ok);
    expect(host.verificationStore).toBeInstanceOf(MemoryVerificationStore);
    expect(typeof host.publish).toBe("function");
    expect(typeof host.complete).toBe("function");
  });
});

describe("defineHost — publishes the seams so credentagent.mount(app) wires the rails", () => {
  it("mount() succeeds over the published seams and re-exposes them + the registry", () => {
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true });
    const app: HostApp = { locals: {} };

    host.publish(app);
    expect(() => new CredentAgent({ walletOrigin: "https://shop.example" }).mount(app)).not.toThrow();

    const locals = app.locals.credentagent as Record<string, unknown>;
    expect(locals.orderStore).toBe(s.orderStore);
    expect(locals.catalog).toBe(catalog);
    expect(locals.verificationStore).toBe(host.verificationStore); // the rails write the store host.complete reads
    expect(typeof locals.completion).toBe("function");
    expect(locals.credentialRegistry).toBeDefined(); // mount injected its registry onto the published seams
  });
});

describe("defineHost — BYPASS: the age gate is enforced on host.complete (invariant 1)", () => {
  it("refuses an unproven age-restricted order, completes only after the proof is recorded", async () => {
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true });
    const app: HostApp = { locals: {} };
    host.publish(app);
    new CredentAgent({ walletOrigin: "https://shop.example" }).mount(app);

    // Unproven → refused server-side on the completion path (not just a hidden button).
    const refused = await host.complete(inputFor([{ productId: "wine", quantity: 1 }]));
    expect(refused).toMatchObject({ completed: false, reason: "age" });
    expect(s.completedMap.has("ORD-1")).toBe(false); // recorded nothing

    // The rail writes the proof into the SAME store host.complete reads (shared store — if
    // defineHost wired a different store for completion, this would still refuse).
    const railStore = (app.locals.credentagent as { verificationStore: MemoryVerificationStore }).verificationStore;
    await railStore.write("ORD-1", { ageVerified: true });

    const ok = await host.complete(inputFor([{ productId: "wine", quantity: 1 }]));
    expect(ok.completed).toBe(true);
    expect(s.completedMap.has("ORD-1")).toBe(true);
  });
});

describe("defineHost — BYPASS: a custom gate() is enforced on host.complete via the lazy registry", () => {
  it("refuses an applicable custom-gate order until its per-order proof is recorded", async () => {
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true });
    const app: HostApp = { locals: {} };
    host.publish(app);
    // The custom gate is registered from boot; mount injects the registry onto app.locals,
    // which host.complete reads LAZILY at completion time.
    new CredentAgent({ walletOrigin: "https://shop.example", credentials: [professionalLicense] }).mount(app);

    // A "Licensed" line ⇒ professional_license applies. Unproven ⇒ refused (reason "gate").
    // This FAILS if defineHost drops the lazy registry read (the sweep would be skipped and
    // the order would complete UNPROVEN — fail-open).
    const refused = await host.complete(inputFor([{ productId: "drill", quantity: 1 }]));
    expect(refused).toMatchObject({ completed: false, reason: "gate" });

    await host.verificationStore.write("ORD-1", { verifiedGates: { professional_license: true } });
    const ok = await host.complete(inputFor([{ productId: "drill", quantity: 1 }]));
    expect(ok.completed).toBe(true);
  });
});

describe("defineHost — behaviorally identical to hand-wired seams (no weaker path)", () => {
  it("a defined host and a hand-bound completeOrder produce the same outcomes", async () => {
    // Hand-wired: the plumbing block defineHost removes.
    const handStore = new MemoryVerificationStore();
    const handCompleted = new Map<string, CompletedRecord>();
    const handComplete = (input: CompletionInput) =>
      completeOrder(input, { catalog, verificationStore: handStore, records: { read: (id) => handCompleted.get(id), write: (r) => void handCompleted.set(r.orderId, r) } });

    // defineHost: the same seams, built for you.
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true });

    // Same refusal for an unproven age order…
    expect(await handComplete(inputFor([{ productId: "wine", quantity: 1 }]))).toMatchObject({ completed: false, reason: "age" });
    expect(await host.complete(inputFor([{ productId: "wine", quantity: 1 }]))).toMatchObject({ completed: false, reason: "age" });

    // …and the same completion once each store carries the proof.
    await handStore.write("ORD-1", { ageVerified: true });
    await host.verificationStore.write("ORD-1", { ageVerified: true });
    expect((await handComplete(inputFor([{ productId: "wine", quantity: 1 }]))).completed).toBe(true);
    expect((await host.complete(inputFor([{ productId: "wine", quantity: 1 }]))).completed).toBe(true);
  });

  it("accepts a ready-made completion seam instead of records (advanced escape hatch)", async () => {
    const s = stores();
    let called = false;
    const host = defineHost({ catalog, orderStore: s.orderStore, completion: async () => { called = true; return { completed: true }; }, allowEphemeralKey: true });
    const res = await host.complete(inputFor([{ productId: "widget", quantity: 1 }]));
    expect(called).toBe(true);
    expect(res.completed).toBe(true);
  });
});

describe("defineHost — BYPASS: host.complete verifies a cart mandate with the RESOLVED ephemeral key", () => {
  function mandateFor(o: CeremonyOrder, key: string) {
    return issueCartMandate(
      { orderId: o.id, lines: o.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: l.unitPrice ?? 0, lineTotal: l.lineTotal, ...(l.minimumAge ? { minimumAge: l.minimumAge } : {}) })), currency: o.currency, total: o.total },
      key,
    );
  }

  it("refuses a tampered cart mandate on the ephemeral-key path (skipped if it forwarded undefined spec.signingKey)", async () => {
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true }); // no signingKey → ephemeral
    const app: HostApp = { locals: {} };
    host.publish(app);
    new CredentAgent({ walletOrigin: "https://shop.example" }).mount(app);

    // mount GENERATED the ephemeral key and republished it; the rails sign cart mandates with it.
    const key = (app.locals.credentagent as { signingKey?: string }).signingKey;
    expect(typeof key).toBe("string");

    // A valid mandate verifies + completes — proving host.complete actually USES the resolved key.
    const good = catalog.createOrder([{ productId: "widget", quantity: 2 }], "ORD-OK");
    const okRes = await host.complete({ order: good, mandateId: "m", amount: good.total, currency: good.currency, method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }], cartMandate: mandateFor(good, key!) });
    expect(okRes.completed).toBe(true);

    // A tampered mandate (edited total, stale signature) is REFUSED. This assertion FAILS if the
    // signing key reverts to spec.signingKey (undefined) — verification would be skipped entirely.
    const bad = catalog.createOrder([{ productId: "widget", quantity: 2 }], "ORD-BAD");
    const tampered = { ...mandateFor(bad, key!), total: 1 };
    const badRes = await host.complete({ order: bad, mandateId: "m2", amount: bad.total, currency: bad.currency, method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }], cartMandate: tampered });
    expect(badRes).toMatchObject({ completed: false, reason: "cart-mandate" });
  });
});

describe("defineHost — returnUrl seam (a non-storefront checkout route)", () => {
  it("publishes returnUrl so the rails return the buyer to the host's own checkout, not the dead default", () => {
    const s = stores();
    const host = defineHost({ catalog, orderStore: s.orderStore, records: s.records, allowEphemeralKey: true, returnUrl: (id) => `/checkout/${id}` });
    const app: HostApp = { locals: {} };
    host.publish(app);
    const returnUrl = (app.locals.credentagent as { returnUrl?: (id: string) => string }).returnUrl;
    expect(returnUrl?.("ORD-9")).toBe("/checkout/ORD-9");
  });
});
