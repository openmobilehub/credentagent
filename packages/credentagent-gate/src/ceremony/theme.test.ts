// Tests for host branding on the ceremony pages (issue #61). Branding customises the
// chrome — wordmark, accent, logo, the DEMO pill — and NOTHING else. The load-bearing
// assertions here are the two the issue calls out:
//   1. Honesty fence: the `presence-only-demo` trust footer is byte-identical in the
//      default AND branded renders — no branding input can alter or remove it. This is a
//      bypass test: it FAILS if someone threads branding into `trustFooter()`.
//   2. Injection: a hostile wordmark / accent / logo is escaped or dropped, never emitted
//      as live HTML/CSS on the consent page a buyer sees.

import { describe, it, expect } from "vitest";
import { pageHead, brandHeader, trustFooter, orderSummaryCard } from "./theme.js";
import { renderCredentialPage } from "./credential-gate/page.js";
import { renderPasskeyPage } from "./passkey/page.js";
import { renderDcPaymentPage } from "./dc-payment/page.js";
import { renderRequirements } from "./checkout-page.js";
import { mountCeremony, type CeremonyApp, type CeremonySeams } from "./mount.js";
import { CredentAgent } from "../client.js";
import { MemoryVerificationStore } from "../store.js";
import type { Branding } from "../types.js";
import type { CeremonyCatalog, CeremonyOrder } from "./types.js";

// The canonical honesty footer — the load-bearing presence-only-demo disclosure. Branding
// must NEVER change this (issue #61 out-of-scope / FR-011). Kept as an exact literal so a
// test fails the moment the footer text drifts.
const FOOTER = `<div class="trust"><div class="trust-line">🔒 presence-only-demo · secured by CredentAgent · the wire crypto is real; issuer trust anchor is not</div></div>`;

const order: CeremonyOrder = {
  id: "ORD-1",
  lines: [{ id: "oak", name: "Oak Whiskey", unitPrice: 124, currency: "USD", quantity: 1, lineTotal: 124, minimumAge: 21 }],
  itemCount: 1,
  subtotal: 124,
  discount: 0,
  total: 124,
  currency: "USD",
};

// Render each of the four ceremony pages the gate serves, given a branding (or none).
function everyPage(branding?: Branding): { name: string; html: string }[] {
  return [
    { name: "checkout hub", html: renderRequirements({ id: order.id, lines: order.lines.map((l) => ({ name: l.name, id: l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })), itemCount: 1, discount: 0, total: order.total, currency: order.currency }, [], {}, branding ? { branding } : {}) },
    { name: "passkey", html: renderPasskeyPage({ order, ...(branding ? { branding } : {}) }) },
    { name: "dc-payment", html: renderDcPaymentPage({ order: order.id, total: order.total, currency: order.currency, lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })), ...(branding ? { branding } : {}) }) },
    { name: "credential (age)", html: renderCredentialPage({ kind: "age", order: order.id, ...(branding ? { branding } : {}) }) },
  ];
}

describe("brandHeader — no branding renders byte-for-byte as today", () => {
  it("is the exact CREDENTAGENT wordmark + DEMO pill (brand row only)", () => {
    expect(brandHeader()).toBe(`<div class="brand"><span class="wordmark">CREDENTAGENT</span><span class="demo-pill">DEMO</span></div>`);
  });
  it("is unchanged with a heading block", () => {
    expect(brandHeader({ h1: "Checkout", tagline: "Prove it. Then pay." })).toBe(
      `<div class="brand"><span class="wordmark">CREDENTAGENT</span><span class="demo-pill">DEMO</span></div><div class="head"><h1>Checkout</h1><p class="tagline">Prove it. Then pay.</p></div>`,
    );
  });
});

describe("pageHead — no branding adds no override CSS (byte-for-byte)", () => {
  it("keeps the built-in accent and emits no branding override or logo rule", () => {
    const head = pageHead("Checkout · ORD-1");
    expect(head).toContain("--accent: #0d9488"); // the design-system default is intact
    expect(head).not.toContain(":root{--accent:"); // no override block was appended
    expect(head).not.toContain(".brand-logo{");
  });
});

