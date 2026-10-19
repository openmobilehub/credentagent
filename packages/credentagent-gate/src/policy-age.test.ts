// #354 — an age check in the POLICY is enforced at its own threshold, on every path.
//
// Before: completion decided "is this order age-restricted?" only from each line's `minimumAge`,
// and every rail evaluated age at that line threshold (or a default 21). So `required(age.over(25))`
// on an action with no `minimumAge` completed on a 21+ proof — or with no age proof at all on a
// payment rail (invariants 1 + 5).
//
// These drive the PUBLIC path a host uses — `credentagent.requirements()` + `defineHost` +
// `credentagent.mount()` — so each fails if the order's policy age stops reaching the credential
// rail, the delegated rail, or the shared completion (`host.complete`, which the rails call).

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { defineHost } from "./host.js";
import { age, payment, required } from "./credentials.js";
import type { CompletedRecord } from "./ceremony/completion.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder, CompletionInput, DelegatedVerifier } from "./ceremony/types.js";
import type { Credential, Step } from "./types.js";
import type { PolicyAgeLookup } from "./ceremony/types.js";

// No line carries `minimumAge`: the ONLY age requirement is the one in the policy.
const PRODUCTS: Record<string, number> = { "gift-card": 50, "sealed-record": 0 };
const catalog: CeremonyCatalog = {
  createOrder(items: CartItemRef[], orderId: string): CeremonyOrder {
    const lines = items.map((it) => {
      const price = PRODUCTS[it.productId] ?? 0;
      return { id: it.productId, name: it.productId, unitPrice: price, currency: "USD", quantity: it.quantity, lineTotal: price * it.quantity };
    });
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

// The instant-demo payment credential the dc-payment rail accepts (presence-only).
const CARD = { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo Buyer", expiry_date: "2032-09-01" };

function setup(opts: { verifier?: DelegatedVerifier; credentials?: Credential[]; policyAge?: PolicyAgeLookup; mountWith?: { policyAge: PolicyAgeLookup } } = {}) {
  const created = new Map<string, CeremonyOrder>();
  const completed = new Map<string, CompletedRecord>();
  const host = defineHost({
    catalog,
    orderStore: { read: (id) => created.get(id) ?? null },
    records: { read: (id) => completed.get(id), write: (rec) => void completed.set(rec.orderId, rec) },
    allowEphemeralKey: true,
  });
  const app = express();
  app.use(express.json());
  if (opts.verifier) app.locals.credentagent = { verifier: opts.verifier };
  host.publish(app);
  // A lookup the host itself publishes for the ceremony (e.g. a durable one) — set before mount.
  if (opts.policyAge) (app.locals.credentagent as Record<string, unknown>).policyAge = opts.policyAge;
  const credentagent = new CredentAgent({ walletOrigin: "http://127.0.0.1", ...(opts.credentials ? { credentials: opts.credentials } : {}) });
  // `mountWith` takes the explicit-seams path, `mount(app, { … })`; the rest come from app.locals.
  if (opts.mountWith) credentagent.mount(app, opts.mountWith);
  else credentagent.mount(app);
  // An order this instance knows of but never resolved (requirements() ran elsewhere, or before a restart).
  const create = (id: string, productId: string): CeremonyOrder => {
    const order = catalog.createOrder([{ productId, quantity: 1 }], id);
    created.set(id, order);
    return order;
  };
  const open = (id: string, productId: string, policy: Step[]): CeremonyOrder => {
    const order = create(id, productId);
    credentagent.requirements(order, policy);
    return order;
  };
  const input = (order: CeremonyOrder): CompletionInput => ({
    order, mandateId: "m", amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }],
  });
  return { app, host, credentagent, create, open, input, completed };
}

const proveAge = (app: express.Express, order: string, claims: Record<string, boolean>) =>
  request(app).post("/credentagent/credential/verify").send({ order, cred: "age", claims });
const pay = (app: express.Express, order: CeremonyOrder) =>
  request(app).post("/credentagent/dc-payment/verify").send({ order: order.id, amount: order.total, claims: CARD });

describe("#354 — the credential rail proves age at the POLICY's threshold", () => {
  it("BYPASS (invariant 5): a 21+ proof is refused under a 25+ policy on an untagged item", async () => {
    const s = setup();
    s.open("ORD-1", "gift-card", [required(age.over(25)), required(payment.in("usd"))]);
    const res = await proveAge(s.app, "ORD-1", { age_over_21: true });
    expect(res.body.verified).toBe(false);
    expect(res.body.gates[0].gate).toBe("Age over 25");
  });

  it("a 25+ proof is accepted under the same policy (control)", async () => {
    const s = setup();
    s.open("ORD-1", "gift-card", [required(age.over(25)), required(payment.in("usd"))]);
    const res = await proveAge(s.app, "ORD-1", { age_over_25: true });
    expect(res.body.verified).toBe(true);
  });

  it("an 18+ policy asks for 18+, not the old default of 21 (the threshold is the policy's, both ways)", async () => {
    const s = setup();
    s.open("ORD-1", "gift-card", [required(age.over(18)), required(payment.in("usd"))]);
    const res = await proveAge(s.app, "ORD-1", { age_over_18: true });
    expect(res.body.verified).toBe(true);
  });
});

describe("#354 — the shared completion requires the policy's age (every rail goes through it)", () => {
  it("BYPASS (invariant 1): paying for an untagged item under a 21+ policy with NO age proof is refused (reason 'age')", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(age.over(21)), required(payment.in("usd"))]);
    const res = await pay(s.app, order);
    expect(res.body).toMatchObject({ completed: false, reason: "age" });
    expect(s.completed.has("ORD-1")).toBe(false);
  });

  it("the same order completes once 21+ is proven on the credential rail (control)", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(age.over(21)), required(payment.in("usd"))]);
    expect((await proveAge(s.app, "ORD-1", { age_over_21: true })).body.verified).toBe(true);
    const res = await pay(s.app, order);
    expect(res.body.completed).toBe(true);
  });

  it("BYPASS (invariant 1): the host's own action path (host.complete) refuses it too", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(age.over(21))]);
    expect(await s.host.complete(s.input(order))).toMatchObject({ completed: false, reason: "age" });
    expect(s.completed.has("ORD-1")).toBe(false);
  });

  it("an order whose policy has NO age still completes with no age proof (control: unchanged)", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(payment.in("usd"))]);
    expect((await pay(s.app, order)).body.completed).toBe(true);
  });

  it("one order's age policy does not leak onto another order (invariant 4)", async () => {
    const s = setup();
    s.open("ORD-A", "gift-card", [required(age.over(21)), required(payment.in("usd"))]);
    const b = s.open("ORD-B", "gift-card", [required(payment.in("usd"))]);
    expect((await pay(s.app, b)).body.completed).toBe(true);
  });

  it("…nor on the host's own action path, which carries no policy ids: a policy with no age is remembered as none (invariant 4)", async () => {
    const s = setup();
    s.open("ORD-A", "gift-card", [required(age.over(21))]);
    const b = s.open("ORD-B", "gift-card", [required(payment.in("usd"))]);
    expect((await s.host.complete(s.input(b))).completed).toBe(true);
  });
});

