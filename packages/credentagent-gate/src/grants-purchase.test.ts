// Agent-signed purchases over HTTP (opt-in: `agents: { trust: "presence-only-demo" }`). The agent holds
// its own key; the store exposes three grant-scoped routes (permission, quote, proof) and runs
// `verifyDelegatedPurchase` with ITS audience, nonce, ledger and catalog price. A verified purchase
// finishes through the shared completion path (`orders.retrieve`, `order.settled`). Every refusal
// below leaves the budget and the set of settled orders exactly as they were.
import { describe, it, expect, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { AgentKey, DelegatedIntent } from "./agent.js";
import { devSimulateWalletSignature } from "./ceremony/intent-sign/simulate.js";
import { p256 } from "./ceremony/intent-sign/dev-wallet.js";
import { appendAgentHop } from "./ap2/chain/hop.js";
import { walletChain } from "./ap2/chain/serialize.js";
import { digestToken } from "./ap2/sdjwt.js";
import { VCT } from "./ap2/types.js";
import { defineCredential, dcql, gate } from "./credentials.js";
import { MemoryOrderStore, type CompletedOrder } from "./orders.js";
import type { Credential } from "./types.js";
import { MAX_RETAINED_QUOTES_PER_GRANT } from "./grants-purchase.js";

const HOST = "shop.example";
const ORIGIN = `http://${HOST}`;
const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  tea: { price: 12, category: "Beverages" },
  whiskey: { price: 40, category: "Beverages", minAge: 21 },
  lamp: { price: 25, category: "Home" },
};
const INSTRUMENT = { id: "demo-instrument-0001", type: "card" } as const;

async function signOnPhone(app: Express, id: string) {
  const req = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
  const oid = req.body as { requests: { data: { request: string } }[]; dcql_query: unknown; readerContextToken: string };
  const result = await devSimulateWalletSignature({
    request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query as never },
    origin: ORIGIN,
  });
  return request(app).post(`/credentagent/grants/${id}/sign/verify`).set("Host", HOST).send({ readerContextToken: oid.readerContextToken, result });
}

interface Opts {
  budget?: number; perSpend?: number; allow?: { skus?: string[]; categories?: string[] }; age?: number; sign?: boolean;
  optIn?: boolean; credentials?: Credential[];
  completedOrderStore?: MemoryOrderStore<CompletedOrder>; membership?: boolean; loyaltyDiscountPct?: number;
}

