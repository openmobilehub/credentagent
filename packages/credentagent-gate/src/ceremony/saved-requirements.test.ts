// Each order's requirements are saved in its verification record (#444). `requirements()` seals
// them into every approve link; the first page that opens the link saves them. Nothing reads them
// yet: completion and the pages move onto them in #445 and #446.
//
// Tested through the path a site uses: `defineHost` + `mount(app)` + `requirements()`, then the
// approve link opened over HTTP. The bypass tests hand the page a seal it must not save.

import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import { CredentAgent } from "../client.js";
import { defineHost } from "../host.js";
import { age, membership, payment, required, optional } from "../credentials.js";
import { MemoryVerificationStore } from "../store.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder } from "./types.js";
import type { GateOrder, SavedRequirement, Step, VerificationRecord, VerificationStore } from "../types.js";

const KEY = "test-gate-secret-0123456789abcdef";

const PRODUCTS: Record<string, { price: number; minimumAge?: number }> = {
  cheese: { price: 8 },
  scotch: { price: 60, minimumAge: 21 },
  record: { price: 5 }, // not a product: no minimumAge tag
};

const catalog: CeremonyCatalog = {
  createOrder(items: CartItemRef[], orderId: string): CeremonyOrder {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity, ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}) };
    });
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal: total, discount: 0, total, currency: "USD" };
  },
};

const hasScotch = (o: GateOrder) => o.lines.some((l) => l.id === "scotch");
const SCOTCH_POLICY: Step[] = [required(age.over(21).when(hasScotch)), required(payment.in("usd"))];

// One server: a host over a created-order map, and a CredentAgent mounted on it. Two servers that
// share `created`, `store` and `signingKey` are two instances of one deploy.
function server(opts: { store?: VerificationStore; created?: Map<string, CeremonyOrder>; signingKey?: string } = {}) {
  const created = opts.created ?? new Map<string, CeremonyOrder>();
  const completed = new Map<string, unknown>();
  const app = express();
  const host = defineHost({
    catalog,
    orderStore: { read: (id) => created.get(id) ?? null },
    records: { read: (id) => completed.get(id) as never, write: (rec) => void completed.set(rec.orderId, rec) },
    signingKey: opts.signingKey ?? KEY,
    ...(opts.store ? { verificationStore: opts.store } : {}),
  });
  const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });
  host.publish(app);
  credentagent.mount(app);
  const order = (id: string, ...productIds: string[]): CeremonyOrder => {
    const o = catalog.createOrder(productIds.map((productId) => ({ productId, quantity: 1 })), id);
    created.set(id, o);
    return o;
  };
  // Resolve the policy and return the first approve link, as the agent would hand it over.
  const approveLink = (o: CeremonyOrder, policy: Step[]): string => {
    const url = credentagent.requirements(o, policy).find((e) => e.approveUrl)?.approveUrl;
    if (!url) throw new Error("no approve link");
    return url;
  };
  return { app, host, credentagent, order, approveLink, created };
}

const open = (app: express.Express, approveUrl: string) => {
  const u = new URL(approveUrl);
  return request(app).get(u.pathname + u.search);
};

const saved = async (store: VerificationStore, orderId: string): Promise<SavedRequirement[] | undefined> =>
  (await store.read(orderId))?.requirements;

const savedAge = async (store: VerificationStore, orderId: string): Promise<number | undefined> =>
  (await saved(store, orderId))?.find((r) => r.credential === "age")?.minAge;

