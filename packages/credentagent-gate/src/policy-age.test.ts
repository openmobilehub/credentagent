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
import type { Step } from "./types.js";

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

function setup(opts: { verifier?: DelegatedVerifier } = {}) {
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
  const credentagent = new CredentAgent({ walletOrigin: "http://127.0.0.1" });
  credentagent.mount(app);
  const open = (id: string, productId: string, policy: Step[]): CeremonyOrder => {
    const order = catalog.createOrder([{ productId, quantity: 1 }], id);
    created.set(id, order);
    credentagent.requirements(order, policy);
    return order;
  };
  const input = (order: CeremonyOrder): CompletionInput => ({
    order, mandateId: "m", amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }],
  });
  return { app, host, open, input, completed };
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