/** A store, an agent with its own key, and a grant the person signed (or left pending). */
async function setup(o: Opts = {}) {
  const agentKey = AgentKey.generate();
  const catalog = structuredClone(CATALOG) as Record<string, { price: number; category?: string; minAge?: number; requiresRx?: boolean }>;
  const credentagent = new CredentAgent({
    walletOrigin: ORIGIN,
    catalog,
    gateSecret: "stable-test-secret",
    ...(o.optIn === false ? {} : { agents: { trust: "presence-only-demo" as const } }),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    ...(o.completedOrderStore ? { completedOrderStore: o.completedOrderStore } : {}),
    ...(o.loyaltyDiscountPct ? { loyaltyDiscountPct: o.loyaltyDiscountPct } : {}),
  });
  // The orders the host HEARD about: what `order.settled` fired for, through the shared completion path.
  const orders = new Set<string>();
  credentagent.on("order.settled", ({ id }) => orders.add(id));
  const app = express();
  app.use(express.json());
  credentagent.grants.serve(app);
  const created = await credentagent.grants.create({
    merchant: "utopia",
    budget: o.budget ?? 100,
    perSpend: o.perSpend ?? 30,
    allow: o.allow ?? { categories: ["Beverages"] },
    agentKey: agentKey.publicJwk,
  });
  if (o.age) expect(await credentagent.grants._recordAgeProof(created.id, { provenAge: o.age })).toBe(true);
  if (o.membership) expect(await credentagent.grants._recordMembershipProof(created.id, { membershipNumber: "GOLD-0001" })).toBe(true);
  if (o.sign !== false) expect((await signOnPhone(app, created.id)).body).toMatchObject({ ok: true, status: "authorized" });
  return { app, agentKey, credentagent, orders, catalog, grantId: created.id };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const base = (c: Ctx, grantId = c.grantId) => `/credentagent/grants/${grantId}`;
const quote = (c: Ctx, body: unknown, grantId = c.grantId) =>
  request(c.app).post(`${base(c, grantId)}/purchases`).set("Host", HOST).send(body as object);
const submit = (c: Ctx, nonce: string, proof: unknown, grantId = c.grantId) =>
  request(c.app).post(`${base(c, grantId)}/purchases/${nonce}/proof`).set("Host", HOST).send({ proof });

/** The agent half: fetch the permission, then sign the quoted cart with ITS key. */
async function signQuote(c: Ctx, q: { nonce: string; checkoutJwt: string; audience: string }, agentKey = c.agentKey, grantId = c.grantId) {
  const deleg = await request(c.app).get(`${base(c, grantId)}/delegation`).set("Host", HOST);
  expect(deleg.body.ok).toBe(true);
  return DelegatedIntent.fromWalletPresentation(deleg.body.intent).spend({
    agentKey,
    checkoutJwt: q.checkoutJwt,
    instrument: INSTRUMENT,
    audience: q.audience,
    nonce: q.nonce,
  });
}
/** A whole purchase, success or refusal. */
async function buy(c: Ctx, sku: string, qty?: number) {
  const q = await quote(c, { sku, ...(qty !== undefined ? { qty } : {}) });
  if (!q.body.ok) return { quote: q.body, proof: undefined };
  const proof = await signQuote(c, q.body.quote);
  return { quote: q.body, proof: (await submit(c, q.body.quote.nonce, proof)).body };
}
const remaining = async (c: Ctx) => (await (await c.credentagent.grants.retrieve(c.grantId))!.usage()).remaining;

describe("a valid agent-signed purchase", () => {
  it("is accepted, records one order, and draws the catalog price from the grant", async () => {
    const c = await setup();
    const { proof } = await buy(c, "coffee");
    expect(proof).toMatchObject({ ok: true, receipt: { amount: 18, remaining: 82, trustLevel: "presence-only-demo" } });
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(82);
  });

  it("finishes through the shared completion path: orders.retrieve finds it and order.settled fired once", async () => {
    const c = await setup();
    const { proof } = await buy(c, "coffee");
    const found = await c.credentagent.orders.retrieve(proof.receipt.orderId);
    expect(found).toMatchObject({ ok: true, trustLevel: "presence-only-demo", completion: { amount: 18, currency: "USD", method: "delegated-agent" } });
    expect([...c.orders]).toEqual([proof.receipt.orderId]);
  });

  it("works next to orders.serve (whose order store is read-only): no 500, one order, one draw", async () => {
    const c = await setup();
    c.credentagent.orders.serve(c.app);
    const { proof } = await buy(c, "coffee");
    expect(proof).toMatchObject({ ok: true, receipt: { remaining: 82 } });
    expect(c.orders.size).toBe(1);
  });
});

describe("the proof is checked against the key the grant names", () => {
  it("refuses a checkout hop signed by a key the grant does not name", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const honest = await signQuote(c, q.body.quote);
    // The client library refuses to sign with the wrong key, so forge the hop by hand: a
    // genuine permission and cart, but the agent's hop signed by an impostor's key.
    const deleg = (await request(c.app).get(`${base(c)}/delegation`).set("Host", HOST)).body.intent;
    const intent = DelegatedIntent.fromWalletPresentation(deleg);
    const forged = await appendAgentHop({
      chain: walletChain(deleg.presentation, intent.disclosures.checkout)!,
      agentKey: p256().privateKey,
      content: { vct: VCT.checkout, checkout_jwt: q.body.quote.checkoutJwt, checkout_hash: digestToken(q.body.quote.checkoutJwt), iat: Math.floor(Date.now() / 1000) },
      audience: q.body.quote.audience,
      nonce: q.body.quote.nonce,
    });
    const r = await submit(c, q.body.quote.nonce, { checkout: forged, payment: honest.payment });
    expect(r.body).toMatchObject({ ok: false, code: "signature" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });
});

describe("the nonce is single-use, bound to one grant, and short-lived", () => {
  it("answers the same proof posted again with the SAME receipt (replayed), and buys nothing twice", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    const first = (await submit(c, q.body.quote.nonce, proof)).body;
    expect(first.ok).toBe(true);
    const again = (await submit(c, q.body.quote.nonce, proof)).body;
    expect(again).toMatchObject({ ok: true, receipt: { orderId: first.receipt.orderId, amount: 18, replayed: true } });
    expect(first.receipt.replayed).toBeUndefined();
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(82);
  });

  it("refuses a DIFFERENT proof on a used nonce (nonce-used) and records no second order or draw", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    expect((await submit(c, q.body.quote.nonce, await signQuote(c, q.body.quote))).body.ok).toBe(true);
    const other = await signQuote(c, q.body.quote); // a fresh signature: not the proof that used the nonce
    expect((await submit(c, q.body.quote.nonce, other)).body).toMatchObject({ ok: false, code: "nonce-used" });
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(82);
  });

  it("lets only one of two CONCURRENT submissions of one nonce buy: the other waits and gets the same receipt", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    // A shared grant store answers on a later turn of the event loop. Model that: if the nonce were only
    // consumed AFTER a read like this one, both requests would see it unused.
    const retrieve = c.credentagent.grants.retrieve.bind(c.credentagent.grants);
    c.credentagent.grants.retrieve = async (id: string) => { await new Promise((r) => setTimeout(r, 20)); return retrieve(id); };
    const [a, b] = await Promise.all([submit(c, q.body.quote.nonce, proof), submit(c, q.body.quote.nonce, proof)]);
    expect([a.body.ok, b.body.ok]).toEqual([true, true]);
    expect(a.body.receipt.orderId).toBe(b.body.receipt.orderId);
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(82);
  });

  it("refuses a nonce the store never issued", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    expect((await submit(c, "made-up-nonce", proof)).body).toMatchObject({ ok: false, code: "nonce-used" });
  });

  it("refuses a nonce issued for grant A when it is submitted under grant B, and leaves A's budget alone", async () => {
    const a = await setup();
    const b = await setup();
    const q = await quote(a, { sku: "coffee" });
    const proof = await signQuote(a, q.body.quote);
    const r = await submit(a, q.body.quote.nonce, proof, b.grantId); // a's app, b's grant id
    expect(r.body.ok).toBe(false);
    expect(await remaining(a)).toBe(100);
    expect(a.orders.size).toBe(0);
  });

  it("refuses grant A's nonce and proof submitted under grant B in the SAME store, and draws nothing from either", async () => {
    const a = await setup();
    // A second authorized grant in the same store, naming the same agent key.
    const bCreated = await a.credentagent.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] }, agentKey: a.agentKey.publicJwk });
    expect((await signOnPhone(a.app, bCreated.id)).body).toMatchObject({ ok: true });
    const q = await quote(a, { sku: "coffee" });
    const proof = await signQuote(a, q.body.quote);
    const r = await submit(a, q.body.quote.nonce, proof, bCreated.id);
    expect(r.body).toMatchObject({ ok: false });
    expect((await (await a.credentagent.grants.retrieve(bCreated.id))!.usage()).remaining).toBe(100);
    expect(await remaining(a)).toBe(100);
    expect(a.orders.size).toBe(0);
  });

  it("refuses grant A's nonce when the proof is signed with grant B's own permission and submitted under B", async () => {
    const a = await setup();
    const bCreated = await a.credentagent.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { categories: ["Beverages"] }, agentKey: a.agentKey.publicJwk });
    expect((await signOnPhone(a.app, bCreated.id)).body).toMatchObject({ ok: true });
    const q = await quote(a, { sku: "coffee" }); // quoted under A
    const proof = await signQuote(a, q.body.quote, a.agentKey, bCreated.id); // B's permission over A's cart: B's permission check passes
    expect((await submit(a, q.body.quote.nonce, proof, bCreated.id)).body).toMatchObject({ ok: false, code: "nonce-used" });
    expect((await (await a.credentagent.grants.retrieve(bCreated.id))!.usage()).remaining).toBe(100);
    expect(a.orders.size).toBe(0);
  });

  it("refuses an expired nonce", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
      expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "nonce-expired" });
    } finally {
      Date.now = realNow;
    }
    expect(c.orders.size).toBe(0);
  });

  it("BYPASS: used quotes count toward a per-grant cap, so garbage proofs cannot flood the shared table", async () => {
    const c = await setup();
    let refused: unknown;
    for (let i = 0; i < MAX_RETAINED_QUOTES_PER_GRANT + 1 && !refused; i++) {
      const q = await quote(c, { sku: "coffee" });
      if (!q.body.ok) { refused = q.body; break; }
      await submit(c, q.body.quote.nonce, { checkout: "x", payment: "y" }); // uses the nonce, never buys
    }
    expect(refused).toMatchObject({ ok: false, code: "too-many-quotes" });
  });

  it("caps open quotes per grant (too-many-quotes)", async () => {
    const c = await setup();
    for (let i = 0; i < 5; i++) expect((await quote(c, { sku: "coffee" })).body.ok).toBe(true);
    expect((await quote(c, { sku: "coffee" })).body).toMatchObject({ ok: false, code: "too-many-quotes" });
  });
});

