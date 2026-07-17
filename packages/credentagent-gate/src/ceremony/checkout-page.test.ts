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
import { renderRequirements, type RenderOrder, type PaymentOptions } from "./checkout-page.js";
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

// ── 007: a CUSTOM gate renders from its own label and unlocks on verifiedGates ──
// Pins the checkout-hub blockers Diego reported: a custom gate must NOT render as an age
// gate, and its per-order proof (verifiedGates) must clear the lock. Each assertion fails
// against the pre-007 age-only hub.
describe("renderRequirements — custom gate (007)", () => {
  const customManifest: VerificationManifestEntry[] = [
    { credential: "professional_license", required: true, effect: "gate", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Professional license", approveUrl: "/credentagent/credential?order=ORD-T030&cred=professional_license" },
    { credential: "payment", required: true, effect: "authorize", enforcedAt: "checkout", trust_level: "presence-only-demo", label: "Pay (USD)", approveUrl: "/credentagent/dc-payment?order=ORD-T030" },
  ];
  const payment: PaymentOptions = { methods: [{ value: "passkey", name: "Pay with passkey", desc: "Authorize.", href: "/pay/passkey", checked: true }], orderToken: "TOK" };

  it("renders the credential's OWN label, not an age gate, and links to its approveUrl", () => {
    const html = renderRequirements(order, customManifest, {}, { payment });
    expect(html).toContain("Professional license");
    expect(html).not.toContain("Verify age");
    expect(html).not.toContain("age-restricted");
    expect(html).toContain("/credentagent/credential?order=ORD-T030&amp;cred=professional_license");
  });

  it("BLOCKS payment while the custom gate is unproven", () => {
    const html = renderRequirements(order, customManifest, {}, { payment });
    expect(html).toContain("Payment is locked");
    expect(html).not.toContain('type="radio" name="pm"');
  });

  it("UNLOCKS payment and flips the gate to ✓ once verifiedGates records the proof", () => {
    const html = renderRequirements(order, customManifest, { verifiedGates: { professional_license: true } }, { payment });
    expect(html).not.toContain("Payment is locked"); // FAILS on the pre-007 age-only isSatisfied
    expect(html).toContain('type="radio" name="pm"');
    expect(html).toContain("✓ Professional license verified");
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

// ── #63: a standing /checkout tab reflects a completion made elsewhere ──────────
// The hub is server-rendered once; a payment completed on another tab/device/rail would
// otherwise leave this tab showing "Payment is locked" until a manual refresh. When the
// host supplies a status endpoint, the page polls it and reloads on completion. Route-
// agnostic: the host owns the URL (same pattern as payment.placeOrderPath).
describe("renderRequirements — live completion poll (#63)", () => {
  const statusUrl = "/checkout/order-status?orderId=ORD-T030";

  it("polls the host status URL and reloads on completion while the order is unpaid", () => {
    const html = renderRequirements(order, manifest, { ageVerified: true }, { statusUrl });
    expect(html).toContain(statusUrl); // the exact host URL, verbatim (route-agnostic)
    expect(html).toContain("setInterval"); // an open tab flips itself, no manual refresh
    expect(html).toContain(".completed"); // keys off the server's completion flag
    expect(html).toContain("location.reload()");
  });

  it("does NOT poll once the order is already paid (no redundant reload loop)", () => {
    const html = renderRequirements(order, manifest, {}, { statusUrl, paid: { amount: 124, currency: "USD", method: "passkey" } });
    expect(html).not.toContain(statusUrl);
  });

  it("emits no poll when the host supplies no statusUrl (unchanged for hosts without one)", () => {
    const html = renderRequirements(order, manifest, { ageVerified: true });
    expect(html).not.toContain("/checkout/order-status");
    expect(html).not.toContain("setInterval");
  });
});

// ── #46 follow-up: the hub stepper must AGREE with the ceremony-rail stepper ─────────────
// #62 made the ceremony rails order-derived (theme.ts `checkoutRail`): Membership appears
// ONLY when the loyalty discount is actually applied. The hub stepper still derived
// Membership from the policy MANIFEST — shown whenever merely OFFERED — and ticked it ✓ on
// ANY paid order. So a paid, full-price order rendered a phantom "Membership ✓" the buyer
// never earned, and the desktop hub (Age·Membership·Pay) disagreed with the mobile rail
// (Age·Pay) for the same order. These pin the hub to the SAME order-derived rule; each is
// RED against the old manifest-derived `done: loyaltyApplied || paid` line.
describe("renderRequirements — hub stepper agrees with the ceremony rail (#46)", () => {
  const railLabels = (html: string): string[] =>
    [...html.matchAll(/rail-label">([^<]*)</g)].map((m) => m[1]);

  it("shows ONLY Age · Pay when the loyalty discount is offered but NOT applied (no phantom Membership)", () => {
    const html = renderRequirements(order, manifest, { ageVerified: false }); // discount not applied
    expect(railLabels(html)).toEqual(["Age", "Pay"]);
  });

  it("never phantom-ticks Membership ✓ on a paid, full-price order (no discount earned)", () => {
    const html = renderRequirements(order, manifest, {}, { paid: { amount: 124, currency: "USD", method: "passkey" } });
    expect(railLabels(html)).not.toContain("Membership");
  });

  it("adds Membership as a ✓ step only once the discount is actually applied", () => {
    const discounted: RenderOrder = { ...order, discount: 12, total: 112 };
    const html = renderRequirements(discounted, manifest, { ageVerified: true, loyaltyApplied: true });
    expect(railLabels(html)).toEqual(["Age", "Membership", "Pay"]);
    // the Membership dot carries the ✓ (done) — earned here, not a phantom
    expect(html).toMatch(/rail-step done"><div class="rail-dot">✓<\/div><div class="rail-label">Membership</);
  });

  it("keeps Membership on a PAID discounted order, reconciled from the paid amount (completion clears the flag)", () => {
    // completion.ts clears this order's verification, so `loyaltyApplied` is false on the
    // paid revisit — but the order WAS paid at a loyalty discount (the summary derives the
    // row from lineSum − paid.amount). The stepper must agree with that receipt, not the
    // cleared flag, or it drops a Membership the buyer earned and disagrees with the rail.
    const html = renderRequirements(order, manifest, {}, { paid: { amount: 111.6, currency: "USD", method: "passkey" } });
    expect(html).toContain("Loyalty discount");                     // receipt: a discount WAS applied
    expect(railLabels(html)).toEqual(["Age", "Membership", "Pay"]); // …so the stepper must show it too
  });
});
