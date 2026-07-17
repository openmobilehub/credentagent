// The DelegatedGate facade must produce the same verdicts as the raw seams, through a
// Stripe-grade surface. These pin that the ceremony is wired correctly (catalog re-price,
// single-use, scope, age-non-delegable, revocation, per-grant isolation) — each
// assertion control-dependent.
import { describe, it, expect } from "vitest";
import { DelegatedGate } from "./delegated.js";

const catalog = { coffee: 18, wine: { price: 20, minAge: 21 } };

async function grantFor(gate = new DelegatedGate({ catalog }), perOrder = 30, total = 100) {
  return gate.preApprove({ merchant: "blue-bottle", perOrder, total, description: "coffee, up to $30/order" });
}

describe("DelegatedGate — Stripe-grade facade over the delegated seams", () => {
  it("an in-bounds spend completes: ok, catalog-priced amount, delegationId, no throw", async () => {
    const grant = await grantFor();
    const res = await grant.spend({ idempotencyKey: "c1", item: "coffee" });
    expect(res.ok).toBe(true);
    expect(res.amount).toBe(18); // priced by the gate, not passed in
    expect(res.delegationId).toBe(grant.id);
  });

  it("BYPASS (#5): a safe retry with the SAME idempotency key returns the same result, charged ONCE", async () => {
    const grant = await grantFor();
    const first = await grant.spend({ idempotencyKey: "c1", item: "coffee" });
    // The network timed out and the caller never saw the ack, so it safely retries the SAME
    // purchase with the SAME key. It must echo the original completion, not draw a second time.
    const retry = await grant.spend({ idempotencyKey: "c1", item: "coffee" });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true); // idempotent echo — not a replay refusal, not a second charge
    expect(retry.delegationId).toBe(first.delegationId);
    // The load-bearing assertion: headroom is UNCHANGED by the retry ⇒ exactly one draw
    // committed. With the old per-call order id, the retry minted a fresh order and
    // double-drew — remaining would fall a second time and this fails.
    expect(retry.remaining).toBe(first.remaining);
  });

  it("over the per-order cap → refused over-cap (3 × $18 = $54 > $30)", async () => {
    const grant = await grantFor();
    const res = await grant.spend({ idempotencyKey: "c2", item: "coffee", quantity: 3 });
    expect(res).toMatchObject({ ok: false, reason: "over-cap", amount: 54 });
  });

  it("a store the grant never approved → refused out-of-scope", async () => {
    const grant = await grantFor();
    const res = await grant.spend({ idempotencyKey: "c3", item: "coffee", merchant: "starbucks" });
    expect(res).toMatchObject({ ok: false, reason: "out-of-scope" });
  });

  it("age-restricted goods are non-delegable → refused step-up (needs-human) even under the cap", async () => {
    const grant = await grantFor();
    const res = await grant.spend({ idempotencyKey: "c4", item: "wine" }); // $20 < $30 cap, still refused
    expect(res).toMatchObject({ ok: false, reason: "step-up", retryable: "needs-human" });
  });

  it("revoke() makes the next spend die → refused revoked", async () => {
    const grant = await grantFor();
    await grant.revoke();
    const res = await grant.spend({ idempotencyKey: "c5", item: "coffee" });
    expect(res).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("draws down the cumulative cap: remaining falls per approved spend, and over-total is refused", async () => {
    const grant = await grantFor(new DelegatedGate({ catalog }), 30, 40); // perOrder 30, total 40
    const a = await grant.spend({ idempotencyKey: "c1", item: "coffee" }); // $18
    expect(a).toMatchObject({ ok: true, remaining: 22 }); // 40 − 18
    const b = await grant.spend({ idempotencyKey: "c2", item: "coffee" }); // $18 more
    expect(b).toMatchObject({ ok: true, remaining: 4 }); // 40 − 36
    const c = await grant.spend({ idempotencyKey: "c3", item: "coffee" }); // would be 54 > 40
    expect(c).toMatchObject({ ok: false, reason: "over-total", remaining: 4 }); // refused; headroom unchanged
  });

  // ── Regressions for the two review-found bugs ────────────────────────────────

  it("PER-GRANT ISOLATION: a second grant on the SAME gate is not bypassed by the first's records", async () => {
    const gate = new DelegatedGate({ catalog });
    const a = await grantFor(gate);
    const b = await grantFor(gate);
    await a.spend({ idempotencyKey: "c1", item: "coffee" }); // A succeeds, writes a record (ORD id A-1)
    await b.revoke();
    // B is revoked; its spend must be refused, NOT echo A's completion via a colliding order id.
    const res = await b.spend({ idempotencyKey: "c1", item: "coffee" });
    expect(res).toMatchObject({ ok: false, reason: "revoked" });
    expect(res.delegationId).toBeUndefined(); // (a delegationId here would be the idempotency-bypass fingerprint)
  });

  it("an unknown item id is a programming error → throws a helpful message (not a silent refusal)", async () => {
    const grant = await grantFor();
    await expect(grant.spend({ idempotencyKey: "cX", item: "tea" })).rejects.toThrow(/unknown catalog item "tea"/);
  });

  it("the honesty axis is carried in the types and readable through the facade (constitution VII)", async () => {
    const grant = await grantFor();
    expect(grant.presence).toBe("delegated-demo");
    expect(grant.trustLevel).toBe("server-issued-demo"); // weaker than presence-only-demo; would fail if set to a real value
    expect(grant.id.startsWith("int_")).toBe(true);
  });
});
