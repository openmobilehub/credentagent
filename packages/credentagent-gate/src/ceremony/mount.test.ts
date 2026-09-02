// Foundational bypass tests for the ceremony seam contract + shared helpers.
// Every assertion pins a security control: mount() fails fast on a missing seam
// (CT2), the challenge nonce rejects a forged/expired token, completion re-prices
// a tampered amount from the catalog (invariant 2), and resolveOrder never trusts
// the inbound order (CT3). Each test FAILS if its control is removed.

import { describe, it, expect, beforeAll } from "vitest";
import { CredentAgent } from "../client.js";
import { MemoryVerificationStore } from "../store.js";
import { required, defineCredential, dcql, gate } from "../credentials.js";
import type { Credential } from "../types.js";
import { professionalLicense } from "./credential-gate/__fixtures__/customCredential.js";
import { mountCeremony, resolveOrder, type CeremonyApp, type CeremonyContext, type CeremonySeams } from "./mount.js";
import { issueChallenge, verifyChallenge } from "./challengeToken.js";
import { mintChain, testIssuer, type TestIssuer } from "../ap2/chain.testkit.js";
import { encodeMandateChainParam } from "../ap2/transport.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "./completion.js";
import type { CeremonyCatalog, CeremonyOrderStore, CompletionInput } from "./types.js";

// ── Fakes: a catalog that prices from a fixed map (the source of truth) ──────

const PRICES: Record<string, number> = { "oak-whiskey": 124, "aurora-headphones": 199, drill: 50 };
const CATEGORIES: Record<string, string> = { drill: "Licensed" }; // 007: the custom gate's applicable line

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const unitPrice = PRICES[it.productId] ?? 0;
      return { id: it.productId, name: it.productId, unitPrice, currency: "USD", quantity: it.quantity, lineTotal: unitPrice * it.quantity, ...(CATEGORIES[it.productId] ? { category: CATEGORIES[it.productId] } : {}) };
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
    expect((app.locals.credentagent as { store?: unknown }).store).toBe(seams.verificationStore);
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

  it("reads seams from app.locals.credentagent when not passed as options", () => {
    const app = fakeApp();
    app.locals.credentagent = validSeams();
    expect(() => mountCeremony(app)).not.toThrow();
  });

  it("threads readerIdentity from the seams onto the ctx the rails receive (#51)", () => {
    const readerIdentity = { key: "PEM-KEY", cert: "PEM-CERT" };
    const ctx = mountCeremony(fakeApp(), { ...validSeams(), readerIdentity });
    expect(ctx.readerIdentity).toBe(readerIdentity);
  });

  it("leaves readerIdentity undefined when none is supplied (self-signed default)", () => {
    const ctx = mountCeremony(fakeApp(), validSeams());
    expect(ctx.readerIdentity).toBeUndefined();
  });
});

describe("CredentAgent.mount — back-compat + ceremony delegation (T008)", () => {
  it("without ceremony seams: exposes the per-order store, never throws (002 storefront compose)", () => {
    const a = new CredentAgent({ walletOrigin: "https://shop.example" });
    const app = { locals: {} as Record<string, unknown> };
    a.mount(app);
    a.mount(app); // idempotent
    expect((app.locals.credentagent as { store?: unknown }).store).toBe(a.store);
  });

  it("with ceremony seams: validates + injects CredentAgent's own store as the verificationStore", () => {
    const a = new CredentAgent({ walletOrigin: "https://shop.example" });
    const app = { locals: {} as Record<string, unknown> };
    a.mount(app, { orderStore: { read: async () => null }, catalog, completion: async () => ({ completed: true }), signingKey: "k" });
    expect((app.locals.credentagent as { store?: unknown }).store).toBe(a.store);
  });

  it("with ceremony seams but a missing signingKey: the fail-fast flows through CredentAgent.mount", () => {
    const a = new CredentAgent();
    const app = { locals: {} as Record<string, unknown> };
    expect(() => a.mount(app, { orderStore: { read: async () => null }, catalog, completion: async () => ({ completed: true }) })).toThrow(/signingKey/);
  });
});

