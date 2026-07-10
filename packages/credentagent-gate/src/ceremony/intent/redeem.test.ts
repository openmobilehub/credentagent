// redeemDraw bypass suite — the intent rail's agent-facing core, run over a REAL
// completeOrder as the shared completion seam (with a shared revocation store, the
// mount contract). Each control-dependent; mirrors the DelegatedGate suite but proves
// the rail path (redeem → shared completion) enforces the same bounds.
import { describe, it, expect } from "vitest";
import { redeemDraw, revokeGrant, type RedeemContext } from "./redeem.js";
import { MemoryRevocationStore } from "../revocation.js";
import { MemoryVerificationStore } from "../../store.js";
import { completeOrder } from "../completion.js";
import { sealIntent, signDraw, generateDelegate, type IntentBounds, type Draw } from "../mandate.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder, CompletionSeam } from "../types.js";

const PRICE: Record<string, number> = { coffee: 18, wine: 20 };
const MIN_AGE: Record<string, number> = { wine: 21 };
const catalog: CeremonyCatalog = {
  createOrder(items: CartItemRef[], id: string): CeremonyOrder {
    const lines = items.map(({ productId, quantity }) => ({
      id: productId, unitPrice: PRICE[productId], quantity, lineTotal: PRICE[productId] * quantity, currency: "USD",
      ...(MIN_AGE[productId] ? { minimumAge: MIN_AGE[productId] } : {}),
    }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id, lines, itemCount: items.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

function harness() {
  const revocation = new MemoryRevocationStore();
  const records = new Map();
  const completionCtx = {
    catalog,
    revocation,
    verificationStore: new MemoryVerificationStore(),
    records: { read: (id: string) => records.get(id), write: (r: { orderId: string }) => void records.set(r.orderId, r) },
  };
  // The rail's ctx: completion + the SAME revocation store (the mount contract).
  const ctx: RedeemContext = { completion: (input) => completeOrder(input, completionCtx as never), revocation };
  return { ctx, revocation };
}

async function grantFor(perOrder = 30, total = 100) {
  const { privateKey, delegate } = await generateDelegate();
  const intent = await sealIntent({
    type: "credentagent.IntentBounds/v0", merchants: ["blue-bottle"], currency: "USD",
    maxAmount: perOrder, totalAmount: total, delegate, presence: "delegated-demo", trust_level: "server-issued-demo",
  });
  return { intent, privateKey };
}

let seq = 0;
async function mkDraw(intent: IntentBounds, key: CryptoKey, o: { item: string; quantity?: number; merchant?: string; paymentId: string }) {
  const order = catalog.createOrder([{ productId: o.item, quantity: o.quantity ?? 1 }], `ORD-${++seq}`);
  const draw = await signDraw(
    { type: "credentagent.Draw/v0", intentId: intent.intentId, paymentMandateId: o.paymentId, merchant: o.merchant ?? "blue-bottle", amount: order.total, currency: "USD", pspTransactionId: o.paymentId },
    key,
  ) as Draw;
  return { order, draw };
}
// `CryptoKey` is the WebCrypto private key generateDelegate returns.
type CryptoKey = Awaited<ReturnType<typeof generateDelegate>>["privateKey"];

describe("intent rail redeem — bypass suite over the shared completion seam", () => {
  it("in-bounds draw completes: ok, catalog-priced amount, running balance, delegationId", async () => {
    const h = harness(); const g = await grantFor();
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    const r = await redeemDraw({ intent: g.intent, order, draw }, h.ctx);
    expect(r).toMatchObject({ ok: true, amount: 18, remaining: 82 });
    expect(r.delegationId).toBe(g.intent.intentId);
  });

  it("two draws draw the cumulative cap down; over-total is refused with headroom unchanged", async () => {
    const h = harness(); const g = await grantFor(30, 40);
    const a = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    expect(await redeemDraw({ intent: g.intent, order: a.order, draw: a.draw }, h.ctx)).toMatchObject({ ok: true, remaining: 22 });
    const b = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c2" });
    expect(await redeemDraw({ intent: g.intent, order: b.order, draw: b.draw }, h.ctx)).toMatchObject({ ok: true, remaining: 4 });
    const c = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c3" });
    expect(await redeemDraw({ intent: g.intent, order: c.order, draw: c.draw }, h.ctx)).toMatchObject({ ok: false, reason: "over-total", remaining: 4 });
  });

  it("reusing a paymentId → replay", async () => {
    const h = harness(); const g = await grantFor();
    const a = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    await redeemDraw({ intent: g.intent, order: a.order, draw: a.draw }, h.ctx);
    const b = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    expect(await redeemDraw({ intent: g.intent, order: b.order, draw: b.draw }, h.ctx)).toMatchObject({ ok: false, reason: "replay" });
  });

  it("over the per-order cap → over-cap", async () => {
    const h = harness(); const g = await grantFor(30, 100);
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", quantity: 3, paymentId: "c1" }); // $54 > $30
    expect(await redeemDraw({ intent: g.intent, order, draw }, h.ctx)).toMatchObject({ ok: false, reason: "over-cap", amount: 54 });
  });

  it("a store the grant never approved → out-of-scope", async () => {
    const h = harness(); const g = await grantFor();
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", merchant: "starbucks", paymentId: "c1" });
    expect(await redeemDraw({ intent: g.intent, order, draw }, h.ctx)).toMatchObject({ ok: false, reason: "out-of-scope" });
  });

  it("age-restricted cart via a draw → always step-up (non-delegable), even under the cap", async () => {
    const h = harness(); const g = await grantFor();
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "wine", paymentId: "c1" }); // $20 < $30
    expect(await redeemDraw({ intent: g.intent, order, draw }, h.ctx)).toMatchObject({ ok: false, reason: "step-up", retryable: "needs-human" });
  });

  it("a tampered-signature draw → signature", async () => {
    const h = harness(); const g = await grantFor();
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    const tampered = { ...draw, amount: 5 } as Draw;
    const r = await redeemDraw({ intent: g.intent, order, draw: tampered }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature");
  });

  it("revoke() then redeem → refused revoked", async () => {
    const h = harness(); const g = await grantFor();
    await revokeGrant(g.intent.intentId, h.ctx);
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    expect(await redeemDraw({ intent: g.intent, order, draw }, h.ctx)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("FAIL-CLOSED: an unreachable revocation store refuses (never fail-open)", async () => {
    const g = await grantFor();
    const throwing = { isRevoked() { throw new Error("down"); }, revoke() {}, revokeSubject() {}, priorDraws() { throw new Error("down"); }, commitDraw() { return { ok: true }; } };
    const completion: CompletionSeam = (input) => completeOrder(input, { catalog, revocation: throwing, verificationStore: new MemoryVerificationStore(), records: { read: () => undefined, write() {} } } as never);
    const ctx: RedeemContext = { completion, revocation: throwing as never };
    const { order, draw } = await mkDraw(g.intent, g.privateKey, { item: "coffee", paymentId: "c1" });
    const r = await redeemDraw({ intent: g.intent, order, draw }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("revocation-unavailable");
  });
});
