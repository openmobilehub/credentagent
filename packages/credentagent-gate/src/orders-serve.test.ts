import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { age, payment, membership, required, optional, defineCredential, dcql, gate } from "./credentials.js";
import type { CompletionInput, CompletionResult } from "./ceremony/types.js";
import { Orders, MemoryOrderStore, type CompletedOrder } from "./orders.js";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";

// A minimal dependency-free Express double: capture the registered route handlers so we can
// invoke the orders page / place / status handlers directly (the rails register too; we don't
// invoke them). The gate is express-free by design, so a structural double is enough.
function fakeApp() {
  const get = new Map<string, Function>();
  const post = new Map<string, Function>();
  return {
    locals: {} as Record<string, unknown>,
    get(path: string, ...h: unknown[]) { get.set(path, h[h.length - 1] as Function); },
    post(path: string, ...h: unknown[]) { post.set(path, h[h.length - 1] as Function); },
    use() {},
    _get: get,
    _post: post,
  };
}
function fakeRes() {
  const res: any = { _status: 200, _body: undefined as string | undefined, _json: undefined as unknown, headers: {} as Record<string, string> };
  res.status = (c: number) => { res._status = c; return res; };
  res.type = () => res;
  res.send = (b: string) => { res._body = b; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}

// Amounts are dollars, matching the checkout page's formatter ($21.00 — not minor units).
const wineOrder = () => ({ id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] });
const stickerOrder = () => ({ id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 5 }] });
const gatedPolicy = () => [required(age.over(21)), required(payment.in("usd"))];

