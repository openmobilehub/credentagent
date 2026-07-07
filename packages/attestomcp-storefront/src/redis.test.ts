// Tests for redisStorage() — the first-class persistence provider (spec 005).
// Everything runs against a Map-backed fake `RedisLike`, so there is no live Redis:
// building TWO providers over the SAME fake client simulates two serverless instances
// sharing one backend.

import { describe, it, expect } from "vitest";
import { redisStorage, type RedisLike } from "./redis.js";

// A Map-backed RedisLike fake standing in for one shared Upstash instance. `set`
// round-trips through JSON to mirror Upstash's auto-serialization (so a test would catch
// a non-JSON-safe value slipping through, e.g. a raw Map).
function fakeRedis(): RedisLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T = unknown>(key: string): Promise<T | null> {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set(key: string, value: unknown): Promise<unknown> {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return "OK";
    },
    async del(key: string): Promise<unknown> {
      return store.delete(key) ? 1 : 0;
    },
  };
}

const sampleOrder = {
  id: "ORD-1",
  lines: [{ id: "oak-whiskey", name: "Oak", unitPrice: 124, currency: "USD", quantity: 2, lineTotal: 248, minimumAge: 21 }],
  itemCount: 2,
  subtotal: 248,
  discount: 0,
  total: 248,
  currency: "USD",
  createdAt: "2026-07-03T00:00:00.000Z",
};

const sampleCompleted = { orderId: "ORD-1", amount: 248, currency: "USD", method: "instant-demo", completedAt: "2026-07-03T00:00:00.000Z" };

describe("redisStorage — cross-instance round-trip (US1 / FR-004)", () => {
  it("persists all four stores so a separate provider reads exactly what the first wrote", async () => {
    const client = fakeRedis();
    const a = redisStorage({ client, namespace: "shop" });
    const b = redisStorage({ client, namespace: "shop" }); // a distinct "instance"

    // cart (keyed per session)
    await a.cartStore.write("sess-1", new Map([["oak-whiskey", 2]]));
    expect(await b.cartStore.read("sess-1")).toEqual(new Map([["oak-whiskey", 2]]));

    // created order
    await a.createdOrderStore.write("ORD-1", sampleOrder);
    expect(await b.createdOrderStore.read("ORD-1")).toEqual(sampleOrder);

    // completed order
    await a.orderStore.write("ORD-1", sampleCompleted);
    expect(await b.orderStore.read("ORD-1")).toEqual(sampleCompleted);

    // verification — including a CUSTOM credential field (C1), which must round-trip too
    const record = {
      ageVerified: true,
      loyalty: { applied: true, membershipNumber: "M-1" },
      prescription: { filled: true, rxId: "RX-9" },
    };
    await a.verificationStore.write("ORD-1", record);
    expect(await b.verificationStore.read("ORD-1")).toEqual(record);
  });

  it("returns each store's empty shape for a missing key", async () => {
    const s = redisStorage({ client: fakeRedis() });
    expect(await s.cartStore.read("sess-1")).toEqual(new Map());
    expect(await s.createdOrderStore.read("nope")).toBeNull();
    expect(await s.orderStore.read("nope")).toBeNull();
    expect(await s.verificationStore.read("nope")).toBeUndefined();
  });

  it("clear() removes a per-order record", async () => {
    const s = redisStorage({ client: fakeRedis() });
    await s.verificationStore.write("ORD-1", { ageVerified: true });
    await s.verificationStore.clear("ORD-1");
    expect(await s.verificationStore.read("ORD-1")).toBeUndefined();
  });
});

describe("redisStorage — per-order isolation (US1 / FR-005, Security Invariant #4)", () => {
  it("verification proven for one order never marks a different order verified", async () => {
    const s = redisStorage({ client: fakeRedis(), namespace: "shop" });

    await s.verificationStore.write("ORD-X", { ageVerified: true });

    // Sanity: the proven order reads back verified.
    expect(await s.verificationStore.read("ORD-X")).toEqual({ ageVerified: true });
    // Control (load-bearing): a DIFFERENT order must be untouched. This only holds because
    // the verification key embeds the order id. If the key dropped `:${orderId}`, both
    // orders would collide on one key and this read would return { ageVerified: true },
    // failing the assertion — i.e. the test fails when the per-order control is removed.
    expect(await s.verificationStore.read("ORD-Y")).toBeUndefined();
  });
});