describe("a proof rests on THIS grant's permission and on the cart this nonce quoted", () => {
  it("refuses a proof built on ANOTHER grant's permission under this grant's nonce, and draws nothing from either", async () => {
    const a = await setup({ budget: 20, perSpend: 20 });
    // A second, far larger grant in the same store, naming the same agent key (the store names ONE key).
    const bCreated = await a.credentagent.grants.create({ merchant: "utopia", budget: 1000, perSpend: 1000, allow: { categories: ["Beverages"] }, agentKey: a.agentKey.publicJwk });
    expect((await signOnPhone(a.app, bCreated.id)).body).toMatchObject({ ok: true });
    const q = await quote(a, { sku: "coffee" });
    const proof = await signQuote(a, q.body.quote, a.agentKey, bCreated.id); // A's cart, signed with B's permission
    const r = await submit(a, q.body.quote.nonce, proof);
    expect(r.body).toMatchObject({ ok: false, code: "not-authorized" });
    expect(await remaining(a)).toBe(20);
    expect((await (await a.credentagent.grants.retrieve(bCreated.id))!.usage()).remaining).toBe(1000);
    expect(a.orders.size).toBe(0);
  });

  it("refuses a proof whose cart is not the one this nonce quoted", async () => {
    const c = await setup();
    const q1 = (await quote(c, { sku: "coffee" })).body.quote;
    const q2 = (await quote(c, { sku: "tea" })).body.quote;
    const proof = await signQuote(c, { nonce: q1.nonce, checkoutJwt: q2.checkoutJwt, audience: q1.audience }); // tea's cart under coffee's nonce
    expect((await submit(c, q1.nonce, proof)).body).toMatchObject({ ok: false, code: "checkout-unbound" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });
});

describe("the quote only offers what the signed mandate can hold", () => {
  it("refuses qty above 1 at quote time: the signed mandate holds one of each item per purchase", async () => {
    const c = await setup();
    const r = await quote(c, { sku: "coffee", qty: 2 });
    expect(r.body).toMatchObject({ ok: false, code: "invalid-request" });
    expect(r.body.detail).toMatch(/one/i);
    expect(r.body.quote).toBeUndefined();
  });

  it("answers a failure while signing the cart with a typed refusal, never a 500, and issues no nonce", async () => {
    const c = await setup();
    const spy = vi.spyOn(c.credentagent.ap2, "signCheckout").mockImplementation(() => { throw new Error("line items do not add up"); });
    try {
      const r = await quote(c, { sku: "coffee" });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, code: "invalid-request" });
    } finally {
      spy.mockRestore();
    }
    // The failed quote left no open quote behind: the cap is still fully available.
    for (let i = 0; i < 5; i++) expect((await quote(c, { sku: "coffee" })).body.ok).toBe(true);
  });
});

