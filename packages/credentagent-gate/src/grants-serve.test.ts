import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { usd } from "./money.js";
import { age, required } from "./credentials.js";

// The same dependency-free Express double orders-serve.test.ts uses.
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
  const res: any = { _status: 200, _body: undefined as string | undefined, _json: undefined as unknown };
  res.status = (c: number) => { res._status = c; return res; };
  res.type = () => res;
  res.send = (b: string) => { res._body = b; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  return res;
}

const client = () => new CredentAgent({ walletOrigin: "http://localhost:4000" });
const terms = () => ({ merchant: "utopia", budget: usd.dollars(40), perSpend: usd.dollars(20) });

describe("grants.serve — the approve page wiring", () => {
  it("serve() registers the approve page, approve, decline, and status routes", () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    expect(app._get.has("/credentagent/grants/:id")).toBe(true);
    expect(app._post.has("/credentagent/grants/:id/approve")).toBe(true);
    expect(app._post.has("/credentagent/grants/:id/decline")).toBe(true);
    expect(app._get.has("/credentagent/grants/:id/status")).toBe(true);
  });

  it("renders the approve page for a pending grant (200, terms visible); unknown id is 404", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const { id } = await ca.grants.create({ ...terms(), policy: [], description: "Coffee while I sleep" });

    const res = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toContain("utopia");
    expect(res._body).toContain("$40.00");            // budget, page-formatted
    expect(res._body).toContain("$20.00");            // per-spend
    expect(res._body).toContain("Coffee while I sleep");

    const missing = fakeRes();
    await app._get.get("/credentagent/grants/:id")!({ params: { id: "gr_nope" } }, missing);
    expect(missing._status).toBe(404);
  });

  it("demo approve authorizes an UNGATED grant — intent sealed, idempotent on a re-POST", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const { id } = await ca.grants.create({ ...terms(), policy: [] });

    const approve = app._post.get("/credentagent/grants/:id/approve")!;
    const res = fakeRes();
    await approve({ params: { id } }, res);
    expect(res._status).toBe(200);

    const g = await ca.grants.retrieve(id);
    expect(g.status).toBe("authorized");
    expect(g.intentMandate?.intentId).toBeTruthy();
    expect(g.trustLevel).toBe("server-issued-demo");  // honesty carried in the sealed artifact
    const firstIntentId = g.intentMandate!.intentId;

    const again = fakeRes();
    await approve({ params: { id } }, again);          // double-click / retry
    expect(again._status).toBe(200);
    expect((await ca.grants.retrieve(id)).intentMandate!.intentId).toBe(firstIntentId); // ONE seal
  });

  // BYPASS (invariant 1 / honesty fencing): a grant whose policy needs a credential ceremony
  // must NOT authorize from the button-press path — rails-backed authorize is the
  // wallet-custody increment; until then it is FENCED, fail-closed. Delete the isGated
  // guard in the approve handler and this goes red.
  it("BYPASS: demo approve REFUSES a policy-gated grant (403) — it stays pending", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const { id } = await ca.grants.create({ ...terms(), policy: [required(age.over(21))] });

    const res = fakeRes();
    await app._post.get("/credentagent/grants/:id/approve")!({ params: { id } }, res);
    expect(res._status).toBe(403);
    const g = await ca.grants.retrieve(id);
    expect(g.status).toBe("pending");                  // never authorized
    expect(g.intentMandate).toBeUndefined();           // nothing sealed
  });

  it("decline flips a pending grant to denied; approve afterwards is refused (never resurrect)", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const { id } = await ca.grants.create({ ...terms(), policy: [] });

    const res = fakeRes();
    await app._post.get("/credentagent/grants/:id/decline")!({ params: { id } }, res);
    expect(res._status).toBe(200);
    expect((await ca.grants.retrieve(id)).status).toBe("denied");

    const approve = fakeRes();
    await app._post.get("/credentagent/grants/:id/approve")!({ params: { id } }, approve);
    expect(approve._status).toBe(403);
    expect((await ca.grants.retrieve(id)).status).toBe("denied");
  });

  it("status answers the page poll: completed flips on authorize", async () => {
    const ca = client();
    const app = fakeApp();
    ca.grants.serve(app);
    const { id } = await ca.grants.create({ ...terms(), policy: [] });

    let res = fakeRes();
    await app._get.get("/credentagent/grants/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: false, status: "pending" });

    await app._post.get("/credentagent/grants/:id/approve")!({ params: { id } }, fakeRes());
    res = fakeRes();
    await app._get.get("/credentagent/grants/:id/status")!({ params: { id } }, res);
    expect(res._json).toMatchObject({ completed: true, status: "authorized" });
  });
});