describe("redisStorage — configuration + missing-dependency errors (US2 / CT-6, CT-7)", () => {
  it("throws a clear error when neither client nor url+token is provided", () => {
    expect(() => redisStorage({})).toThrow(/client.*url.*token/i);
    expect(() => redisStorage({ url: "https://x.upstash.io" })).toThrow(/client.*url.*token/i); // token missing
  });

  it("surfaces an actionable error naming @upstash/redis when the peer dep cannot load", async () => {
    const s = redisStorage({
      url: "https://x.upstash.io",
      token: "t",
      // Simulate the dep being absent (testable while it is actually installed).
      _load: async () => {
        throw new Error("Cannot find module '@upstash/redis'");
      },
    });
    // Lazy: no throw at construction — only when a real op runs.
    await expect(s.cartStore.read("sess-1")).rejects.toThrow(/@upstash\/redis/);
  });

  it("needs no @upstash/redis on the injected-client path", async () => {
    // A `client` never triggers the loader, so this resolves with no dependency involved.
    const s = redisStorage({ client: fakeRedis() });
    await expect(s.cartStore.read("sess-1")).resolves.toEqual(new Map());
  });
});

describe("redisStorage — cart is keyed per session (issue #34 / Security Invariant #4)", () => {
  it("one session's cart never leaks into another session", async () => {
    const s = redisStorage({ client: fakeRedis(), namespace: "shop" });

    await s.cartStore.write("sess-A", new Map([["oak-whiskey", 2]]));

    // Same session reads it back…
    expect(await s.cartStore.read("sess-A")).toEqual(new Map([["oak-whiskey", 2]]));
    // …a different session is empty. Fails if the cart key drops the `:${sessionId}` segment.
    expect(await s.cartStore.read("sess-B")).toEqual(new Map());
  });
});

describe("redisStorage — namespace isolation (US4 / FR-007, CT-8)", () => {
  it("two namespaces over one backend never cross-read", async () => {
    const client = fakeRedis();
    const a = redisStorage({ client, namespace: "shop-a" });
    const b = redisStorage({ client, namespace: "shop-b" });

    await a.cartStore.write("sess-1", new Map([["oak-whiskey", 1]]));
    await a.createdOrderStore.write("ORD-1", sampleOrder);
    await a.verificationStore.write("ORD-1", { ageVerified: true });

    // b (a different tenant) sees none of a's writes.
    expect(await b.cartStore.read("sess-1")).toEqual(new Map());
    expect(await b.createdOrderStore.read("ORD-1")).toBeNull();
    expect(await b.verificationStore.read("ORD-1")).toBeUndefined();

    // …and a write through b does not clobber a.
    await b.verificationStore.write("ORD-1", { ageVerified: false });
    expect(await a.verificationStore.read("ORD-1")).toEqual({ ageVerified: true });
  });

  it("defaults the namespace to attestomcp-storefront and does not collide with a named one", async () => {
    const client = fakeRedis();
    const def = redisStorage({ client }); // default namespace
    const named = redisStorage({ client, namespace: "other" });

    await def.verificationStore.write("ORD-1", { ageVerified: true });
    expect(await named.verificationStore.read("ORD-1")).toBeUndefined();
    expect([...client.store.keys()]).toContain("attestomcp-storefront:verification:ORD-1");
  });
});

describe("redisStorage — fail-closed on backend error (Polish / FR-012, CT-11)", () => {
  function throwingRedis(): RedisLike {
    const down = (): never => {
      throw new Error("backend down");
    };
    return {
      async get() {
        return down();
      },
      async set() {
        return down();
      },
      async del() {
        return down();
      },
    };
  }

  it("propagates a backend error instead of swallowing it or falling back", async () => {
    const s = redisStorage({ client: throwingRedis() });
    await expect(s.cartStore.read("sess-1")).rejects.toThrow(/backend down/);
    await expect(s.verificationStore.write("ORD-1", { ageVerified: true })).rejects.toThrow(/backend down/);
  });
});