describe("saved requirements — the first page that opens the approve link saves them (#444 AC1)", () => {
  it.each([
    { name: "cheese only: no age entry", items: ["cheese"], policy: SCOTCH_POLICY, age: undefined },
    { name: "scotch tagged 21: age 21", items: ["scotch"], policy: SCOTCH_POLICY, age: 21 },
    { name: "scotch + cheese: age 21", items: ["scotch", "cheese"], policy: SCOTCH_POLICY, age: 21 },
    { name: "age.over(25) on scotch tagged 21: age 25", items: ["scotch"], policy: [required(age.over(25)), required(payment.in("usd"))], age: 25 },
    { name: "untagged item under required(age.over(21)): age 21", items: ["record"], policy: [required(age.over(21))], age: 21 },
    { name: "age.over(18) on scotch tagged 21: the tag wins, age 21", items: ["scotch"], policy: [required(age.over(18))], age: 21 },
  ])("$name", async ({ items, policy, age: expected }) => {
    const s = server();
    const o = s.order("ORD-1", ...items);
    const res = await open(s.app, s.approveLink(o, policy));
    expect(res.status).toBe(200);
    expect(await saved(s.host.verificationStore, o.id)).toBeDefined();
    expect(await savedAge(s.host.verificationStore, o.id)).toBe(expected);
  });

  it("saves the whole list: each requirement with whether it is required and what it does", async () => {
    const s = server();
    const o = s.order("ORD-1", "scotch");
    await open(s.app, s.approveLink(o, [...SCOTCH_POLICY, optional(membership.discount(10))]));
    expect(await saved(s.host.verificationStore, o.id)).toEqual([
      { credential: "age", required: true, effect: "gate", minAge: 21 },
      { credential: "membership", required: false, effect: "discount", discountPct: 10 },
      { credential: "payment", required: true, effect: "authorize" },
    ]);
  });

  it("leaves requirements() itself unchanged: the manifest still carries the policy's own age", () => {
    const s = server();
    const manifest = s.credentagent.requirements(s.order("ORD-1", "scotch"), [required(age.over(18))]);
    expect(manifest.find((e) => e.credential === "age")?.minAge).toBe(18);
  });

  it("a link without a seal (built by hand) still opens, and saves nothing", async () => {
    const s = server();
    s.order("ORD-1", "scotch");
    const res = await request(s.app).get("/credentagent/credential?order=ORD-1&cred=age");
    expect(res.status).toBe(200);
    expect(await saved(s.host.verificationStore, "ORD-1")).toBeUndefined();
  });
});

describe("saved requirements — 100 orders in parallel (#444 AC2, invariant 4)", () => {
  it("each order saves the requirements for its own items, never another order's", async () => {
    const s = server();
    const ids = Array.from({ length: 100 }, (_, i) => `ORD-${i}`);
    const links = ids.map((id, i) => s.approveLink(s.order(id, i % 2 === 0 ? "scotch" : "cheese"), SCOTCH_POLICY));
    await Promise.all(links.map((link) => open(s.app, link)));
    for (const [i, id] of ids.entries()) {
      expect(await savedAge(s.host.verificationStore, id)).toBe(i % 2 === 0 ? 21 : undefined);
    }
  });
});

describe("saved requirements — a seal opens only for its own order, from its own server (bypass)", () => {
  const sealOf = (approveUrl: string) => new URL(approveUrl).searchParams.get("requirements")!;

  it("REFUSES a seal minted for another order: the order it is pasted onto saves nothing", async () => {
    const s = server();
    const strict = s.order("ORD-STRICT", "record");
    const other = s.order("ORD-OTHER", "record");
    // The seal from a 25+ order, pasted onto an order whose own link would ask 21+.
    const stolen = sealOf(s.approveLink(strict, [required(age.over(25))]));
    s.approveLink(other, [required(age.over(21))]);
    const res = await request(s.app).get(`/credentagent/credential?order=${other.id}&cred=age&requirements=${stolen}`);
    expect(res.status).toBe(200);
    expect(await saved(s.host.verificationStore, other.id)).toBeUndefined();
  });

  it("REFUSES a tampered seal: a lowered age is not saved", async () => {
    const s = server();
    const o = s.order("ORD-1", "record");
    const [payload, sig] = sealOf(s.approveLink(o, [required(age.over(25))])).split(".");
    const list = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as SavedRequirement[];
    const lowered = Buffer.from(JSON.stringify(list.map((r) => ({ ...r, minAge: 18 })))).toString("base64url");
    await request(s.app).get(`/credentagent/credential?order=${o.id}&cred=age&requirements=${lowered}.${sig}`);
    expect(await saved(s.host.verificationStore, o.id)).toBeUndefined();
  });

  it("REFUSES a seal signed with another server's key", async () => {
    const created = new Map<string, CeremonyOrder>();
    const store = new MemoryVerificationStore();
    const a = server({ created, store, signingKey: "key-of-server-a-0123456789abcdef" });
    const b = server({ created, store, signingKey: "key-of-server-b-0123456789abcdef" });
    const link = a.approveLink(a.order("ORD-1", "record"), [required(age.over(21))]);
    expect((await open(b.app, link)).status).toBe(200);
    expect(await saved(store, "ORD-1")).toBeUndefined();
  });

  it("two servers sharing the store and the key: resolved on A, opened on B, readable from both", async () => {
    const created = new Map<string, CeremonyOrder>();
    const store = new MemoryVerificationStore();
    const a = server({ created, store });
    const b = server({ created, store });
    await open(b.app, a.approveLink(a.order("ORD-1", "record"), [required(age.over(21))]));
    expect(await savedAge(a.host.verificationStore, "ORD-1")).toBe(21);
    expect(await savedAge(b.host.verificationStore, "ORD-1")).toBe(21);
  });
});

