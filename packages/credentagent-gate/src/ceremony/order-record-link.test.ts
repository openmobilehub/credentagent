// The "Order record ›" link on the payment pages: once an order completes, the buyer can open the
// store's own order-status JSON (the completed order, proofs included). The host says where that
// lives through the `statusUrl` seam (the storefront: /checkout/order-status; orders.serve: its
// /credentagent/orders/:id/status). Absent ⇒ no link.
import { describe, it, expect } from "vitest";
import { renderDcPaymentPage } from "./dc-payment/page.js";
import { renderPasskeyPage } from "./passkey/page.js";
import { recordLinkScript } from "./theme.js";
import { CredentAgent } from "../client.js";
import type { CeremonyOrder } from "./types.js";

const order: CeremonyOrder = { id: "O1", lines: [], itemCount: 0, subtotal: 5, discount: 0, total: 5, currency: "USD" };

describe("Order record link on the payment pages", () => {
  it("dc-payment and passkey render the link for the order's status URL once it completes", () => {
    const url = "/checkout/order-status?orderId=O1";
    for (const html of [
      renderDcPaymentPage({ order: "O1", total: 5, currency: "USD", lines: [], statusUrl: url }),
      renderPasskeyPage({ order, statusUrl: url }),
    ]) {
      expect(html).toContain(JSON.stringify(url));
      expect(html).toContain("showRecordLink()");
      expect(html).toContain("Order record");
    }
  });

  it("no statusUrl → the helper is a no-op (no link)", () => {
    expect(recordLinkScript(undefined)).toBe("function showRecordLink(){}");
  });

  it("only a root-relative path or an https URL is ever linked", () => {
    expect(recordLinkScript("javascript:alert(1)")).toBe("function showRecordLink(){}");
    expect(recordLinkScript("//evil.example/x")).toBe("function showRecordLink(){}");
    expect(recordLinkScript("https://shop.example/credentagent/orders/O1/status")).toContain("https://shop.example/credentagent/orders/O1/status");
  });

  it("orders.serve points the pay pages at its own status route", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const get = new Map<string, Function>();
    const app = { locals: {} as Record<string, unknown>, get: (p: string, ...h: unknown[]) => { get.set(p, h[h.length - 1] as Function); }, post: () => {}, use: () => {} };
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: { id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 5 }] }, policy: [] });
    let body = "";
    const res = { status() { return res; }, type() { return res; }, send(b: string) { body = b; return res; }, json() { return res; } };
    await get.get("/credentagent/dc-payment")!({ query: { order: id }, headers: { host: "localhost:4000" }, protocol: "http" }, res);
    expect(body).toContain(JSON.stringify(`/credentagent/orders/${id}/status`));
  });
});
