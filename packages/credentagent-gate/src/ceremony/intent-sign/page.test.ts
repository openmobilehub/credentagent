// Honesty tests for the intent-sign ceremony page (spec 012, FR-4). The device-signed
// trust line is the single honesty surface here, and — like the presence-only footer —
// host branding must NEVER be able to alter or remove it. These are bypass tests: they
// fail the moment the trust disclosure drifts or branding leaks into it.
import { describe, it, expect } from "vitest";
import { deviceSignedTrustFooter } from "../theme.js";
import { renderIntentSignPage } from "./page.js";
import type { Branding } from "../../types.js";

// The exact device-signed disclosure — kept literal so a drift fails the test.
const FOOTER = `<div class="trust"><div class="trust-line">🔒 device-signed · secured by CredentAgent · the device signature is real; the trust anchor is a demo credential (no issuer verification yet)</div></div>`;

const args = {
  grantId: "grant_x",
  merchant: "utopia",
  budget: 200,
  perSpend: 130,
  allow: { categories: ["Beverages"] },
};

describe("intent-sign page — honesty (FR-4)", () => {
  it("deviceSignedTrustFooter states the device-signed level + the demo-anchor caveat", () => {
    const f = deviceSignedTrustFooter();
    expect(f).toBe(FOOTER);
    expect(f).toContain("device-signed");
    expect(f).toContain("the trust anchor is a demo credential");
  });

  it("the page carries the device-signed trust line, NOT presence-only-demo", () => {
    const html = renderIntentSignPage(args);
    expect(html).toContain(FOOTER);
    expect(html).not.toContain("presence-only-demo");
    expect(html).not.toContain("issuer-verified");
  });

  it("branding cannot alter or remove the trust line (bypass)", () => {
    const branding: Branding = { wordmark: "ACME", accent: "#7c3aed" };
    const plain = renderIntentSignPage(args);
    const branded = renderIntentSignPage({ ...args, branding });
    // The chrome changes (wordmark), but the trust footer is byte-identical.
    expect(branded).toContain("ACME");
    expect(branded).toContain(FOOTER);
    expect(plain).toContain(FOOTER);
  });

  it("shows the bounds the human is authorizing", () => {
    const html = renderIntentSignPage(args);
    expect(html).toContain("$200");
    expect(html).toContain("$130");
    expect(html).toContain("Beverages");
    expect(html).toContain("Sign with your wallet");
  });

  // A grant is scoped to one merchant; "who am I authorizing spend to" is consent-tier and must
  // render even without a description. This pins the always-visible structured bound set so the
  // guarantee never depends on the caller passing a description sentence.
  it("ALWAYS renders merchant + budget + per-purchase for a grant with NO description", () => {
    const html = renderIntentSignPage({ grantId: "grant_y", merchant: "utopia", budget: 200, perSpend: 130 });
    expect(html).not.toContain("undefined");
    expect(html).toContain("utopia"); // the merchant — who is being authorized
    expect(html).toContain("$200"); // total budget
    expect(html).toContain("$130"); // per-purchase cap
  });
});