// ── 007 (US2, F2 wiring proof): mount() PUBLISHES the credential registry so a host's
//    completion seam enforces custom gates. The unit sweep test (completion.test.ts)
//    seeds ctx.credentialRegistry directly and would pass even if mount() never wired
//    it — THIS suite goes through mount() + a host-shaped completion seam that reads
//    the registry off app.locals, so it FAILS if the injection is removed. ──────────
describe("CredentAgent.mount — publishes the registry so completion enforces custom gates (007)", () => {
  const licenseCred: Credential = professionalLicense; // shared fixture (T002)

  function wired() {
    const app = { locals: {} as Record<string, unknown> };
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });
    const records = new Map<string, CompletedRecord>();
    // The completion seam a HOST binds: it reads the registry mount() published on
    // app.locals (exactly as the reference storefront does), never a hand-seeded one.
    const completion = (i: CompletionInput) =>
      completeOrder(i, {
        catalog,
        verificationStore: credentagent.store,
        records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
        cart: { clear: async () => {} },
        credentialRegistry: (app.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential> } | undefined)?.credentialRegistry,
      });
    credentagent.mount(app, { orderStore: { read: async () => null }, catalog, completion, signingKey: "k" });
    // Register-on-resolve: the checkout call that mints the manifest populates the registry.
    credentagent.requirements(
      { id: "ORD-L", total: 50, currency: "USD", lines: [{ id: "drill", quantity: 1, unitPrice: 50, category: "Licensed" }] },
      [required(licenseCred)],
    );
    return { app, credentagent, completion, records };
  }

  const orderInput = (): CompletionInput => {
    const order = catalog.createOrder([{ productId: "drill", quantity: 1 }], "ORD-L");
    return { order, mandateId: "m", amount: order.total, currency: "USD", method: "test", gates: PASSING_GATES };
  };

  it("mount() publishes the registry to app.locals once requirements() populates it", () => {
    const reg = (wired().app.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential> }).credentialRegistry;
    expect(reg?.get("professional_license")).toBeDefined(); // FAILS if mount stopped publishing the registry
  });

  it("BYPASS: a Licensed order with no proven gate is refused THROUGH the mounted completion seam", async () => {
    const h = wired();
    const res = await h.completion(orderInput());
    expect(res).toMatchObject({ completed: false, reason: "gate" }); // FAILS if mount's registry injection is removed
    expect(h.records.size).toBe(0);
  });

  it("completes once the custom gate is proven for the order (so the refusal was the WIRED control)", async () => {
    const h = wired();
    await h.credentagent.store.write("ORD-L", { verifiedGates: { professional_license: true } });
    const res = await h.completion(orderInput());
    expect(res.completed).toBe(true);
  });
});

