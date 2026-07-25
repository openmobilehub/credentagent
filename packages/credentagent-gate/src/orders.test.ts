import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { age, payment, required } from "./credentials.js";
import type { CreatedOrder, OrderStore } from "./orders.js";

// Amounts are dollars, matching the checkout page's formatter ($21.00 — not minor units).
const anOrder = () => ({
  id: "",
  total: 21,
  currency: "USD",
  lines: [{ id: "wine", quantity: 1, unitPrice: 21, minimumAge: 21 }],
});
const aPolicy = () => [required(age.over(21)), required(payment.in("usd"))];

describe("credentagent.orders", () => {
  it("create() returns an id, an approveUrl on this origin, and the resolved manifest", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const { id, approveUrl, manifest } = await ca.orders.create({ order: anOrder(), policy: aPolicy() });
    expect(id).toMatch(/^ord_/);
    expect(approveUrl).toBe(`https://shop.example/credentagent/orders/${id}`);
    const creds = manifest.map((m) => m.credential);
    expect(creds).toContain("age");
    expect(creds).toContain("payment");
  });

  // The approveUrl is only usable if the order is READABLE when it's handed out: with an
  // injected async/shared store (Redis, multi-instance), a fire-and-forget write can still be
  // in flight when the human opens the link on another instance — a 404 on a "created" order.
  // Delete the `await` on `created.write` in create() and this goes red.
  it("create() resolves only after the created order is persisted (async store)", async () => {
    const backing = new Map<string, CreatedOrder>();
    const slowStore: OrderStore<CreatedOrder> = {
      read: async (id) => backing.get(id),
      write: async (id, v) => {
        await new Promise((r) => setTimeout(r, 5));
        backing.set(id, v);
      },
      clear: async (id) => {
        backing.delete(id);
      },
    };
    const ca = new CredentAgent({ walletOrigin: "https://shop.example", orderStore: slowStore });
    const { id } = await ca.orders.create({ order: anOrder(), policy: aPolicy() });
    expect(backing.has(id)).toBe(true); // persisted BEFORE the caller can hand out approveUrl
  });

  // The load-bearing control: an order is `ok` ONLY once it has actually completed (the
  // completed-order store holds it). Delete that gate — make retrieve() return ok for a merely
  // *created* order — and this test goes red: an unproven order would read as done.
  it("BYPASS: an order retrieves as PENDING until it completes — never ok before", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const { id } = await ca.orders.create({ order: anOrder(), policy: aPolicy() });

    const before = await ca.orders.retrieve(id);
    expect(before.ok).toBe(false);
    expect(before).toMatchObject({ pending: true, approveUrl: expect.stringContaining(id) });

    // what the ceremony's completeOrder path does when the human finishes:
    await ca.orders._complete({ orderId: id, amount: 21, currency: "USD", method: "passkey", completedAt: "t" });

    const after = await ca.orders.retrieve(id);
    expect(after.ok).toBe(true);
  });

  // Invariant 4 — state is keyed per order; one order's completion never unlocks another.
  it("scopes per order: completing A does not make B ok", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const a = await ca.orders.create({ order: anOrder(), policy: aPolicy() });
    const b = await ca.orders.create({ order: anOrder(), policy: aPolicy() });
    await ca.orders._complete({ orderId: a.id });
    expect((await ca.orders.retrieve(a.id)).ok).toBe(true);
    expect((await ca.orders.retrieve(b.id)).ok).toBe(false); // B untouched
  });

  it("fires order.settled once on completion (in-process event, not a poll loop)", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    const seen: string[] = [];
    ca.on("order.settled", ({ id }) => seen.push(id));
    const { id } = await ca.orders.create({ order: anOrder(), policy: aPolicy() });
    await ca.orders._complete({ orderId: id });
    expect(seen).toEqual([id]);
  });

  it("retrieve of an unknown id is a typed refusal, not a throw", async () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    expect(await ca.orders.retrieve("ord_nope")).toMatchObject({ ok: false, code: "not-found" });
  });
});