describe("brandHeader — branding customises the chrome", () => {
  it("replaces the wordmark", () => {
    const h = brandHeader({}, { wordmark: "ACME" });
    expect(h).toContain(`<span class="wordmark">ACME</span>`);
    expect(h).not.toContain("CREDENTAGENT");
  });
  it("hides the DEMO pill when demoPill is false", () => {
    expect(brandHeader({}, { demoPill: false })).not.toContain("demo-pill");
    expect(brandHeader({}, { demoPill: true })).toContain("demo-pill"); // default stays shown
  });
  it("renders a logo image instead of the wordmark, with the wordmark as alt text", () => {
    const h = brandHeader({}, { wordmark: "ACME", logo: "https://cdn.example/logo.png" });
    expect(h).toContain(`<img class="brand-logo" src="https://cdn.example/logo.png" alt="ACME" />`);
    expect(h).not.toContain(`<span class="wordmark">`);
  });
});

describe("pageHead — branding overrides the accent + logo styles", () => {
  it("appends an accent override with a derived hover shade", () => {
    const head = pageHead("T", "", { accent: "#7c3aed" });
    // Derivation is deterministic: each channel × 0.86, rounded → #6b32cc.
    expect(head).toContain(":root{--accent:#7c3aed;--accent-hover:#6b32cc;}");
  });
  it("adds the .brand-logo rule only when a logo is set", () => {
    expect(pageHead("T", "", { logo: "data:image/png;base64,AAAA" })).toContain(".brand-logo{");
    expect(pageHead("T", "", { wordmark: "ACME" })).not.toContain(".brand-logo{");
  });
});

describe("every ceremony page reflects the branding set once (acceptance)", () => {
  const branding: Branding = { wordmark: "ACME", accent: "#7c3aed" };
  for (const { name, html } of everyPage(branding)) {
    it(`${name} carries the wordmark and accent`, () => {
      expect(html).toContain("ACME");
      expect(html).toContain("--accent:#7c3aed");
    });
  }
});

describe("HONESTY FENCE — the presence-only-demo footer is unbrandable (bypass test)", () => {
  it("trustFooter is the exact disclosure and takes no branding", () => {
    expect(trustFooter()).toBe(FOOTER);
    expect(trustFooter()).toContain("presence-only-demo");
  });

  // Load-bearing: render each page BOTH default and with a hostile brand, and assert the
  // footer literal is present and IDENTICAL in both. If a change threaded branding into the
  // footer (e.g. interpolated the wordmark or accent into the trust line), the exact FOOTER
  // string would no longer be a substring and these assertions would fail — i.e. the test
  // fails when the honesty control is removed.
  const hostileBrand: Branding = { wordmark: "PHARMACORP✔ verified-safe", accent: "#ff0000", logo: "https://evil.example/x.png", demoPill: false };
  for (const { name, html } of everyPage()) {
    it(`${name} (default) contains the unchanged footer`, () => {
      expect(html).toContain(FOOTER);
    });
  }
  for (const { name, html } of everyPage(hostileBrand)) {
    it(`${name} (branded) contains the SAME unchanged footer`, () => {
      expect(html).toContain(FOOTER); // byte-identical to the default render's footer
      // The brand DID apply elsewhere (so the footer's fixedness isn't because branding was
      // silently ignored) — the wordmark shows in the header, never in the trust line.
      expect(html).toContain("PHARMACORP");
      const trust = html.slice(html.indexOf(`<div class="trust">`));
      expect(trust).not.toContain("PHARMACORP");
      expect(trust).not.toContain("#ff0000");
    });
  }
});

