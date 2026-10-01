// The checkout page's paid view shows WHAT WAS PROVEN for the order, with the same Multipaz Tools
// links the payment page offers (Inspect, Issuer certificate, Check the signatures) and the
// "Order record ›" link to the store's order-status record.
import { describe, it, expect } from "vitest";
import { proofLinksHtml } from "./theme.js";
import { renderRequirements } from "./checkout-page.js";
import type { ProofEntry } from "./proofs.js";

const url = "https://tools.multipaz.org/mdocDeviceResponse#o2d2";
const cert = "https://tools.multipaz.org/x509#MIIC";
const proofs: ProofEntry[] = [
  { gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "t",
    presentation: { format: "mso_mdoc", deviceResponse: "o2d2", inspectUrl: url, issuerCertUrl: cert } },
  { gate: "Pay (USD)", rail: "instant-demo", trust_level: "presence-only-demo", checks: [], presentedAt: "t" },
];

describe("proofLinksHtml", () => {
  it("lists each proof with its level, Multipaz links for a wallet proof, the verifier, and the order record", () => {
    const html = proofLinksHtml(proofs, "/checkout/order-status?orderId=O1");
    expect(html).toContain("Age 21+");
    expect(html).toContain("presence-only-demo");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`href="${cert}"`);
    expect(html).toContain('href="https://tools.multipaz.org/verifier"');
    expect(html).toContain('href="/checkout/order-status?orderId=O1"');
    expect(html).toContain("instant demo");
    expect(html).toContain("does not check the issuer signature");
  });

  it("never links a non-Multipaz tool URL or an unsafe record URL", () => {
    const bad: ProofEntry[] = [{ ...proofs[0], presentation: { format: "mso_mdoc", deviceResponse: "x", inspectUrl: "javascript:alert(1)", issuerCertUrl: "https://evil.example/x509#x" } }];
    const html = proofLinksHtml(bad, "javascript:alert(1)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("tools.multipaz.org/verifier"); // no wallet proof to check
  });

  it("escapes the gate label", () => {
    expect(proofLinksHtml([{ ...proofs[1], gate: "<img src=x>" }], undefined)).not.toContain("<img");
  });

  it("renders nothing without proofs or a record link", () => {
    expect(proofLinksHtml(undefined, undefined)).toBe("");
  });

  it("the checkout page's paid view carries the proofs + order record", () => {
    const html = renderRequirements(
      { id: "O1", total: 124, currency: "USD", lines: [{ id: "w", name: "Whiskey", quantity: 1, unitPrice: 124 }] } as never,
      [],
      { ageVerified: true, loyaltyApplied: false },
      { paid: { amount: 124, currency: "USD", method: "dc-payment", proofs }, statusUrl: "/checkout/order-status?orderId=O1" },
    );
    expect(html).toContain("Order paid");
    expect(html).toContain("What was proven");
    expect(html).toContain(`href="${cert}"`);
    expect(html).toContain('href="/checkout/order-status?orderId=O1"');
  });
});
