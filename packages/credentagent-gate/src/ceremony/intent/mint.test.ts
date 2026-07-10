import { describe, it, expect } from "vitest";
import { mintGrant } from "./mint.js";
import { contentAddressId, signDraw, checkDraw } from "../mandate.js";

describe("intent rail — mintGrant", () => {
  it("seals a content-addressed grant carrying the demo honesty labels", async () => {
    const { grant } = await mintGrant({ merchant: "blue-bottle", perOrder: 30, total: 100, description: "coffee" });
    expect(grant.intentId.startsWith("int_")).toBe(true);
    expect(await contentAddressId(grant)).toBe(grant.intentId);
    expect(grant.presence).toBe("delegated-demo");
    expect(grant.trust_level).toBe("server-issued-demo"); // fails if a real trust value leaks in
    expect(grant.merchants).toEqual(["blue-bottle"]);
    expect(grant.maxAmount).toBe(30);
    expect(grant.totalAmount).toBe(100);
  });

  it("returns a delegate key that can sign a draw the grant accepts", async () => {
    const { grant, delegateKey } = await mintGrant({ merchant: "blue-bottle", perOrder: 30, total: 100 });
    const draw = await signDraw(
      { type: "credentagent.Draw/v0", intentId: grant.intentId, paymentMandateId: "c1", merchant: "blue-bottle", amount: 18, currency: "USD", pspTransactionId: "c1" },
      delegateKey,
    );
    const r = await checkDraw(grant, draw, { now: Date.parse("2026-07-15T00:00:00Z") });
    expect(r.ok).toBe(true); // the minted key is the one the sealed bounds name
  });
});
