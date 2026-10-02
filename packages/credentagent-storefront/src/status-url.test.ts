// The storefront tells the gate where an order's status record lives, so the payment pages can
// link "Order record ›" to the SAME /checkout/order-status the widget polls (proofs included).
import { describe, it, expect } from "vitest";
import { createStorefront } from "./server.js";

describe("storefront statusUrl seam", () => {
  it("publishes /checkout/order-status for the gate's pay pages (id URL-encoded)", () => {
    const { app } = createStorefront();
    const locals = app.locals.credentagent as { statusUrl?: (id: string) => string };
    expect(locals.statusUrl?.("ORD-1")).toBe("/checkout/order-status?orderId=ORD-1");
    expect(locals.statusUrl?.("a&b")).toBe("/checkout/order-status?orderId=a%26b");
  });
});
