// redisStorage() — first-class persistence for createStorefront().
//
// Builds all four stores (cart, created-order, completed-order, verification) over an
// Upstash-compatible Redis, so a production/serverless deployment gets shared,
// cross-instance state with ONE option instead of hand-written adapters:
//
//   import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";
//   import { redisStorage } from "@openmobilehub/attestomcp-storefront/redis";
//   const store = createStorefront({ storage: redisStorage({ url, token, namespace: "my-shop" }) });
//
// `@upstash/redis` is an OPTIONAL peer dependency: it is loaded LAZILY, only when a real
// Redis op runs on the { url, token } path. Importing this module, calling `redisStorage`,
// and the injected-`client` path all need no dependency (Security-lean in-memory story).
//
// Keys are `${namespace}:${kind}:${orderId}` — order/verification state is scoped per
// order id (never process-global; Security Invariant #4) and `namespace` isolates tenants
// sharing one backend. This layer PERSISTS state only; it is not a trust anchor and never
// affects `trust_level`.

import type { Order } from "./index.js";
import type { CartStore, OrderStore, StorageProvider, CompletedOrderRecord } from "./server.js";
import type { VerificationRecord, VerificationStore } from "@openmobilehub/attestomcp-gate";

/** The minimal slice of the Upstash client the adapters use (also the injectable test seam). */
export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Optional loader seam so the missing-peer-dependency path is testable while the dep is installed. */
export type UpstashLoader = () => Promise<{ new (config: { url: string; token: string }): RedisLike }>;

export interface RedisStorageOptions {
  /** Upstash REST URL (with `token`). */
  url?: string;
  /** Upstash REST token (with `url`). */
  token?: string;
  /** Inject a pre-built / fake client instead of `url`+`token` (tests, custom backends). */
  client?: RedisLike;
  /** Key prefix isolating tenants on a shared backend. Default `"attestomcp-storefront"`. */
  namespace?: string;
  /** @internal Override how `@upstash/redis` is loaded (for tests). */
  _load?: UpstashLoader;
}

const DEFAULT_NAMESPACE = "attestomcp-storefront";

function joinKey(...parts: string[]): string {
  return parts.join(":");
}

class RedisCartStore implements CartStore {
  private readonly key: string;
  constructor(private readonly redis: RedisLike, namespace: string) {
    this.key = joinKey(namespace, "cart");
  }
  async read(): Promise<Map<string, number>> {
    const obj = (await this.redis.get<Record<string, number>>(this.key)) ?? {};
    return new Map(Object.entries(obj));
  }
  async write(cart: Map<string, number>): Promise<void> {
    await this.redis.set(this.key, Object.fromEntries(cart));
  }
}

type OrderKind = "created" | "completed";

class RedisOrderStore<T> implements OrderStore<T> {
  // The `kind` distinguishes the two order slots (created vs completed) so their keys
  // never collide under one namespace (U1).
  constructor(
    private readonly redis: RedisLike,
    private readonly namespace: string,
    private readonly kind: OrderKind,
  ) {}
  private keyFor(orderId: string): string {
    return joinKey(this.namespace, "order", this.kind, orderId);
  }
  async read(orderId: string): Promise<T | null> {
    return (await this.redis.get<T>(this.keyFor(orderId))) ?? null;
  }
  async write(orderId: string, order: T): Promise<void> {
    await this.redis.set(this.keyFor(orderId), order);
  }
  async clear(orderId: string): Promise<void> {
    await this.redis.del(this.keyFor(orderId));
  }
}

class RedisVerificationStore implements VerificationStore {
  // Full-record get/set per order id. The ceremony merges fields at the call site before
  // writing, so no adapter-level merge is needed; isolation is per-order keying.
  constructor(
    private readonly redis: RedisLike,
    private readonly namespace: string,
  ) {}
  private keyFor(orderId: string): string {
    return joinKey(this.namespace, "verification", orderId);
  }
  async read(orderId: string): Promise<VerificationRecord | undefined> {
    return (await this.redis.get<VerificationRecord>(this.keyFor(orderId))) ?? undefined;
  }
  async write(orderId: string, record: VerificationRecord): Promise<void> {
    await this.redis.set(this.keyFor(orderId), record);
  }
  async clear(orderId: string): Promise<void> {
    await this.redis.del(this.keyFor(orderId));
  }
}

// A RedisLike that loads `@upstash/redis` and constructs the real client on FIRST use.
// Deferring the import keeps `redisStorage()` synchronous and means the dependency is
// only required when a Redis op actually runs (never at import / construction time).
function lazyUpstashClient(url: string, token: string, load: UpstashLoader): RedisLike {
  let clientP: Promise<RedisLike> | undefined;
  const client = (): Promise<RedisLike> => {
    if (!clientP) {
      clientP = load()
        .then((Redis) => new Redis({ url, token }))
        .catch((cause) => {
          throw new Error(
            "redisStorage: `@upstash/redis` is required for the { url, token } path but could not be " +
              "loaded. Install it (`npm i @upstash/redis`) or pass a `client`.",
            { cause },
          );
        });
    }
    return clientP;
  };
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (await client()).get<T>(key);
    },
    async set(key: string, value: unknown): Promise<unknown> {
      return (await client()).set(key, value);
    },
    async del(key: string): Promise<unknown> {
      return (await client()).del(key);
    },
  };
}

const defaultLoader: UpstashLoader = async () => (await import("@upstash/redis")).Redis as unknown as {
  new (config: { url: string; token: string }): RedisLike;
};

function resolveClient(options: RedisStorageOptions): RedisLike {
  if (options.client) return options.client;
  const { url, token } = options;
  if (!url || !token) {
    throw new Error("redisStorage: provide a `client`, or both `url` and `token`.");
  }
  return lazyUpstashClient(url, token, options._load ?? defaultLoader);
}

/**
 * Build a {@link StorageProvider} backed by an Upstash-compatible Redis. Pass the result as
 * `createStorefront({ storage })`. Supply either `{ url, token }` or an injected `{ client }`.
 */
export function redisStorage(options: RedisStorageOptions): StorageProvider {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const redis = resolveClient(options);
  return {
    cartStore: new RedisCartStore(redis, namespace),
    createdOrderStore: new RedisOrderStore<Order>(redis, namespace, "created"),
    orderStore: new RedisOrderStore<CompletedOrderRecord>(redis, namespace, "completed"),
    verificationStore: new RedisVerificationStore(redis, namespace),
  };
}