// PR #131 review (P1): under the plain mount(app, ceremony) path the passkey/dc-payment rails call
// completion WITHOUT policyCredentialIds, so before this fix a no-appliesTo custom gate that ANY
// order registered would permanently deadlock a LATER order whose policy omitted it (the F2 bug,
// but only for orders.serve was it scoped). mount() now remembers each order's policy and the
// mounted ceremony seam sets input.policyCredentialIds from it — so the sweep is scoped for the
// mounted path too. These go through the WRAPPED seam mount() publishes on app.locals.
describe("CredentAgent.mount — the ceremony seam scopes the sweep to THIS order's policy (#131)", () => {
  const globalGate = defineCredential({
    id: "global_gate",
    request: dcql({ docType: "org.example.global.1", claims: ["ok"] }),
    verify: (c) => c.ok === true,
    effect: gate(), // NO appliesTo → "applies to all" in the registry-wide sweep
    ui: { label: "Global gate", action: "Prove" },
  });
  const plainOrder = (id: string) => ({ id, total: 199, currency: "USD", lines: [{ id: "aurora-headphones", quantity: 1, unitPrice: 199 }] });

  function wiredWithGlobalGate() {
    const app = { locals: {} as Record<string, unknown> };
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });
    const records = new Map<string, CompletedRecord>();
    const completion = (i: CompletionInput) =>
      completeOrder(i, {
        catalog,
        verificationStore: credentagent.store,
        records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
        cart: { clear: async () => {} },
        credentialRegistry: (app.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential> } | undefined)?.credentialRegistry,
      });
    credentagent.mount(app, { orderStore: { read: async () => null }, catalog, completion, signingKey: "k" });
    credentagent.requirements(plainOrder("ORD-A"), [required(globalGate)]); // registers global_gate (registry + policy[A])
    credentagent.requirements(plainOrder("ORD-B"), []); // B's policy OMITS it
    return { app, credentagent, completion, records };
  }

  const inputFor = (id: string): CompletionInput => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], id);
    return { order, mandateId: "m", amount: order.total, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }] };
  };
  const wrappedSeam = (app: { locals: Record<string, unknown> }) =>
    (app.locals.credentagent as { completion: (i: CompletionInput) => Promise<{ completed: boolean; reason?: string }> }).completion;

  it("the MOUNTED (wrapped) seam scopes order B to its own policy → it completes (no cross-order deadlock)", async () => {
    const h = wiredWithGlobalGate();
    const res = await wrappedSeam(h.app)(inputFor("ORD-B"));
    expect(res).toMatchObject({ completed: true }); // B never required global_gate
  });

  it("BYPASS: the RAW (unwrapped) host seam sweeps registry-wide → order B deadlocks (proves the wrap is the fix)", async () => {
    const h = wiredWithGlobalGate();
    const res = await h.completion(inputFor("ORD-B")); // the same seam, but WITHOUT the mount-path scoping
    expect(res).toMatchObject({ completed: false, reason: "gate" });
  });

  it("control: order A (whose policy DID require the gate) is still refused through the mounted seam", async () => {
    const h = wiredWithGlobalGate();
    const res = await wrappedSeam(h.app)(inputFor("ORD-A"));
    expect(res).toMatchObject({ completed: false, reason: "gate" }); // scoping didn't disable in-policy enforcement
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

  // #59 finding 3 (fail-OPEN): a custom gate's `appliesTo` keys on a product attribute
  // (here `requiresRx`). The catalog above re-prices from `{ productId, quantity }` and does NOT
  // forward `requiresRx` — a lossy host catalog. resolveOrder must re-attach the attribute from
  // the FAITHFUL stored order line, so the rails + the completion sweep see the SAME field the
  // manifest resolved against; otherwise a lossy catalog silently re-opens the gate. Deleting the
  // preserveLineAttributes merge in resolveOrder turns this red (requiresRx becomes undefined).
  it("re-attaches a custom line attribute the catalog dropped, from the stored order (finding 3)", async () => {
    const stored = { id: "ORD-1", lines: [{ id: "drill", quantity: 1, lineTotal: 50, requiresRx: true }], subtotal: 50, discount: 0, total: 50, currency: "USD" };
    const order = await resolveOrder(ctxWithOrder(stored), "ORD-1");
    expect(order?.total).toBe(50); // price stays catalog-authoritative (invariant 2)
    expect(order?.lines[0].requiresRx).toBe(true); // attribute the lossy catalog stripped, restored
  });
});

// ── FR-007: statelessOrders — reconstruct from a VERIFIED AP2 chain (US3) ──
// The store is bypassed on purpose (an instance split has no shared store), so the SIGNED
// chain is the transport. Every bypass below FAILS if `verifyChain` is removed from
// resolveOrder's stateless branch: a forged / tampered / replayed / expired chain would then
// resolve an attacker-chosen order.

const SECRET = "stable-test-secret";
const ORDER_1: CeremonyOrder = {
  id: "ORD-1",
  lines: [{ id: "oak-whiskey", quantity: 2, unitPrice: 124, lineTotal: 248 }],
  subtotal: 248,
  discount: 0,
  total: 248,
  currency: "USD",
};
// Proves FR-007's "no createdOrderStore read": if the stateless branch ever touched the
// store, this throws and the test fails.
const THROW_STORE: CeremonyOrderStore = {
  read: () => {
    throw new Error("orderStore.read must NOT be called under statelessOrders (FR-007)");
  },
};

