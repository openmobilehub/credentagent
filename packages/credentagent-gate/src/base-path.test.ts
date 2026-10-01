// A gate served under a path by a proxy (https://shop.example/store/* → this server's /*).
// The server sees request paths WITHOUT the prefix, so every URL a page hands the browser —
// fetches, links, form actions, redirects, the service-worker import — must put it back, or
// the buyer's browser asks the proxy for /credentagent/... and gets a 404 (or another app).
// Setting `walletOrigin` to the public URL WITH its path is the whole configuration.
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { age, payment, required } from "./credentials.js";
import { basePathOf } from "./ceremony/origin.js";

const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages" },
};
const wineOrder = () => ({ id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] });

// A root-relative gate/checkout URL in markup or script — i.e. one that did NOT get the prefix.
// A prefixed URL starts `"/store/…`, so it never matches.
const UNPREFIXED = /["'`(=]\/(credentagent|checkout)[/?"'`]/;

function agent(walletOrigin: string): CredentAgent {
  return new CredentAgent({ walletOrigin, catalog: CATALOG, loyaltyDiscountPct: 10, gateSecret: "stable-test-secret" });
}
function serve(ca: CredentAgent): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  ca.grants.serve(app);
  ca.orders.serve(app);
  return app;
}

describe("basePathOf", () => {
  it("is the URL's path without a trailing slash, and empty for a bare origin", () => {
    expect(basePathOf("https://shop.example/store")).toBe("/store");
    expect(basePathOf("https://shop.example/store/")).toBe("/store");
    expect(basePathOf("https://shop.example/a/b")).toBe("/a/b");
    expect(basePathOf("https://shop.example")).toBe("");
    expect(basePathOf("https://shop.example/")).toBe("");
    expect(basePathOf(undefined)).toBe("");
    expect(basePathOf("not a url")).toBe("");
  });
});

describe("walletOrigin with a path — every browser URL carries it", () => {
  const ORIGIN = "https://shop.example/store";

  it("a click-to-approve grant: approve link, step links, form actions and the redirect", async () => {
    const ca = agent(ORIGIN);
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] }, signing: "page" });
    expect(g.approveUrl).toBe(`${ORIGIN}/credentagent/grants/${g.id}`);

    const page = await request(app).get(`/credentagent/grants/${g.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`action="/store/credentagent/grants/${g.id}/approve"`);
    expect(page.text).toContain(`href="/store/credentagent/grants/${g.id}/membership"`);
    expect(page.text).not.toMatch(UNPREFIXED);

    // The age step's own page: its request/verify calls and the way back carry the prefix.
    const ageStep = await request(app).get(`/credentagent/grants/${g.id}/age`);
    expect(ageStep.status).toBe(200);
    expect(ageStep.text).toContain(`/store/credentagent/grants/${g.id}/age/verify`);
    expect(ageStep.text).not.toMatch(UNPREFIXED);

    const approved = await request(app).post(`/credentagent/grants/${g.id}/approve`);
    expect(approved.status).toBe(303);
    expect(approved.headers.location).toBe(`/store/credentagent/grants/${g.id}`);
  });

  it("a device-signed grant: the signing page's request/verify calls", async () => {
    const ca = agent(ORIGIN);
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "device" });
    const page = await request(app).get(`/credentagent/grants/${g.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`fetch("/store/credentagent/grants/"`);
    expect(page.text).not.toMatch(UNPREFIXED);
  });

  it("orders.serve: the checkout page, and each rail page it links to", async () => {
    const ca = agent(ORIGIN);
    const app = serve(ca);
    const { id, approveUrl } = await ca.orders.create({ order: wineOrder(), policy: [required(age.over(21)), required(payment.in("usd"))] });
    expect(approveUrl).toBe(`${ORIGIN}/credentagent/orders/${id}`);

    const hub = await request(app).get(`/credentagent/orders/${id}`);
    expect(hub.status).toBe(200);
    expect(hub.text).toContain(`/store/credentagent/orders/${id}/status`);
    expect(hub.text).not.toMatch(UNPREFIXED);

    const rails = [
      `/credentagent/credential?order=${id}&cred=age`,
      `/credentagent/passkey?order=${id}`,
      `/credentagent/dc-payment?order=${id}`,
    ];
    for (const path of rails) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).not.toMatch(UNPREFIXED);
    }
    const passkey = await request(app).get(`/credentagent/passkey?order=${id}`);
    expect(passkey.text).toContain(`from "/store/credentagent/lib/sw/index.js"`);
    expect(passkey.text).toContain(`"/store/credentagent/passkey/options"`);
  });
});

// CONTROL: without a path nothing changes — the same pages keep their root-relative URLs.
// (Also proves UNPREFIXED actually detects them, so the assertions above aren't vacuous.)
describe("walletOrigin without a path — root-relative URLs, as before", () => {
  it("serves the grant and rail pages at the root", async () => {
    const ca = agent("https://shop.example");
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" });
    const page = await request(app).get(`/credentagent/grants/${g.id}`);
    expect(page.text).toContain(`action="/credentagent/grants/${g.id}/approve"`);
    expect(page.text).toMatch(UNPREFIXED);

    const { id } = await ca.orders.create({ order: wineOrder(), policy: [required(age.over(21)), required(payment.in("usd"))] });
    const passkey = await request(app).get(`/credentagent/passkey?order=${id}`);
    expect(passkey.text).toContain(`from "/credentagent/lib/sw/index.js"`);
  });
});
