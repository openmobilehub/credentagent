// #331 — two stores on ONE host are two merchants. A person signs "up to $30 at the coffee
// store" (served at http://shop.example/coffee); an agent holding that permission must not be
// able to spend it at the wine store on the same host (http://shop.example/wine), whose budget
// for it would start at zero. Invariant 6: a signed permission is bound to the merchant it
// names, and the merchant's identity includes its base path.
//
// The real rail end to end — phone signs via /sign/request + /sign/verify (simulated wallet),
// the agent spends, each store verifies with its own checkout key.
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { verifyDelegatedPurchase } from "./index.js";
import { AgentKey, DelegatedIntent } from "./agent.js";
import { devSimulateWalletSignature } from "./ceremony/intent-sign/simulate.js";
import { merchantFor } from "./ap2/from-gate.js";
import type { UcpCheckout } from "./ap2/types.js";

const CATALOG = { coffee: { price: 18, category: "Beverages" } };
const HOST = "shop.example";
const ORIGIN = `http://${HOST}`; // what the browser and the wallet see — no path
const COFFEE = `${ORIGIN}/coffee`;
const WINE = `${ORIGIN}/wine`;

// A store served under a path by a proxy: the server sees paths WITHOUT the prefix.
function store(walletOrigin: string) {
  const credentagent = new CredentAgent({ walletOrigin, catalog: CATALOG, gateSecret: `secret-for-${walletOrigin}` });
  const app = express();
  app.use(express.json());
  credentagent.grants.serve(app);
  return { credentagent, app };
}

async function signOnPhone(app: Express, id: string) {
  const req = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
  expect(req.status).toBe(200);
  const oid = req.body as { requests: { data: { request: string } }[]; dcql_query: unknown; readerContextToken: string };
  const result = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query as never }, origin: ORIGIN });
  return request(app).post(`/credentagent/grants/${id}/sign/verify`).set("Host", HOST).send({ readerContextToken: oid.readerContextToken, result });
}

const cartAt = (origin: string): UcpCheckout => ({
  id: "ord_1",
  merchant: merchantFor(origin),
  line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 1800 }, quantity: 1, totals: [{ type: "total", amount: 1800 }] }],
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "total", amount: 1800 }],
  links: [],
});

/** The coffee store's permission, signed on the phone, spent by the agent at `at`. */
/** The coffee store's permission, signed on the phone — what the agent holds. */
async function coffeePermission() {
  const agentKey = AgentKey.generate();
  const coffee = store(COFFEE);
  const created = await coffee.credentagent.grants.create({ merchant: "coffee", budget: 200, perSpend: 30, allow: { skus: ["coffee"] }, agentKey: agentKey.publicJwk });
  expect((await signOnPhone(coffee.app, created.id)).body).toMatchObject({ ok: true, status: "authorized" });
  const grant = (await coffee.credentagent.grants.retrieve(created.id))!;
  return { agentKey, coffee, intent: DelegatedIntent.fromWalletPresentation(grant.mandate!.intent!) };
}

async function spendCoffeePermissionAt(atOrigin: string, at?: ReturnType<typeof store>) {
  const { agentKey, coffee, intent } = await coffeePermission();
  const target = at ?? coffee;
  const proof = await intent.spend({
    agentKey,
    checkoutJwt: target.credentagent.ap2.signCheckout(cartAt(atOrigin)),
    instrument: { id: "demo-instrument-0001", type: "card" },
    audience: atOrigin,
    nonce: "merchant-nonce",
  });
  return verifyDelegatedPurchase(proof, {
    trust: "presence-only-demo",
    audience: atOrigin,
    nonce: "merchant-nonce",
    checkoutKey: target.credentagent.ap2.checkoutPublicJwk,
    spent: { amount: 0, uses: 0 },
    price: (cart) => cart.line_items.reduce((sum, l) => sum + 1800 * l.quantity, 0),
  });
}

describe("#331 — a store's identity includes its base path", () => {
  it("merchantFor: host + base path; a root store keeps the bare host (already-signed permissions still match)", () => {
    expect(merchantFor("https://shop.example/coffee").id).toBe("shop.example/coffee");
    expect(merchantFor("https://shop.example/coffee/").id).toBe("shop.example/coffee");
    expect(merchantFor("https://shop.example").id).toBe("shop.example");
    expect(merchantFor("https://shop.example/").id).toBe("shop.example");
  });

  it("the permission spends at the store it was signed for, under its path", async () => {
    // Pins the WIRING: if the signing rail named the bare host, this store (whose own id is
    // host + path) would refuse its own permission.
    const verdict = await spendCoffeePermissionAt(COFFEE);
    expect(verdict).toMatchObject({ ok: true });
  });

  it("the permission the person signs names the store with its path", async () => {
    const { intent } = await coffeePermission();
    type Allowed = { type: string; allowed?: { id: string }[] };
    const ids = (m: { constraints: unknown[] }, type: string) =>
      (m.constraints as Allowed[]).find((c) => c.type === type)?.allowed?.map((x) => x.id);
    expect(ids(intent.openCheckout as never, "checkout.allowed_merchants")).toEqual(["shop.example/coffee"]);
    expect(ids(intent.openPayment as never, "payment.allowed_payees")).toEqual(["shop.example/coffee"]);
  });

  it("REFUSES the coffee store's permission at the store at the host's root (bypass)", async () => {
    const verdict = await spendCoffeePermissionAt(ORIGIN, store(ORIGIN));
    expect(verdict).toMatchObject({ ok: false, code: "constraint" });
  });

  it("REFUSES the coffee store's permission at the wine store on the same host (bypass)", async () => {
    const verdict = await spendCoffeePermissionAt(WINE, store(WINE));
    expect(verdict).toMatchObject({ ok: false, code: "constraint" });
    if (verdict.ok) return;
    expect(verdict.violations?.map((v) => v.constraint)).toEqual(expect.arrayContaining(["checkout.allowed_merchants", "payment.allowed_payees"]));
  });
});