describe("the catalog is the price authority and the grant's bounds hold", () => {
  it("re-prices from the catalog at proof time: a price that moved since the quote is refused", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" }); // quoted at 18
    const proof = await signQuote(c, q.body.quote);
    c.catalog.coffee = { ...c.catalog.coffee, price: 20 }; // the catalog is the authority, not the signed cart
    expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "price" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });

  it("refuses a sku outside the grant's allow at quote time", async () => {
    const c = await setup({ allow: { categories: ["Beverages"] } });
    expect((await quote(c, { sku: "lamp" })).body).toMatchObject({ ok: false, code: "not-allowed" });
  });

  it("refuses a purchase over the per-purchase cap", async () => {
    const c = await setup({ perSpend: 15 });
    const { quote: q, proof } = await buy(c, "coffee"); // 18 > 15
    expect(q.ok === false || proof?.ok === false).toBe(true);
    // The refusal says WHICH limit, in a field the agent can switch on (not only in prose).
    expect((q.ok === false ? q : proof)?.violations?.map((v: { constraint?: string }) => v.constraint)).toEqual(["payment.amount_range"]);
    expect(c.orders.size).toBe(0);
  });

  it("refuses a purchase over the remaining budget", async () => {
    const c = await setup({ budget: 30, perSpend: 30 });
    expect((await buy(c, "coffee")).proof?.ok).toBe(true); // 18, 12 left
    const second = await buy(c, "coffee"); // 18 > 12
    expect(second.quote.ok === false || second.proof?.ok === false).toBe(true);
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(12);
  });

  it("refuses an age-restricted sku without a covering age proof (step-up)", async () => {
    const c = await setup({ allow: { categories: ["Beverages"] } });
    expect((await quote(c, { sku: "whiskey" })).body).toMatchObject({ ok: false, code: "step-up" });
  });

  it("accepts an age-restricted sku when the human proved their age before signing", async () => {
    const c = await setup({ allow: { categories: ["Beverages"] }, age: 21, perSpend: 50 });
    expect((await buy(c, "whiskey")).proof).toMatchObject({ ok: true, receipt: { amount: 40 } });
  });
});