describe("orders.serve — checkout wiring", () => {
  it("serve() registers the checkout page, place, and status routes", () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    expect(app._get.has("/credentagent/orders/:id")).toBe(true);
    expect(app._post.has("/credentagent/orders/:id/place")).toBe(true);
    expect(app._get.has("/credentagent/orders/:id/status")).toBe(true);
  });

  it("renders the checkout page for an order (200), and retrieve stays PENDING until completion", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

    const res = fakeRes();
    await app._get.get("/credentagent/orders/:id")!({ params: { id } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toContain("Wine");

    expect((await ca.orders.retrieve(id)).ok).toBe(false); // still pending — page render is not completion
  });

  // BYPASS (invariant 1) — the instant-demo place path completes WITHOUT a device ceremony,
  // so it must refuse a GATED order (age / payment). Delete the isGated guard in orders-serve
  // and this goes red: an age-restricted order would complete via a direct POST with NO age
  // proof — exactly the "hiding a button is not enforcement" bug.
  it("REFUSES the instant-demo place path for a gated order — it never completes unverified", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(403);

    // The load-bearing assertion: the order is STILL not completed (no age proof was given).
    expect((await ca.orders.retrieve(id)).ok).toBe(false);
  });

  it("an UNGATED order completes via the demo place path → order.settled + retrieve ok", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    const settled: string[] = [];
    ca.on("order.settled", ({ id }) => settled.push(id));
    ca.orders.serve(app);
    // No blocking gate → ungated → the instant-demo path is allowed.
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [] });

    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(200);

    expect(settled).toEqual([id]);            // the in-process order.settled event fired once
    const after = await ca.orders.retrieve(id);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.completion.amount).toBe(5); // amount re-derived server-side (invariant 2)
  });

  // The order.settled listener triggers fulfillment, so a retried / double-clicked place POST
  // must not re-fire it. Delete the completed-store check in the place handler and this goes
  // red: every duplicate POST would re-record the order and fulfill it again.
  it("the demo place path is IDEMPOTENT — a duplicate POST never re-fires order.settled", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    const settled: string[] = [];
    ca.on("order.settled", ({ id }) => settled.push(id));
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [] });

    const place = app._post.get("/credentagent/orders/:id/place")!;
    await place({ params: { id } }, fakeRes());
    const res = fakeRes();
    await place({ params: { id } }, res); // retry / double-click / duplicate delivery
    expect(res._status).toBe(200);        // still acknowledged…
    expect(settled).toEqual([id]);        // …but settled exactly once
  });

  // Regression (found by driving the browser): after a rail proves, the buyer must return to
  // THIS order's checkout page — not the storefront's `/checkout`, which the orders interface
  // doesn't serve (a "Cannot GET /checkout" dead end). serve() threads a returnUrl into the rails.
  it("threads the orders return URL into the ceremony rails (not the storefront's /checkout)", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

    const credentialHandler = app._get.get("/credentagent/credential");
    expect(credentialHandler).toBeTruthy();
    const res = fakeRes();
    await credentialHandler!({ query: { order: id, cred: "age" }, headers: { host: "localhost:4000" }, protocol: "http", params: {} }, res);

    expect(res._body).toContain(`/credentagent/orders/${id}`); // returns to the orders page
    expect(res._body).not.toContain("/checkout?order=");        // NOT the storefront route
  });

  it("status returns { completed } for the poll", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [] });

    let res = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: false });

    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, fakeRes());
    res = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: true });
  });

  // #59 finding 2 (over-enforcement → DEADLOCK). The credential registry is process-wide and
  // accumulates a custom gate declared for ONE purpose; the completion sweep must enforce only the
  // gates THIS order's policy required, not every gate in the registry. A gate with no `appliesTo`
  // ("applies to all") would otherwise block an unrelated order that never surfaced it → permanent
  // fail-closed. orders.serve scopes the sweep to the created order's stored policy; these drive the
  // wrapped completion seam (exposed on app.locals after serve) to pin both halves of that scoping.
  describe("finding 2 — the completion sweep is scoped to THIS order's policy", () => {
    // A gate registered from boot (multi-instance fail-closed path) with NO appliesTo → "applies to all".
    const globalGate = defineCredential({
      id: "global_gate",
      request: dcql({ docType: "org.example.global.1", claims: ["ok"] }),
      verify: (c) => c.ok === true,
      effect: gate(),
      ui: { label: "Global gate", action: "Prove" },
    });
    const seamOf = (app: ReturnType<typeof fakeApp>) =>
      (app.locals.credentagent as { completion: (i: CompletionInput) => Promise<CompletionResult> }).completion;
    const stickerInput = (id: string): CompletionInput => ({
      order: { id, lines: [{ id: "sticker", name: "Sticker", unitPrice: 5, quantity: 1, lineTotal: 5, currency: "USD" }], subtotal: 5, discount: 0, total: 5, currency: "USD" },
      mandateId: "m", amount: 5, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }],
    });

    it("does NOT block an order whose policy never required the registered gate (no deadlock)", async () => {
      const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", credentials: [globalGate] });
      const app = fakeApp();
      ca.orders.serve(app);
      const { id } = await ca.orders.create({ order: stickerOrder(), policy: [] }); // policy has no custom gate
      await app._get.get("/credentagent/orders/:id")!({ params: { id } }, fakeRes()); // warm the order for re-pricing

      const res = await seamOf(app)(stickerInput(id));
      expect(res.completed).toBe(true); // scoped to THIS order's (empty) policy → global_gate is not enforced
    });

    it("control: it STILL blocks an order whose policy DID require that gate (scoping didn't disable it)", async () => {
      const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", credentials: [globalGate] });
      const app = fakeApp();
      ca.orders.serve(app);
      const { id } = await ca.orders.create({ order: stickerOrder(), policy: [required(globalGate)] }); // gate IS in policy
      await app._get.get("/credentagent/orders/:id")!({ params: { id } }, fakeRes());

      const res = await seamOf(app)(stickerInput(id));
      expect(res).toMatchObject({ completed: false, reason: "gate" }); // unproven + in-policy → refused
    });
  });

  it("an optional membership discount does not, by itself, gate the demo path", async () => {
    // A discount is not a blocking gate; an order whose only policy entry is an optional
    // membership discount stays ungated (payment/age would gate it — this one has neither).
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [optional(membership.discount(10))] });
    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(200);
    expect((await ca.orders.retrieve(id)).ok).toBe(true);
  });
});