let T: TestIssuer;
beforeAll(async () => {
  T = await testIssuer();
});

function statelessCtx(overrides: Partial<CeremonyContext> = {}): CeremonyContext {
  return {
    verificationStore: new MemoryVerificationStore(),
    orderStore: THROW_STORE,
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: SECRET,
    mandatePublicJwk: T.key.publicJwk,
    origin: () => ({ rpID: "shop.example", origin: "https://shop.example" }),
    statelessOrders: true,
    ...overrides,
  };
}

describe("resolveOrder — FR-007 statelessOrders (reconstruct from a verified AP2 chain, US3)", () => {
  it("reconstructs a created order from a valid chain with NO orderStore read (SC-003)", async () => {
    const chain = await mintChain(T, ORDER_1);
    const order = await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: chain });
    expect(order?.id).toBe("ORD-1");
    expect(order?.lines.map((l) => l.id)).toEqual(["oak-whiskey"]);
    expect(order?.total).toBe(248); // 2 × 124, RE-PRICED from the catalog
  });

  it("accepts the base64url form the page JS forwards, not only an object", async () => {
    const chain = await mintChain(T, ORDER_1);
    const order = await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: encodeMandateChainParam(chain) });
    expect(order?.total).toBe(248);
  });

  it("re-prices from the catalog, ignoring the chain's signed price (invariant 2)", async () => {
    // Validly signed end to end, but the chain CLAIMS $2; the catalog says $248.
    const cheap: CeremonyOrder = { ...ORDER_1, lines: [{ id: "oak-whiskey", quantity: 2, unitPrice: 1, lineTotal: 2 }], subtotal: 2, total: 2 };
    const chain = await mintChain(T, cheap);
    const order = await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: chain });
    expect(order?.total).toBe(248);
  });

  it("SC-003: a created order COMPLETES across two instances with no shared order store", async () => {
    // Instance A issues the signed chain for ORD-1 (whiskey ×2 = $248).
    const chain = await mintChain(T, ORDER_1);

    // Instance B has NO stored order (its orderStore throws) — it reconstructs from the
    // chain, then completes through the shared seam with its OWN empty records store.
    const order = await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: chain });
    expect(order?.total).toBe(248);

    const { ctx: completion, records } = completionCtx({ signingKey: SECRET, mandatePublicJwk: T.key.publicJwk });
    const res = await completeOrder(
      { order: order!, mandateChain: chain, mandateId: "m1", amount: 248, currency: "USD", method: "passkey", gates: PASSING_GATES },
      completion,
    );
    expect(res.completed).toBe(true);
    expect(records.get("ORD-1")?.amount).toBe(248);
  });

  it("BYPASS: a tampered cart resolves nothing (fails closed) — control = verifyChain", async () => {
    // Swap the line items AFTER the checkout was signed; the digest no longer matches.
    const chain = await mintChain(T, ORDER_1);
    const other = await mintChain(T, { ...ORDER_1, id: "ORD-1", lines: [{ id: "aurora-headphones", quantity: 10, unitPrice: 199, lineTotal: 1990 }], subtotal: 1990, total: 1990 });
    const spliced = { ...chain, checkout: other.checkout };
    expect(await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: spliced })).toBeNull();
  });

  it("BYPASS: a chain signed with the wrong key (forgery) resolves nothing", async () => {
    const attacker = await testIssuer();
    const forged = await mintChain(attacker, ORDER_1);
    expect(await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: forged })).toBeNull();
  });

  it("BYPASS: no key configured means no chain is accepted — never waved through", async () => {
    const chain = await mintChain(T, ORDER_1);
    const ctx = statelessCtx();
    delete (ctx as { mandatePublicJwk?: unknown }).mandatePublicJwk;
    expect(await resolveOrder(ctx, "ORD-1", { mandateChain: chain })).toBeNull();
  });

  it("refuses a valid chain replayed against a DIFFERENT order (order-id binding)", async () => {
    const chain = await mintChain(T, { ...ORDER_1, id: "ORD-OTHER" });
    expect(await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: chain })).toBeNull();
  });

  it("refuses an expired chain", async () => {
    const chain = await mintChain(T, ORDER_1, { ttlMs: -1000 });
    expect(await resolveOrder(statelessCtx(), "ORD-1", { mandateChain: chain })).toBeNull();
  });

  it("applies the loyalty discount only when THIS order's verification opts in (invariant 3)", async () => {
    const verificationStore = new MemoryVerificationStore();
    verificationStore.write("ORD-1", { loyalty: { applied: true, membershipNumber: "M-1" } });
    const chain = await mintChain(T, ORDER_1);
    const order = await resolveOrder(statelessCtx({ verificationStore }), "ORD-1", { mandateChain: chain });
    expect(order?.discount).toBeCloseTo(24.8);
    expect(order?.total).toBeCloseTo(223.2);
  });

  it("OFF by default: with statelessOrders unset the chain is ignored and the store wins", async () => {
    // ctxWithOrder leaves statelessOrders unset (off). The store holds a DIFFERENT order
    // (headphones $199); passing a whiskey mandate must not override the store.
    const stored = { id: "ORD-1", lines: [{ id: "aurora-headphones", quantity: 1, lineTotal: 199 }], subtotal: 199, discount: 0, total: 199, currency: "USD" };
    const chain = await mintChain(T, ORDER_1);
    const order = await resolveOrder(ctxWithOrder(stored), "ORD-1", { mandateChain: chain });
    expect(order?.lines.map((l) => l.id)).toEqual(["aurora-headphones"]);
    expect(order?.total).toBe(199);
  });
});