describe("only an authorized grant sells", () => {
  it("answers a revoked grant with `revoked` at quote time, not `not-authorized`", async () => {
    const c = await setup();
    await (await c.credentagent.grants.retrieve(c.grantId))!.revoke();
    expect((await quote(c, { sku: "coffee" })).body).toMatchObject({ ok: false, code: "revoked" });
  });

  it("refuses a pending grant at quote time", async () => {
    const c = await setup({ sign: false });
    expect((await quote(c, { sku: "coffee" })).body).toMatchObject({ ok: false, code: "not-authorized" });
  });

  it("refuses when the grant is revoked between quote and proof, and records nothing", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    await (await c.credentagent.grants.retrieve(c.grantId))!.revoke();
    expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "revoked" });
    expect(c.orders.size).toBe(0);
  });

  it("answers unknown-grant for an id the store never minted", async () => {
    const c = await setup();
    expect((await quote(c, { sku: "coffee" }, "grant_nope")).body).toMatchObject({ ok: false, code: "unknown-grant" });
  });
});

describe("concurrency and malformed input", () => {
  it("lets exactly one of two concurrent proofs through when the budget fits one", async () => {
    const c = await setup({ budget: 20, perSpend: 20 });
    // In memory every await is a microtask, so two requests never interleave and the lock is never
    // tested. Make the completion's own read really wait on the event loop: without the per-grant lock
    // BOTH proofs read the ledger (18 fits 20) before either commits.
    const read = c.credentagent.store.read.bind(c.credentagent.store);
    c.credentagent.store.read = async (id: string) => { await new Promise((r) => setTimeout(r, 20)); return read(id); };
    const q1 = (await quote(c, { sku: "coffee" })).body.quote;
    const q2 = (await quote(c, { sku: "coffee" })).body.quote;
    const [p1, p2] = await Promise.all([signQuote(c, q1), signQuote(c, q2)]);
    const [r1, r2] = await Promise.all([submit(c, q1.nonce, p1), submit(c, q2.nonce, p2)]);
    expect([r1.body.ok, r2.body.ok].filter(Boolean)).toHaveLength(1);
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(2);
  });

  it.each([
    ["an unknown sku", { sku: "nope" }],
    ["qty 0", { sku: "coffee", qty: 0 }],
    ["a negative qty", { sku: "coffee", qty: -1 }],
    ["a fractional qty", { sku: "coffee", qty: 1.5 }],
    ["no sku", {}],
  ])("rejects %s with invalid-request and issues no nonce", async (_label, body) => {
    const c = await setup();
    const r = await quote(c, body);
    expect(r.body).toMatchObject({ ok: false, code: "invalid-request" });
    expect(r.body.quote).toBeUndefined();
  });
});

describe("the agent's private key never reaches the store", () => {
  it("appears in no response body", async () => {
    const c = await setup();
    const bodies: unknown[] = [];
    const q = await quote(c, { sku: "coffee" });
    bodies.push(q.body);
    bodies.push((await request(c.app).get(`${base(c)}/delegation`).set("Host", HOST)).body);
    bodies.push((await submit(c, q.body.quote.nonce, await signQuote(c, q.body.quote))).body);
    const hasPrivate = (v: unknown): boolean =>
      !!v && typeof v === "object" && ("d" in (v as object) || Object.values(v as object).some(hasPrivate));
    expect(bodies.some(hasPrivate)).toBe(false);
  });
});