describe("#354 — the delegated rail evaluates the verdict at the policy's threshold", () => {
  const verifierWith = (claims: Record<string, boolean>): DelegatedVerifier => ({
    buildRequest: vi.fn(async () => ({ reference: "ref-1", handoff: {} })),
    consume: vi.fn(async ({ reference }: { reference: string }) => ({
      approved: true,
      trust_level: "presence-only-demo" as const,
      claims: { age_mdl: claims },
      binding: { amount: 0, currency: "USD", payee: { id: "127.0.0.1" }, transactionId: reference },
    })),
  });
  const delegatedProof = async (app: express.Express, order: string) => {
    const { referenceToken } = (await request(app).get(`/credentagent/delegated/request?order=${order}`)).body as { referenceToken: string };
    return (await request(app).post("/credentagent/delegated/verify").send({ order, referenceToken })).body as { completed: boolean; reason?: string };
  };

  it("BYPASS (invariant 5): an 18+ verdict does not release an untagged action under a 21+ policy", async () => {
    const s = setup({ verifier: verifierWith({ age_over_18: true }) });
    s.open("REQ-1", "sealed-record", [required(age.over(21))]);
    const out = await delegatedProof(s.app, "REQ-1");
    expect(out).toMatchObject({ completed: false, reason: "age" });
    expect(s.completed.has("REQ-1")).toBe(false);
  });

  it("a 21+ verdict releases it (control)", async () => {
    const s = setup({ verifier: verifierWith({ age_over_21: true }) });
    s.open("REQ-1", "sealed-record", [required(age.over(21))]);
    expect((await delegatedProof(s.app, "REQ-1")).completed).toBe(true);
  });

  it("an 18+ policy is satisfied by an 18+ verdict (the verdict is read at the policy's age, not a default 21)", async () => {
    const s = setup({ verifier: verifierWith({ age_over_18: true }) });
    s.open("REQ-1", "sealed-record", [required(age.over(18))]);
    expect((await delegatedProof(s.app, "REQ-1")).completed).toBe(true);
  });
});