describe("INJECTION — a hostile branding value is escaped or dropped, never live", () => {
  it("escapes a wordmark containing HTML", () => {
    const h = brandHeader({}, { wordmark: "<script>alert(1)</script>" });
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the wordmark exactly ONCE in the logo alt text (no double-encode of A&B)", () => {
    const h = brandHeader({}, { wordmark: "A&B", logo: "https://cdn.example/logo.png" });
    expect(h).toContain(`alt="A&amp;B"`); // single-escaped → the DOM alt renders "A&B"
    expect(h).not.toContain("A&amp;amp;B"); // never double-escaped
  });

  it("drops a bare-word accent that is not a real colour (misspelled named colour)", () => {
    // "purpel" would otherwise emit an INVALID var(--accent); it must be dropped so the
    // built-in teal stays (the allowlist-and-drop promise). Named colours are not supported —
    // even a valid one like "teal" is dropped; pass its hex instead.
    expect(pageHead("T", "", { accent: "purpel" })).not.toContain(":root{--accent:");
    expect(pageHead("T", "", { accent: "teal" })).not.toContain(":root{--accent:");
    // A real hex / functional colour still applies.
    expect(pageHead("T", "", { accent: "#7c3aed" })).toContain(":root{--accent:#7c3aed");
    expect(pageHead("T", "", { accent: "rgb(124, 58, 237)" })).toContain(":root{--accent:rgb(124, 58, 237)");
  });

  it("drops an accent that tries to break out of the <style> block", () => {
    const head = pageHead("T", "", { accent: "red;} </style><script>alert(1)</script>" });
    expect(head).not.toContain("<script>"); // the payload never reaches the page
    expect(head).not.toContain(":root{--accent:"); // and no override was emitted — falls back to default
  });

  it("drops an accent carrying an extra CSS declaration", () => {
    expect(pageHead("T", "", { accent: "#000;background:url(https://evil.example)" })).not.toContain(":root{--accent:");
  });

  it("drops a logo with a non-image scheme (falls back to the wordmark)", () => {
    const h = brandHeader({}, { wordmark: "ACME", logo: "javascript:alert(1)" });
    expect(h).not.toContain("javascript:");
    expect(h).not.toContain("<img");
    expect(h).toContain(`<span class="wordmark">ACME</span>`);
  });

  it("escapes an attribute-breakout attempt in an allowed-scheme logo URL", () => {
    const h = brandHeader({}, { logo: 'https://x"><script>alert(1)</script>' });
    expect(h).not.toContain("<script>"); // the quote is escaped, so the src can't be closed early
    expect(h).toContain("&quot;");
  });
});

describe("THREADING — branding flows from new CredentAgent({ branding }) to the ceremony context", () => {
  const catalog: CeremonyCatalog = {
    createOrder: (items, id) => ({ id, lines: items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 0, currency: "USD", quantity: it.quantity, lineTotal: 0 })), itemCount: 0, subtotal: 0, discount: 0, total: 0, currency: "USD" }),
  };

  it("mountCeremony puts the branding seam on the resolved context (which the rails read)", () => {
    const app: CeremonyApp = { locals: {} };
    const seams: CeremonySeams = {
      verificationStore: new MemoryVerificationStore(),
      orderStore: { read: async () => null },
      catalog,
      completion: async () => ({ completed: true }),
      signingKey: "k",
      branding: { wordmark: "ACME" },
    };
    const ctx = mountCeremony(app, seams);
    expect(ctx.branding).toEqual({ wordmark: "ACME" });
  });

  it("new CredentAgent({ branding }).mount(app, seams) wires branding end-to-end onto app.locals", () => {
    const app: CeremonyApp = { locals: {} };
    const ca = new CredentAgent({ branding: { wordmark: "ACME", accent: "#7c3aed" } });
    ca.mount(app, { orderStore: { read: async () => null }, catalog, completion: async () => ({ completed: true }), signingKey: "k" });
    expect((app.locals.credentagent as { branding?: Branding }).branding).toEqual({ wordmark: "ACME", accent: "#7c3aed" });
  });
});

// ── An identity gate has no amounts to show (#141 follow-up) ─────────────────────────────
// The summary card is the ONLY thing telling a user WHAT they are proving a credential for,
// so it must stay — but a policy with no payment credential prices nothing, and rendering
// "$0.00 / Total $0.00" on a "prove you are 21" page frames an access decision as a free
// purchase. `showAmounts` defaults to true, so every checkout page keeps its totals.
describe("orderSummaryCard — amounts are suppressible for a non-payment ceremony", () => {
  const lines = [{ name: "Sealed record — patient-7", quantity: 1, lineTotal: 0, currency: "USD" }];

  it("keeps the subject but drops the money when showAmounts is false", () => {
    const html = orderSummaryCard({ lines, total: 0, currency: "USD", caption: "Request REQ-1", showAmounts: false });
    expect(html).toContain("Sealed record — patient-7"); // WHAT is being gated stays
    expect(html).toContain("Request REQ-1");
    expect(html).not.toContain("$0.00");
    expect(html).not.toMatch(/<tr class="total">/);
  });

  it("renders the money by default — every checkout page is unchanged (control)", () => {
    const html = orderSummaryCard({
      lines: [{ name: "oak-whiskey", quantity: 1, lineTotal: 124, currency: "USD" }],
      total: 124, currency: "USD", caption: "Order ORD-1",
    });
    expect(html).toContain("$124.00");
    expect(html).toMatch(/<tr class="total">/);
  });
});