describe("saved requirements — written once (#444 AC5)", () => {
  it("a proof write never changes the saved requirements", async () => {
    const s = server();
    const o = s.order("ORD-1", "scotch");
    await open(s.app, s.approveLink(o, SCOTCH_POLICY));
    const before = await saved(s.host.verificationStore, o.id);
    const res = await request(s.app).post("/credentagent/credential/verify").send({ order: o.id, cred: "age", claims: { age_over_21: true } });
    expect(res.body.verified).toBe(true);
    expect(await saved(s.host.verificationStore, o.id)).toEqual(before);
  });

  it("a later seal for the same order does not replace the saved requirements", async () => {
    const s = server();
    const o = s.order("ORD-1", "record");
    await open(s.app, s.approveLink(o, [required(age.over(25))]));
    await open(s.app, s.approveLink(o, [required(age.over(18))]));
    expect(await savedAge(s.host.verificationStore, o.id)).toBe(25);
  });
});

describe("saved requirements — an age proof records the age it was made at (#444 AC3)", () => {
  it("the credential rail saves provenOver at the order's age beside ageVerified", async () => {
    const s = server();
    s.order("ORD-1", "scotch");
    const res = await request(s.app).post("/credentagent/credential/verify").send({ order: "ORD-1", cred: "age", claims: { age_over_21: true } });
    expect(res.body.verified).toBe(true);
    const record = await s.host.verificationStore.read("ORD-1");
    expect(record?.ageVerified).toBe(true);
    expect(record?.provenOver).toBe(21);
  });
});

// A shared store with network latency, like Redis: every call waits, so two pages saving for one
// order at the same moment interleave the way two instances would. Read-merge-write loses a part
// here; `writePart` does not.
class SlowStore implements VerificationStore {
  readonly inner = new MemoryVerificationStore();
  private readonly wait = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
  async read(orderId: string): Promise<VerificationRecord | undefined> { await this.wait(); return this.inner.read(orderId); }
  async write(orderId: string, record: VerificationRecord): Promise<void> { await this.wait(); this.inner.write(orderId, record); }
  async writePart(orderId: string, slot: string, part: VerificationRecord): Promise<void> { await this.wait(); this.inner.writePart(orderId, slot, part); }
  async clear(orderId: string): Promise<void> { await this.wait(); this.inner.clear(orderId); }
}

describe("saved requirements — parts saved at the same moment don't overwrite each other (#444 AC4)", () => {
  it("an age proof and a membership proof saved at once both survive", async () => {
    const store = new SlowStore();
    const s = server({ store });
    s.order("ORD-1", "scotch");
    const prove = (body: Record<string, unknown>) => request(s.app).post("/credentagent/credential/verify").send({ order: "ORD-1", ...body });
    const [ageRes, memberRes] = await Promise.all([
      prove({ cred: "age", claims: { age_over_21: true } }),
      prove({ cred: "membership", claims: { membership_number: "M-1" } }),
    ]);
    expect([ageRes.body.verified, memberRes.body.verified]).toEqual([true, true]);
    const record = await store.read("ORD-1");
    expect(record?.ageVerified).toBe(true);
    expect(record?.loyalty).toEqual({ applied: true, membershipNumber: "M-1" });
    expect(record?.proofs?.map((p) => p.gate).sort()).toEqual(["Age 21+", "Membership"]);
  });

  it("the requirements a page saves and an age proof saved at once both survive", async () => {
    const store = new SlowStore();
    const s = server({ store });
    const o = s.order("ORD-1", "scotch");
    const link = s.approveLink(o, SCOTCH_POLICY);
    await Promise.all([
      open(s.app, link),
      request(s.app).post("/credentagent/credential/verify").send({ order: o.id, cred: "age", claims: { age_over_21: true } }),
    ]);
    expect(await savedAge(store, o.id)).toBe(21);
    expect((await store.read(o.id))?.provenOver).toBe(21);
  });
});