describe("#357 review — an order the server forgot keeps its age check", () => {
  it("BYPASS (invariant 1): after 10,000 newer checkouts evict it, paying with NO age proof is still refused", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(age.over(21)), required(payment.in("usd"))]);
    for (let i = 0; i < 10_000; i++) s.credentagent.requirements(catalog.createOrder([{ productId: "gift-card", quantity: 1 }], `ORD-X${i}`), [required(payment.in("usd"))]);
    const res = await pay(s.app, order);
    expect(res.body).toMatchObject({ completed: false, reason: "age" });
    expect(s.completed.has("ORD-1")).toBe(false);
  });

  it("BYPASS (invariant 1): an instance that never resolved the order (a restart, another worker) holds it to the age declared up front", async () => {
    const s = setup({ credentials: [age.over(21)] });
    const order = s.create("ORD-1", "gift-card");
    expect((await pay(s.app, order)).body).toMatchObject({ completed: false, reason: "age" });
  });

  it("…and that instance's credential page asks for the same age, so proving it there completes (page and completion agree)", async () => {
    const s = setup({ credentials: [age.over(25)] });
    const order = s.create("ORD-1", "gift-card");
    expect((await proveAge(s.app, "ORD-1", { age_over_25: true })).body.verified).toBe(true);
    expect((await pay(s.app, order)).body.completed).toBe(true);
  });

  it("BYPASS (invariant 1): a policy-age lookup the host supplied is consulted, not silently replaced by mount()", async () => {
    const s = setup({ policyAge: (id) => (id === "ORD-1" ? 21 : undefined) });
    const order = s.create("ORD-1", "gift-card");
    expect((await pay(s.app, order)).body).toMatchObject({ completed: false, reason: "age" });
  });

  it("BYPASS (invariant 1): …and so is one passed to mount(app, { policyAge }) (the explicit-seams path)", async () => {
    const s = setup({ mountWith: { policyAge: (id) => (id === "ORD-1" ? 21 : undefined) } });
    const order = s.create("ORD-1", "gift-card");
    expect((await pay(s.app, order)).body).toMatchObject({ completed: false, reason: "age" });
    expect(s.completed.has("ORD-1")).toBe(false);
  });
});

describe("#357 review — the age a proof was made at, and the policy's .when(), are what decide", () => {
  it("a 25+ proof made under a 25+ policy completes the order (the rail records the age it proved, not a default 21)", async () => {
    const s = setup();
    const order = s.open("ORD-1", "gift-card", [required(age.over(25)), required(payment.in("usd"))]);
    expect((await proveAge(s.app, "ORD-1", { age_over_25: true })).body.verified).toBe(true);
    expect((await pay(s.app, order)).body.completed).toBe(true);
  });

  it("an order the policy's .when() leaves out pays with no age proof (only the matching item needs it)", async () => {
    const s = setup();
    const isRecord = (o: { lines: { id: string }[] }) => o.lines.some((l) => l.id === "sealed-record");
    const order = s.open("ORD-1", "gift-card", [required(age.over(21).when(isRecord)), required(payment.in("usd"))]);
    expect((await pay(s.app, order)).body.completed).toBe(true);
  });

  it("…while the item the .when() matches is still refused without one (control)", async () => {
    const s = setup();
    const isRecord = (o: { lines: { id: string }[] }) => o.lines.some((l) => l.id === "sealed-record");
    const order = s.open("ORD-2", "sealed-record", [required(age.over(21).when(isRecord))]);
    expect(await s.host.complete(s.input(order))).toMatchObject({ completed: false, reason: "age" });
  });
});

describe("#357 review — age.over() refuses a threshold it could never check", () => {
  it.each([NaN, 0, -1, 20.5, Infinity])("age.over(%s) throws instead of switching the age check off", (n) => {
    expect(() => age.over(n)).toThrow(/whole number above 0/);
  });
});
