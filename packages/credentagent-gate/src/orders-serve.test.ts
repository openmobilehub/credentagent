import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { age, payment, membership, required, optional, defineCredential, dcql, gate } from "./credentials.js";
import type { CompletionInput, CompletionResult } from "./ceremony/types.js";

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
