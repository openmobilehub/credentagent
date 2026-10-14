// #330 — the consent pages must not run script from their own URL. A buyer can be sent a
// crafted link to a REAL order's payment / ID page; the `?cart=` value (the stateless-orders
// cart mandate) used to land in the page raw: in the passkey page's `href`, and inside
// `<script>` via JSON.stringify (which does not escape `</script>`). Invariant 6-adjacent:
// the page is the buyer's view of what they are approving, so it must be ours alone.
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "../client.js";
import { age, payment, required } from "../credentials.js";
import { scriptJson } from "./script-json.js";
import type { CeremonyCatalog } from "./types.js";

const CATALOG = { wine: { price: 21, minAge: 21, category: "Beverages" } };
const wineOrder = () => ({ id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] });

// Breaks out of an attribute (`"`), and out of an inline script (`</script>`).
const ATTACK = `x"><img src=x onerror=alert(1)></script><script>alert(2)</script>`;

function serve(ca: CredentAgent): Express {
  const app = express();
  app.use(express.json());
  ca.orders.serve(app);
  return app;
}

// orders.serve() supplies its own return link, so here only the passkey page's
// same-device ⇄ phone toggle `href` carried the raw cart.
describe("#330 — orders.serve(): a crafted ?cart= cannot inject markup into the passkey page", () => {
  it("REFUSES to echo a hostile cart value raw in the toggle link", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example", catalog: CATALOG, gateSecret: "stable-test-secret" });
    const app = serve(ca);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: [required(age.over(21)), required(payment.in("usd"))] });

    const res = await request(app).get(`/credentagent/passkey?order=${id}&cart=${encodeURIComponent(ATTACK)}`);
    expect(res.status).toBe(200);
    // Neither breakout survives: no attribute escape, no early </script>, no injected tag.
    expect(res.text).not.toContain(`"><img`);
    expect(res.text).not.toContain("<script>alert(2)");
    expect(res.text).not.toContain("onerror=alert(1)>");
  });
});

// The plain mount(app, ceremony) path sets no returnUrl, so each page builds its default
// "back to checkout" link from the raw `cart` — the route where `</script>` reached RETURN_URL.
describe("#330 — mount(): the default return link cannot carry a hostile cart into <script>", () => {
  const catalog: CeremonyCatalog = {
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
      orderStore: { read: async (id) => catalog.createOrder([{ productId: "wine", quantity: 1 }], id) },
      catalog,
      completion: async () => ({ completed: true }),
      signingKey: "stable-test-secret",
    });
    return app;
  }

  for (const path of ["/credentagent/passkey?order=ORD-1", "/credentagent/credential?order=ORD-1&cred=age", "/credentagent/dc-payment?order=ORD-1"]) {
    it(`REFUSES to echo a hostile cart value raw: ${path.split("?")[0]}`, async () => {
      const res = await request(mounted()).get(`${path}&cart=${encodeURIComponent(ATTACK)}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(`"><img`);
      expect(res.text).not.toContain("<script>alert(2)");
      expect(res.text).not.toContain("onerror=alert(1)>");
    });
  }
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