describe("opt-in: nothing is served unless the host asked for agents", () => {
  it("without `agents`, the delegation, quote and proof routes do not exist", async () => {
    const c = await setup({ optIn: false });
    expect((await request(c.app).get(`${base(c)}/delegation`).set("Host", HOST)).status).toBe(404);
    expect((await quote(c, { sku: "coffee" })).status).toBe(404);
    expect((await submit(c, "any", {})).status).toBe(404);
  });

  it("a store keeping its own ledger (the README pattern) cannot be spent past the grant by these routes", async () => {
    const c = await setup({ optIn: false, budget: 30, perSpend: 30 });
    // The routes a README-style store would have to hand-build are absent, so the budget the person
    // signed is the one ledger the store keeps: 36 can never be accepted against 30.
    expect((await quote(c, { sku: "coffee" })).status).toBe(404);
    expect(await remaining(c)).toBe(30);
  });
});

describe("completion re-derives what a quote could not know", () => {
  it("refuses (step-up) when an age restriction appeared on the item AFTER it was quoted, and draws nothing", async () => {
    const c = await setup();
    const q = await quote(c, { sku: "coffee" }); // not age-restricted when quoted
    const proof = await signQuote(c, q.body.quote);
    c.catalog.coffee = { ...c.catalog.coffee, minAge: 21 }; // price unchanged, so only the age gate can stop it
    expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "step-up" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });

  it("refuses (step-up) while a custom gate() credential applies, as the draw path does", async () => {
    const prescription = defineCredential({
      id: "prescription",
      request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
      verify: (cl) => cl.rx_valid === true,
      effect: gate(),
      ui: { label: "Prescription", action: "Verify prescription" },
    });
    const c = await setup({ credentials: [prescription] });
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "step-up" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });

  it("gives the budget back when the order cannot be recorded: no draw without an order", async () => {
    const store = new MemoryOrderStore<CompletedOrder>();
    const c = await setup({ completedOrderStore: store });
    store.write = () => { throw new Error("disk full"); };
    const { proof } = await buy(c, "coffee");
    expect(proof).toMatchObject({ ok: false, code: "not-recorded" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });
});

describe("a loyalty member pays the discounted price on every step (invariant 3)", () => {
  it("quotes, verifies, records and draws the SAME discounted amount", async () => {
    const c = await setup({ membership: true, loyaltyDiscountPct: 10 });
    const { quote: q, proof } = await buy(c, "coffee"); // 18 less 10% = 16.20
    expect(q.quote.amount).toBe(16.2);
    expect(proof).toMatchObject({ ok: true, receipt: { amount: 16.2, remaining: 83.8 } });
    expect(await c.credentagent.orders.retrieve(proof.receipt.orderId)).toMatchObject({ ok: true, completion: { amount: 16.2 } });
    expect(await remaining(c)).toBe(83.8);
  });

  it("records the discount, so the lines' list prices explain the amount charged", async () => {
    const c = await setup({ membership: true, loyaltyDiscountPct: 10 });
    const { proof } = await buy(c, "coffee");
    expect(await c.credentagent.orders.retrieve(proof.receipt.orderId)).toMatchObject({ completion: { amount: 16.2, discount: 1.8, lines: [{ unitPrice: 18 }] } });
  });
});

describe("edges that must answer with a typed refusal, not a crash", () => {
  it("a sub-cent catalog price is refused at quote time, never a 500", async () => {
    const c = await setup();
    c.catalog.coffee = { ...c.catalog.coffee, price: 18.005 };
    const r = await quote(c, { sku: "coffee" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "invalid-request" });
  });

  it("an item with minAge 0 (no limit) is sold without an age proof", async () => {
    const c = await setup();
    c.catalog.coffee = { ...c.catalog.coffee, minAge: 0 };
    expect((await buy(c, "coffee")).proof).toMatchObject({ ok: true });
  });

  it("reports the remaining budget in whole cents (100 less 8.04 is 91.96, not 91.96000000000001)", async () => {
    const c = await setup();
    c.catalog.coffee = { ...c.catalog.coffee, price: 8.04 };
    const { proof } = await buy(c, "coffee");
    expect(proof.receipt.remaining).toBe(91.96);
    expect(await remaining(c)).toBe(91.96);
  });
});

describe("completion sees what a person's checkout sees", () => {
  const scoped = (appliesTo: (o: { lines: { category?: string; requiresRx?: boolean }[] }) => boolean) =>
    defineCredential({
      id: "prescription",
      request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
      verify: (cl) => cl.rx_valid === true,
      effect: gate(),
      appliesTo: appliesTo as never,
      ui: { label: "Prescription", action: "Verify prescription" },
    });

  it("a gate scoped by category applies to an agent's purchase of that category (step-up)", async () => {
    const c = await setup({ credentials: [scoped((o) => o.lines.some((l) => l.category === "Beverages"))] });
    const q = await quote(c, { sku: "coffee" });
    expect((await submit(c, q.body.quote.nonce, await signQuote(c, q.body.quote))).body).toMatchObject({ ok: false, code: "step-up" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });

  it("a gate scoped by a custom catalog attribute applies too, and leaves other items alone", async () => {
    const c = await setup({ credentials: [scoped((o) => o.lines.some((l) => l.requiresRx === true))] });
    c.catalog.tea = { ...c.catalog.tea, requiresRx: true };
    const rx = await quote(c, { sku: "tea" });
    expect((await submit(c, rx.body.quote.nonce, await signQuote(c, rx.body.quote))).body).toMatchObject({ ok: false, code: "step-up" });
    expect((await buy(c, "coffee")).proof).toMatchObject({ ok: true }); // no requiresRx: the gate does not apply
  });
});

describe("the age proof sealed in the grant must cover the limit the catalog sets NOW", () => {
  it("an 18+ proof does not open an item raised to 21+ after the quote", async () => {
    const c = await setup({ age: 18 });
    const q = await quote(c, { sku: "coffee" });
    const proof = await signQuote(c, q.body.quote);
    c.catalog.coffee = { ...c.catalog.coffee, minAge: 21 };
    expect((await submit(c, q.body.quote.nonce, proof)).body).toMatchObject({ ok: false, code: "step-up" });
    expect(c.orders.size).toBe(0);
    expect(await remaining(c)).toBe(100);
  });

  it("a covering proof still works when the shared store's write lands a moment later", async () => {
    const c = await setup({ age: 21, perSpend: 50 });
    const write = c.credentagent.store.write.bind(c.credentagent.store);
    c.credentagent.store.write = (async (id: string, rec: never) => { await new Promise((r) => setTimeout(r, 15)); return write(id, rec); }) as never;
    expect((await buy(c, "whiskey")).proof).toMatchObject({ ok: true, receipt: { amount: 40 } });
  });
});

describe("what is recorded, and what survives a late failure", () => {
  it("records what was bought and which grant paid, and says the order was delegated", async () => {
    const c = await setup();
    const { proof } = await buy(c, "coffee");
    expect(await c.credentagent.orders.retrieve(proof.receipt.orderId)).toMatchObject({
      ok: true,
      authorization: "delegated",
      completion: { grantId: c.grantId, lines: [{ id: "coffee", quantity: 1, unitPrice: 18 }], permissionId: expect.any(String) },
    });
  });

  it("BYPASS: the public status route never shows the grant that paid, while orders.retrieve still does", async () => {
    const c = await setup();
    c.credentagent.orders.serve(c.app);
    const { proof } = await buy(c, "coffee");
    const status = await request(c.app).get(`/credentagent/orders/${proof.receipt.orderId}/status`).set("Host", HOST);
    expect(status.body.completed).toBe(true);
    expect(status.text).not.toContain(c.grantId);
    expect(status.body.order).not.toHaveProperty("permissionId");
    expect(await c.credentagent.orders.retrieve(proof.receipt.orderId)).toMatchObject({ completion: { grantId: c.grantId } });
  });

  it("keeps the draw and answers with the receipt when only the cleanup after recording fails", async () => {
    const c = await setup({ budget: 30, perSpend: 30 });
    c.credentagent.store.clear = () => { throw new Error("redis down"); };
    const { proof } = await buy(c, "coffee");
    expect(proof).toMatchObject({ ok: true, receipt: { remaining: 12 } });
    expect(c.orders.size).toBe(1);
    expect(await remaining(c)).toBe(12); // the order exists, so the budget stays drawn
    expect((await buy(c, "coffee")).proof?.ok ?? (await buy(c, "coffee")).quote.ok).toBe(false); // 12 left: no second 18
  });
});

describe("opting in wrongly fails fast", () => {
  it.each([[true], ["presence-only-demo"], [{ trust: "real" }], [{}]])("rejects agents: %j at construction", (agents) => {
    expect(() => new CredentAgent({ walletOrigin: ORIGIN, agents: agents as never })).toThrow(/agents/);
  });
});
