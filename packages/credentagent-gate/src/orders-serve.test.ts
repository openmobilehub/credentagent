import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { age, payment, membership, required, optional } from "./credentials.js";

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

const wineOrder = () => ({ id: "", total: 2100, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 2100, minimumAge: 21 }] });
const stickerOrder = () => ({ id: "", total: 500, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 500 }] });
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
    const { id } = ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

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
    const { id } = ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

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
    const { id } = ca.orders.create({ order: stickerOrder(), policy: [] });

    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(200);

    expect(settled).toEqual([id]);            // the webhook fired once
    const after = await ca.orders.retrieve(id);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.completion.amount).toBe(500); // amount re-derived server-side (invariant 2)
  });

  // Regression (found by driving the browser): after a rail proves, the buyer must return to
  // THIS order's checkout page — not the storefront's `/checkout`, which the orders interface
  // doesn't serve (a "Cannot GET /checkout" dead end). serve() threads a returnUrl into the rails.
  it("threads the orders return URL into the ceremony rails (not the storefront's /checkout)", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = ca.orders.create({ order: wineOrder(), policy: gatedPolicy() });

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
    const { id } = ca.orders.create({ order: stickerOrder(), policy: [] });

    let res = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: false });

    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, fakeRes());
    res = fakeRes();
    await app._get.get("/credentagent/orders/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: true });
  });

  it("an optional membership discount does not, by itself, gate the demo path", async () => {
    // A discount is not a blocking gate; an order whose only policy entry is an optional
    // membership discount stays ungated (payment/age would gate it — this one has neither).
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000" });
    const app = fakeApp();
    ca.orders.serve(app);
    const { id } = ca.orders.create({ order: stickerOrder(), policy: [optional(membership.discount(10))] });
    const res = fakeRes();
    await app._post.get("/credentagent/orders/:id/place")!({ params: { id } }, res);
    expect(res._status).toBe(200);
    expect((await ca.orders.retrieve(id)).ok).toBe(true);
  });
});
