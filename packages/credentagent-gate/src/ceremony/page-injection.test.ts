// #330 / #321 — the consent pages must not run script from their own URL. A buyer can be sent
// a crafted link to a REAL order's payment / ID page; the `?cart=` value (the stateless-orders
// cart mandate) used to land in the page raw: in the passkey page's `href`, and inside
// `<script>` via JSON.stringify (which does not escape `</script>`). Invariant 6-adjacent:
// the page is the buyer's view of what they are approving, so it must be ours alone.
//
// TWO controls, each pinned on its own (a test that only goes red when BOTH are removed pins
// neither):
//   1. `cart` is URL-encoded where it joins a link — asserted POSITIVELY: the link must carry
//      the encoded form, which a raw join never produces.
//   2. every value inside a page's <script> goes through scriptJson — asserted with an input
//      that never passes through control 1 (a hostile order id, a hostile method href).
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "../client.js";
import { age, payment, required } from "../credentials.js";
import { scriptJson } from "./script-json.js";
import { renderRequirements } from "./checkout-page.js";
import type { CeremonyCatalog } from "./types.js";

const CATALOG = { wine: { price: 21, minAge: 21, category: "Beverages" } };
const wineOrder = () => ({ id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] });

// Breaks out of an attribute (`"`), and out of an inline script (`</script>`).
const ATTACK = `x"><img src=x onerror=alert(1)></script><script>alert(2)</script>`;
// What a correct join puts after `cart=`: only URL-safe characters, so no layer rewrites it.
const ENCODED = encodeURIComponent(ATTACK);
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function serve(ca: CredentAgent): Express {
  const app = express();
  app.use(express.json());
  ca.orders.serve(app);
  return app;
}

// ── control 1: cart is URL-encoded where it joins a link ─────────────────────

// orders.serve() supplies its own return link, so here only the passkey page's
// same-device ⇄ phone toggle `href` carried the raw cart.
describe("#330 — orders.serve(): the passkey toggle link carries the cart URL-encoded", () => {
  it("REFUSES to echo a hostile cart value raw in the toggle link", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example", catalog: CATALOG, gateSecret: "stable-test-secret" });
    const app = serve(ca);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: [required(age.over(21)), required(payment.in("usd"))] });

    const res = await request(app).get(`/credentagent/passkey?order=${id}&cart=${ENCODED}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(new RegExp(`class="toggle" href="[^"]*&cart=${re(ENCODED)}"`));
    expect(res.text).not.toContain(`"><img`);
  });
});

// The plain mount(app, ceremony) path sets no returnUrl, so each page builds its default
// "back to checkout" link from `cart` — the route where `</script>` reached RETURN_URL.
const mountCatalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 21, currency: "USD", quantity: it.quantity, lineTotal: 21 * it.quantity }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};
function mounted(): Express {
  const app = express();
  app.use(express.json());
  new CredentAgent({ walletOrigin: "https://shop.example" }).mount(app, {
    // Returns whatever id is asked for — as a host with caller-chosen order ids would.
    orderStore: { read: async (id) => mountCatalog.createOrder([{ productId: "wine", quantity: 1 }], id) },
    catalog: mountCatalog,
    completion: async () => ({ completed: true }),
    signingKey: "stable-test-secret",
  });
  return app;
}
const PAGES = ["/credentagent/passkey?", "/credentagent/credential?cred=age&", "/credentagent/dc-payment?"];
const pageName = (p: string) => p.split("?")[0];

describe("#330 — mount(): the default return link carries the cart URL-encoded", () => {
  for (const page of PAGES) {
    it(`REFUSES to put a hostile cart into RETURN_URL raw: ${pageName(page)}`, async () => {
      const res = await request(mounted()).get(`${page}order=ORD-1&cart=${ENCODED}`);
      expect(res.status).toBe(200);
      // `&` is scriptJson-escaped inside <script>; what follows `cart=` must be the encoded form.
      expect(res.text).toMatch(new RegExp(`RETURN_URL = "[^"]*cart=${re(ENCODED)}"`));
    });
  }
});

// ── control 2: scriptJson for every value inside a page's <script> ───────────

const EVIL_ID = `ORD</script><script>alert(3)</script>`;

describe("#330 — scriptJson: a value inside a page's <script> cannot close it", () => {
  for (const page of PAGES) {
    it(`REFUSES to let a hostile order id end the script: ${pageName(page)}`, async () => {
      const res = await request(mounted()).get(`${page}order=${encodeURIComponent(EVIL_ID)}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script>alert(3)");
    });
  }

  it("REFUSES to let a hostile payment-method link end the checkout page's script", () => {
    const html = renderRequirements(
      { id: "ORD-1", lines: [{ name: "Wine", quantity: 1, lineTotal: 21, currency: "USD" }], itemCount: 1, discount: 0, total: 21, currency: "USD" },
      [],
      {},
      { payment: { methods: [{ value: "passkey", name: "Pay", desc: "Pay.", href: `/pay?cart=x</script><script>alert(4)</script>`, checked: true }], orderToken: "TOK" } },
    );
    expect(html).not.toContain("<script>alert(4)");
  });
});

describe("scriptJson — a JS literal that cannot close its <script>", () => {
  it("escapes <, > and & (and U+2028/9) while keeping the value identical", () => {
    const v = { url: "/x?a=1&b=</script><script>alert(1)</script>", ls: "a\u2028b\u2029c" };
    const out = scriptJson(v);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(v);
  });
  it("matches JSON.stringify for values with nothing to escape", () => {
    for (const v of ["plain", 42, true, null, ["a", { b: 1 }]]) expect(scriptJson(v)).toBe(JSON.stringify(v));
  });
});
