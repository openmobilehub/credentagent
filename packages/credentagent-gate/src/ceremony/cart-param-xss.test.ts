// The consent pages carry `?cart=` (the stateless-orders cart mandate) from their own URL into
// links back to checkout and into an inline <script>. The value is attacker-controlled — anyone can
// craft the link — and the pages run on the gate's own origin, where the buyer approves a payment.
// These pin (#321): a hostile `cart` never reaches the HTML as markup, on every rail that carries
// it, while a real (base64url) cart mandate still rides through unchanged.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { mountCeremony } from "./mount.js";
import { inlineJson } from "./theme.js";
import { MemoryVerificationStore } from "../store.js";
import type { CeremonyCatalog, CeremonyOrder } from "./types.js";

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 124, currency: "USD", quantity: it.quantity, lineTotal: 124 * it.quantity, minimumAge: 21 }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

function app(returnUrl?: (orderId: string) => string) {
  const orders = new Map<string, CeremonyOrder>([["ORD-1", catalog.createOrder([{ productId: "whiskey", quantity: 1 }], "ORD-1")]]);
  const a = express();
  mountCeremony(a as never, {
    verificationStore: new MemoryVerificationStore(),
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: "stable-test-secret",
    ...(returnUrl ? { returnUrl } : {}),
  });
  return a;
}

const PAGES = [
  ["passkey", "/credentagent/passkey?order=ORD-1"],
  ["passkey (cross-device)", "/credentagent/passkey?order=ORD-1&xdev=1"],
  ["credential", "/credentagent/credential?order=ORD-1&cred=age"],
  ["dc-payment", "/credentagent/dc-payment?order=ORD-1"],
] as const;

// Breaks out of an href="…" attribute, and out of the inline <script> the return URL lands in.
const ATTRIBUTE_BREAKOUT = '"><img src=x onerror=alert(1)>';
const SCRIPT_BREAKOUT = "</script><script>alert(2)</script>";

describe("?cart= on the consent pages (#321)", () => {
  for (const [rail, path] of PAGES) {
    it(`REFUSES a script injected through ?cart= on the ${rail} page`, async () => {
      for (const payload of [ATTRIBUTE_BREAKOUT, SCRIPT_BREAKOUT]) {
        const res = await request(app()).get(`${path}&cart=${encodeURIComponent(payload)}`);
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(payload);
        expect(res.text).not.toContain("<img src=x");
        expect(res.text).not.toContain("<script>alert(2)");
      }
    });

    it(`a real (base64url) cart mandate still rides through unchanged on the ${rail} page`, async () => {
      const cart = Buffer.from(JSON.stringify({ v: 1, lines: [{ id: "whiskey", quantity: 1 }] })).toString("base64url");
      const res = await request(app()).get(`${path}&cart=${cart}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(`cart=${cart}`);
    });
  }
});

// The second layer: whatever string reaches an inline <script> (the return URL, the done banner,
// the refusal notices) is written so it can never close the element — even a value that never
// passed through ?cart=, such as a host's own returnUrl built from something a user typed.
describe("inline <script> values can't close the script (#321)", () => {
  it("inlineJson keeps the value but never writes a tag", () => {
    const value = "</script><script>alert(3)</script>\u2028";
    const js = inlineJson(value);
    expect(js).not.toContain("<");
    expect(js).not.toContain("\u2028");
    expect(JSON.parse(js)).toBe(value);
    expect(inlineJson(undefined)).toBe("undefined");
  });

  for (const [rail, path] of PAGES) {
    it(`REFUSES a host return URL that would close the ${rail} page's script`, async () => {
      const res = await request(app(() => `/checkout?next=${SCRIPT_BREAKOUT}`)).get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script>alert(2)");
    });
  }
});
