// renderRequirements() — the ONE shared three-gate checkout page (T030 / CT13).
//
// These pin the load-bearing PRESENTATION properties of the unified renderer:
// numbered gates in policy order (payment LAST), live status (pending → ✓), payment
// locked until the blocking gate passes, the membership discount reflected in the
// total, the presence-only honesty note, and — the reason this lives in the package
// at all — ROUTE-AGNOSTICISM: each gate links to its OWN manifest `approveUrl`, so
// the demo's `/credential-gate/*` links and the storefront's `/credentagent/*` links both
// render unchanged through the same code.

import { describe, it, expect } from "vitest";
import { renderRequirements, renderManifestRail, type RenderOrder, type PaymentOptions } from "./checkout-page.js";
import type { VerificationManifestEntry } from "../types.js";

const order: RenderOrder = {
  id: "ORD-T030",
  lines: [{ name: "Oak Whiskey", quantity: 1, lineTotal: 124, currency: "USD" }],
  itemCount: 1,
  discount: 0,
  total: 124,
  currency: "USD",
};

// A full three-gate manifest with route-agnostic approveUrls (here the storefront's
// mounted shape). The demo passes its own `/credential-gate/*` links — same code.
const manifest: VerificationManifestEntry[] = [
  { credential: "age", required: true, effect: "gate", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Age 21+", minAge: 21, approveUrl: "/credentagent/credential?order=ORD-T030&cred=age" },
  { credential: "membership", required: false, effect: "discount", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "10% member discount", discountPct: 10, approveUrl: "/credentagent/credential?order=ORD-T030&cred=membership" },
  { credential: "payment", required: true, effect: "authorize", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Pay (USD)", approveUrl: "/credentagent/dc-payment?order=ORD-T030" },
];

describe("renderRequirements — numbered gates + live status", () => {
  it("renders the gates in policy order, numbered, with payment LAST", () => {
    // age verified so the payment section (locked while pending) is present to order-check.
    const html = renderRequirements(order, manifest, { ageVerified: true });
    const age = html.indexOf('<span class="step-no">1.</span>');
    const membership = html.indexOf('<span class="step-no">2.</span>');
    const payment = html.indexOf("3. Payment method");
    expect(age).toBeGreaterThan(-1);
    expect(membership).toBeGreaterThan(age);
    expect(payment).toBeGreaterThan(membership);
  });

  it("links each gate to its OWN approveUrl (route-agnostic — no hardcoded routes)", () => {
    const html = renderRequirements(order, manifest, {});
    expect(html).toContain("/credentagent/credential?order=ORD-T030&amp;cred=age");
    expect(html).toContain("/credentagent/credential?order=ORD-T030&amp;cred=membership");
    // The SAME code renders a demo-shaped manifest with /credential-gate/* links.
    const demoManifest: VerificationManifestEntry[] = [
      { ...manifest[0], approveUrl: "/credential-gate/age?order=TOK" },
    ];
    const demoHtml = renderRequirements(order, demoManifest, {});
    expect(demoHtml).toContain("/credential-gate/age?order=TOK");
    expect(demoHtml).not.toContain("/credentagent/");
  });

  it("flips a gate to ✓ once its verification is recorded (pending → ✓)", () => {
    const pending = renderRequirements(order, manifest, { ageVerified: false });
    expect(pending).toContain("Verify age (21+)");
    expect(pending).not.toContain("Age verified");
    const done = renderRequirements(order, manifest, { ageVerified: true });
    expect(done).toContain("✓ Age verified — 21+");
    expect(done).not.toContain("Verify age (21+)");
  });

  it("renders a CUSTOM gate with its OWN label/action (never age copy) + in the stepper (#46)", () => {
    const withCustom: VerificationManifestEntry[] = [
      manifest[0], // age
      { credential: "liquor-license", required: false, effect: "gate", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Liquor license", action: "Verify license", approveUrl: "/credentagent/credential?order=ORD-T030&cred=liquor-license" },
      manifest[1], // membership
      manifest[2], // payment
    ];
    const html = renderRequirements(order, withCustom, { ageVerified: false });
    expect(html).toContain("Verify license"); // the custom gate's OWN action verb
    expect(html).toContain("Liquor license required to continue."); // its own copy, not age's
    expect(html).toContain('rail-label">Liquor license'); // and a stepper step for it
    // The bug rendered the custom gate as a SECOND age gate — assert exactly one age button.
    expect((html.match(/Verify age/g) ?? []).length).toBe(1);
  });
});

describe("renderRequirements — payment lock (presentation only)", () => {
  const payment: PaymentOptions = {
    methods: [
      { value: "passkey", name: "Pay with passkey", desc: "Authorize on this device.", placeOrder: false, href: "/pay/passkey", checked: true },
      { value: "demo", name: "Place order (instant demo)", desc: "No real charge.", placeOrder: true },
    ],
    orderToken: "TOK",
  };

  it("withholds the WHOLE payment method group while the age gate is unverified", () => {
    const html = renderRequirements(order, manifest, { ageVerified: false }, { payment });
    expect(html).toContain("Payment is locked");
    expect(html).not.toContain('type="radio" name="pm"');
    expect(html).not.toContain("/pay/passkey");
  });

  it("offers the payment method group once the age gate passes", () => {
    const html = renderRequirements(order, manifest, { ageVerified: true }, { payment });
    expect(html).not.toContain("Payment is locked");
    expect(html.match(/type="radio" name="pm"/g)?.length).toBe(2);
    expect(html).toContain('value="passkey"');
    expect(html).toContain('value="demo"');
    expect(html).toContain("Pay $124.00");
  });

  it("a discount gate never blocks payment (only required gate effects do)", () => {
    // No age gate at all → a non-alcohol cart with only membership + payment.
    const noAge = manifest.filter((e) => e.credential !== "age");
    const html = renderRequirements(order, noAge, {}, { payment });
    expect(html).not.toContain("Payment is locked");
    expect(html).toContain('type="radio" name="pm"');
  });
});

describe("renderRequirements — discount, total, honesty", () => {
  it("reflects the membership discount in the total (host re-prices, renderer shows)", () => {
    const discounted: RenderOrder = { ...order, discount: 12.4, total: 111.6 };
    const html = renderRequirements(discounted, manifest, { loyaltyApplied: true });
    expect(html).toContain("Loyalty discount (10%)");
    expect(html).toContain("-$12.40");
    expect(html).toContain('<tr class="total"><td>Total</td><td class="num">$111.60</td></tr>');
    expect(html).toContain("✓ Loyalty discount applied (10% off)");
  });

  it("always states the presence-only honesty note (FR-011)", () => {
    const html = renderRequirements(order, manifest, {});
    // The discreet trust footer keeps the load-bearing presence-only-demo token and is
    // honest that the issuer trust anchor is not real (the wire crypto is).
    expect(html).toContain("presence-only-demo");
    expect(html).toContain("issuer trust anchor is not");
  });
});

describe("renderRequirements — paid revisit", () => {
  it("shows the paid banner and withholds the payment methods once completed", () => {
    const html = renderRequirements(order, manifest, {}, { paid: { amount: 124, currency: "USD", method: "passkey" } });
    expect(html).toContain("✓ Order paid · $124.00");
    expect(html).not.toContain('type="radio" name="pm"');
    expect(html).not.toContain("Apply loyalty discount");
    // The paid revisit prominently states the close-window / continue-in-agent handoff.
    expect(html).toContain("close this window");
    expect(html).toContain("continue in your agent");
  });

  it("anchors the paid total + renders the on-chain settlement proof when present", () => {
    const html = renderRequirements(order, manifest, {}, {
      paid: {
        amount: 111.6,
        currency: "USD",
        settlement: { network: "hedera-testnet", payer: { accountId: "0.0.5555" }, hashscanUrl: "https://hashscan.io/testnet/transaction/x" },
      },
    });
    expect(html).toContain("Order paid · $111.60 via x402");
    expect(html).toContain("HashScan");
    expect(html).toContain("0.0.5555");
  });

  // bfcache guard: a buyer who authorizes on a gate page then taps browser-BACK would
  // otherwise land on this checkout restored from the back/forward cache — the stale
  // pre-payment snapshot with a live Pay button, inviting a (server-idempotent but
  // confusing) resubmit. The page reloads itself on a bfcache restore so it always
  // re-fetches current server state. Present on EVERY render, paid or not.
  it("emits a pageshow/persisted reload guard so a bfcache-restored checkout can't re-pay", () => {
    const payable = renderRequirements(order, manifest, { ageVerified: true });
    expect(payable).toContain('addEventListener("pageshow"');
    expect(payable).toContain("e.persisted");
    expect(payable).toContain("location.reload()");
    // Also present on the paid revisit (defense in depth).
    const paidHtml = renderRequirements(order, manifest, {}, { paid: { amount: 124, currency: "USD", method: "passkey" } });
    expect(paidHtml).toContain('addEventListener("pageshow"');
  });
});

describe("renderManifestRail — one shared, manifest-driven stepper (hub + ceremony rails)", () => {
  const m: VerificationManifestEntry[] = [
    { credential: "age", required: true, effect: "gate", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Age 21+" },
    { credential: "liquor-license", required: false, effect: "gate", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Liquor license", action: "Verify license" },
    { credential: "membership", required: false, effect: "discount", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "10% off", discountPct: 10 },
    { credential: "payment", required: true, effect: "authorize", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Pay" },
  ];
  const labels = (html: string): string[] => [...html.matchAll(/rail-label">([^<]+)</g)].map((x) => x[1]);

  it("lists EVERY policy gate — custom + membership included — payment trailing", () => {
    expect(labels(renderManifestRail(m, "pay", {}))).toEqual(["Age", "Liquor license", "Membership", "Pay"]);
  });

  it("the rail page (current='pay') and the hub (no current) build the SAME steps — no divergence", () => {
    // This is the fix: the ceremony rails no longer derive a different stepper from the order.
    expect(labels(renderManifestRail(m, "pay", { ageVerified: true }))).toEqual(labels(renderManifestRail(m, undefined, { ageVerified: true })));
  });

  it("highlights the current step by credential key", () => {
    const html = renderManifestRail(m, "age", { ageVerified: false });
    expect(html).toContain('class="rail-step current"'); // the Age step is current
  });
});