// The order proof receipt: orders.serve keeps each proof on the completed order — so the
// EXISTING status route and orders.retrieve() return it — but never the wallet's raw answer:
// not on the stored order, the status route, or the order.settled webhook (#320).
describe("orders.serve — the order proof receipt", () => {
  it("a payment's proof reaches orders.retrieve() and the existing /credentagent/orders/:id/status", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [required(payment.in("usd"))] });

    const pay = fakeRes();
    await app._post.get("/credentagent/dc-payment/verify")!({
      query: {}, headers: { host: "localhost:4000" }, protocol: "http",
      body: { order: id, amount: 5, claims: { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" } },
    }, pay);
    expect(pay._json.completed).toBe(true);

    const done = await ca.orders.retrieve(id);
    expect(done.ok && done.completion.proofs?.map((p) => [p.gate, p.rail])).toEqual([["Pay (USD)", "instant-demo"]]);

    const status = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, status);
    expect(status._json).toMatchObject({ completed: true, order: { orderId: id, proofs: [{ gate: "Pay (USD)" }] } });
  });

  it("REFUSES to serve the wallet's raw answer from the public status route (#320) — the receipt stays, the bytes don't", async () => {
    // The attack: inspectPresentations is on, the buyer proves their age with a real wallet
    // answer, the order completes, and then ANYONE who knows the order id reads the status
    // route (CORS *, no session). Before #320 that answer — personal data from a real ID —
    // rode on the completed order and came straight back.
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", inspectPresentations: true });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });
    const req = (extra: Record<string, unknown>) => ({ headers: { host: "localhost:4000" }, protocol: "http", get: () => "localhost:4000", ...extra });

    const rd = fakeRes();
    await app._get.get("/credentagent/credential/request")!(req({ query: { order: id, cred: "age" } }), rd);
    const signed = rd._json.requests.find((r: { protocol: string }) => r.protocol === "openid4vp-v1-signed");
    const jwk = (jose.decodeJwt(signed.data.request) as { client_metadata: { jwks: { keys: jose.JWK[] } } }).client_metadata.jwks.keys[0];
    const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
    const isi = enc.encode({ digestID: 0, random: Buffer.alloc(16), elementIdentifier: "age_over_21", elementValue: true });
    const dr = Buffer.from(enc.encode({ version: "1.0", documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: { "org.iso.18013.5.1": [new Tag(isi, 24)] } } }], status: 0 })).toString("base64url");
    const response = await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: { mdl: [dr] } })))
      .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" }).encrypt(await jose.importJWK(jwk, "ECDH-ES"));
    const verify = fakeRes();
    await app._post.get("/credentagent/credential/verify")!(req({ query: {}, body: { order: id, cred: "age", readerContextToken: rd._json.readerContextToken, result: { protocol: "openid4vp-v1-signed", data: { response } } } }), verify);
    expect(verify._json.verified).toBe(true);
    expect(verify._json.presentation?.deviceResponse).toBe(dr); // the presenting browser still gets it

    const pay = fakeRes();
    await app._post.get("/credentagent/dc-payment/verify")!(req({ query: {}, body: { order: id, amount: 21, claims: { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" } } }), pay);
    expect(pay._json.completed).toBe(true);
    expect(JSON.stringify(pay._json)).not.toContain(dr); // whoever pays holds only the order id

    const status = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, status);
    expect(status._json.order.proofs.map((p: { gate: string }) => p.gate)).toEqual(["Age 21+", "Pay (USD)"]);
    for (const p of status._json.order.proofs) expect(p).not.toHaveProperty("presentation");
    expect(JSON.stringify(status._json)).not.toContain(dr);
    const done = await ca.orders.retrieve(id);
    expect(JSON.stringify(done)).not.toContain(dr);
  });

  it("REFUSES to serve a raw answer an order stored before #320 still holds — every read strips it", async () => {
    // A persistent completed-order store can hold orders completed before the write side was
    // fixed. The status route, the paid page and orders.retrieve() all read it by id alone.
    const completed = new MemoryOrderStore<CompletedOrder>();
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", inspectPresentations: true, completedOrderStore: completed });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: stickerOrder(), policy: [required(payment.in("usd"))] });
    const presentation = { format: "mso_mdoc", deviceResponse: "LEGACY-RAW", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#LEGACY-RAW" };
    const legacy = { gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "t", presentation };
    await completed.write(id, { orderId: id, amount: 5, currency: "USD", method: "dc-payment", completedAt: "t", proofs: [legacy as never] });

    const status = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, status);
    expect(status._json.order.proofs.map((p: { gate: string }) => p.gate)).toEqual(["Age 21+"]);
    expect(JSON.stringify(status._json)).not.toContain("LEGACY-RAW");
    const page = fakeRes();
    await app._get.get("/credentagent/orders/:id")!({ params: { id } }, page);
    expect(page._body).toContain("Age 21+");
    expect(page._body).not.toContain("LEGACY-RAW");
    expect(JSON.stringify(await ca.orders.retrieve(id))).not.toContain("LEGACY-RAW");
  });

  it("the order.settled webhook and the stored order both carry the proofs WITHOUT credential bytes", async () => {
    const delivered: { proofs?: { presentation?: unknown }[] }[] = [];
    const completed = new MemoryOrderStore<CompletedOrder>();
    const orders = new Orders({
      walletOrigin: "http://localhost:4000", requirements: () => [], created: new MemoryOrderStore(), completed,
      emit: () => {}, deliverWebhook: (_type, object) => { delivered.push(object as never); },
    });
    // An untyped caller hands _complete the bytes anyway.
    const presentation = { format: "mso_mdoc" as const, deviceResponse: "RAW", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#RAW" };
    await orders._complete({ orderId: "O1", proofs: [{ gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "t", presentation } as never] });

    expect(delivered[0].proofs).toEqual([{ gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "t" }]);
    expect(JSON.stringify(delivered[0])).not.toContain("RAW");
    expect((await completed.read("O1"))?.proofs).toEqual(delivered[0].proofs); // #320: nothing public reads the bytes back
    expect(JSON.stringify(await completed.read("O1"))).not.toContain("RAW");
  });
});

// Invariant 3 — the line sum, the order total and the signed amount must agree. 3 × $4.90 is
// 14.700000000000001 in float dollars; before #360 the re-priced order carried that unrounded
// total, Gate 1 re-derived a rounded payable of 14.7, and the strict comparison refused a
// correct payment ("Amount binding: FAIL"). Gate 1 now compares in whole cents (checkAmounts),
// and orders.serve re-prices in whole cents too.
describe("orders.serve — amounts that are not exact in binary (#360)", () => {
  const teaOrder = (unitPrice: number) => ({ id: "", total: unitPrice * 3, currency: "USD", lines: [{ id: "tea", name: "Tea", quantity: 3, unitPrice }] });
  const claims = { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" };

  async function setup(unitPrice: number, policy = [required(payment.in("usd"))]) {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({ order: teaOrder(unitPrice), policy });
    const pay = async (amount: number) => {
      const res = fakeRes();
      await app._post.get("/credentagent/dc-payment/verify")!({
        query: {}, headers: { host: "localhost:4000" }, protocol: "http",
        body: { order: id, amount, claims },
      }, res);
      return res._json as { completed: boolean; mandate?: { cart: { total: number } }; gates?: Array<{ gate: string; pass: boolean; detail: string }> };
    };
    const place = async () => {
      const res = fakeRes();
      await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
      return res;
    };
    return { ca, id, pay, place };
  }

  it("a 3 × $4.90 order completes when paid 14.70 through the instant demo", async () => {
    const { ca, id, pay } = await setup(4.9);
    const out = await pay(14.7);
    expect(out.completed).toBe(true);
    const done = await ca.orders.retrieve(id);
    expect(done.ok && done.completion.amount).toBe(14.7);
  });

  it("control: a 3 × $5.00 order still completes when paid 15", async () => {
    const { pay } = await setup(5);
    expect((await pay(15)).completed).toBe(true);
  });

  it.each([14.69, 14.71])("REFUSES a payment of %s for the 14.70 order — amount binding stays enforced", async (amount) => {
    const { ca, id, pay } = await setup(4.9);
    const out = await pay(amount);
    expect(out.completed).toBe(false);
    const binding = out.gates?.find((g) => g.gate === "Amount binding");
    expect(binding?.pass).toBe(false);
    // The order the wallet is asked to sign carries the whole-cent total, not the float sum.
    expect(out.mandate?.cart.total).toBe(14.7);
    expect((await ca.orders.retrieve(id)).ok).toBe(false);
  });

  it("a loyalty-discounted 3 × $4.90 order completes for exactly 13.23 (14.70 − 10%) and refuses the undiscounted 14.70", async () => {
    const { ca, id, pay } = await setup(4.9, [optional(membership.discount(10)), required(payment.in("usd"))]);
    await ca.store.write(id, { loyalty: { applied: true, membershipNumber: "M-1" } });
    expect((await pay(14.7)).completed).toBe(false);
    expect((await pay(13.23)).completed).toBe(true);
  });

  // Invariant 3 — the page prices a `discount(15)` member at 15% off; the payment rails must
  // check the same 15%, not their default 10% (which refused every such member).
  it("a 15% member discount completes at the discounted price — and the undiscounted price is refused", async () => {
    const { ca, id, pay } = await setup(10, [optional(membership.discount(15)), required(payment.in("usd"))]);
    await ca.store.write(id, { loyalty: { applied: true, membershipNumber: "M-1" } });
    expect((await pay(30)).completed).toBe(false);
    expect((await pay(25.5)).completed).toBe(true); // 3 × $10 − 15%
  });

  // A real fraction of a cent is refused, never rounded (ap2/money.ts) — 3 × $0.002 is not $0.01.
  it("REFUSES a sub-cent order rather than rounding it to whole cents", async () => {
    const { ca, id, pay } = await setup(0.002);
    const out = await pay(0.01);
    expect(out.completed).toBe(false);
    expect(out.gates?.find((g) => g.gate === "Amount binding")?.detail).toContain("refused");
    expect((await ca.orders.retrieve(id)).ok).toBe(false);
  });

  // Invariant 3 — the instant-demo place path records the price the page showed, discount included.
  it("the instant-demo place path records a proven member's discounted total, not the full price", async () => {
    const { ca, id, place } = await setup(4.9, [optional(membership.discount(10))]);
    await ca.store.write(id, { loyalty: { applied: true, membershipNumber: "M-1" } });
    await place();
    const done = await ca.orders.retrieve(id);
    expect(done.ok && done.completion.amount).toBe(13.23);
  });

  // Invariant 1 — a 21+ line gates the order even when the policy has no age step: the rails'
  // completion refuses an unproven age-restricted line, so the demo place path must too.
  it("BYPASS: the instant-demo place path REFUSES an order with a minimumAge line and no age step in the policy", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = await ca.orders.create({
      order: { id: "", total: 30, currency: "USD", lines: [{ id: "whiskey", name: "Whiskey", quantity: 1, unitPrice: 30, minimumAge: 21 }] },
      policy: [optional(membership.discount(10))],
    });
    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(403);
    expect((await ca.orders.retrieve(id)).ok).toBe(false); // nothing recorded
  });
});