// ── 008 (#85): the delegated verifier seam is OPTIONAL and inert by default ──
// The seam must be additive: a host that configures no verifier keeps every existing
// path byte-unchanged (FR-001). These pin the contract only — the delegated rail's
// own enforcement lands with its verify handler (#87).

describe("mountCeremony — delegated verifier seam (008)", () => {
  // A verdict-returning stub. It is deliberately NOT trustworthy: later increments
  // assert the gate refuses a stub that approves the wrong amount, which is only
  // provable because the seam is injectable (see #87's bypass tests).
  const stubVerifier = {
    buildRequest: async () => ({ reference: "ref-1", handoff: { verifierUrl: "https://verifier.example" } }),
    consume: async () => ({
      approved: true,
      trust_level: "issuer-verified" as const,
      claims: {},
      binding: { amount: 124, currency: "USD" },
    }),
  };

  it("is genuinely optional — mounting without one leaves the context inert", () => {
    const ctx = mountCeremony(fakeApp(), validSeams());
    expect(ctx.verifier).toBeUndefined();
  });

  it("carries the verifier onto the context when supplied via options", () => {
    const ctx = mountCeremony(fakeApp(), { ...validSeams(), verifier: stubVerifier });
    expect(ctx.verifier).toBe(stubVerifier);
  });

  it("accepts the verifier from app.locals.credentagent, and options win over locals", () => {
    const fromLocals = { ...stubVerifier };
    const app = fakeApp();
    app.locals.credentagent = { verifier: fromLocals };
    expect(mountCeremony(app, validSeams()).verifier).toBe(fromLocals);

    const app2 = fakeApp();
    app2.locals.credentagent = { verifier: fromLocals };
    expect(mountCeremony(app2, { ...validSeams(), verifier: stubVerifier }).verifier).toBe(stubVerifier);
  });

  it("does not become a required seam — a missing verifier never trips the fail-fast", () => {
    // Guards the additive promise: the CT2 fail-fast list must stay
    // verificationStore/orderStore/catalog/completion, never verifier.
    expect(() => mountCeremony(fakeApp(), validSeams())).not.toThrow();
  });
});
