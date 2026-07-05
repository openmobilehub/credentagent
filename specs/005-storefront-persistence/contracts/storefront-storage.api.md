# API Contract: Storefront Persistence (`storage` / `redisStorage`)

**Feature**: 005-storefront-persistence · **Package**: `@openmobilehub/attestomcp-storefront` · **Date**: 2026-07-03

This is the public, developer-facing contract. Types are illustrative of the surface, not the
implementation. Signatures reuse existing exports where noted.

## 1. `StorefrontOptions.storage` (new field on the existing options)

```ts
import type { CartStore, OrderStore } from "@openmobilehub/attestomcp-storefront/server";
import type { VerificationStore } from "@openmobilehub/attestomcp-gate";

interface StorageProvider {
  cartStore: CartStore;
  createdOrderStore: OrderStore<Order>;
  orderStore: OrderStore<CompletedOrderRecord>;
  verificationStore: VerificationStore;
}

interface StorefrontOptions {
  // …all existing fields unchanged…
  /**
   * A persistence provider that supplies all four stores at once (e.g. `redisStorage(...)`).
   * Optional. An explicit per-slot store below takes precedence over the provider's store
   * for that slot. Omit entirely for the in-memory default.
   */
  storage?: StorageProvider;
}
```

**Resolution order per slot (normative):**

```ts
const cartStore          = opts.cartStore          ?? opts.storage?.cartStore          ?? new MemoryCartStore();
const createdOrderStore  = opts.createdOrderStore  ?? opts.storage?.createdOrderStore  ?? new MemoryOrderStore();
const orderStore         = opts.orderStore         ?? opts.storage?.orderStore         ?? new MemoryOrderStore();
const verificationStore  = opts.verificationStore  ?? opts.storage?.verificationStore  ?? new MemoryVerificationStore();
```

- **CT-1**: With neither `storage` nor an explicit store, every slot is the in-memory default (behavior
  identical to today).
- **CT-2**: With `storage` and no explicit store, every slot comes from the provider.
- **CT-3**: With both, the explicit store wins **for that slot only**; other slots still come from the
  provider.

## 2. `redisStorage(options): StorageProvider` (new export, subpath `./redis`)

```ts
import { redisStorage } from "@openmobilehub/attestomcp-storefront/redis";

type RedisLike = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

interface RedisStorageOptions {
  url?: string;            // Upstash REST URL   (with `token`)
  token?: string;          // Upstash REST token (with `url`)
  client?: RedisLike;      // OR inject a pre-built / fake client (mutually exclusive with url+token)
  namespace?: string;      // key prefix; default "attestomcp-storefront"
}

function redisStorage(options: RedisStorageOptions): StorageProvider;
```

- **CT-4**: `redisStorage({ url, token, namespace })` returns a `StorageProvider` whose four stores read/write
  the key schema in `data-model.md`, all prefixed by `namespace`.
- **CT-5**: `redisStorage({ client, namespace })` uses the injected client verbatim (test / custom seam).
- **CT-6**: Supplying neither (`url`+`token`) nor `client` throws a clear configuration error.
- **CT-7**: Supplying `url`+`token` when `@upstash/redis` is not installed throws an actionable error naming
  the missing optional peer dependency. (Not thrown when a `client` is injected.)
- **CT-8**: Two `StorageProvider`s built over the same backend + same namespace observe each other's writes
  (cross-instance round-trip). With different namespaces, they do not.

## 3. Store-behavior contract (per store, backend-agnostic)

Each returned store honors its existing interface exactly:

| Store | Reads | Writes | Missing-key read |
| :-- | :-- | :-- | :-- |
| `cartStore` | `read(): Promise<Map>` | `write(map)` | `new Map()` |
| `createdOrderStore` | `read(id): Promise<Order\|null>` | `write(id, order)` | `null` |
| `orderStore` | `read(id): Promise<CompletedOrderRecord\|null>` | `write(id, rec)`, `clear(id)` | `null` |
| `verificationStore` | `read(id): Promise<VerificationRecord\|undefined>` | `write(id, record)`, `clear(id)` | `undefined` |

- **CT-9 (security, Inv #4)**: order/verification reads are strictly scoped to the requested order id; a
  write under order `X` is never returned for order `Y`.
- **CT-10**: `verificationStore.write` persists the **full** record; a subsequent `read` returns every field
  written (age, loyalty, custom credential keys) — no field loss.
- **CT-11 (fail-closed)**: a backend error on any op rejects the returned promise; it is not swallowed and
  does not fall back to in-memory.

## 4. New/confirmed exports

| Symbol | Entry | Status |
| :-- | :-- | :-- |
| `redisStorage` | `@openmobilehub/attestomcp-storefront/redis` | **new** |
| `RedisStorageOptions`, `RedisLike` (types) | `.../redis` | **new** |
| `StorageProvider` (type) | `.../server` | **new** |
| `CartStore`, `OrderStore` (types) | `.../server` | **newly exported** (were structural-only) |
| `createStorefront`, `StorefrontOptions`, `CompletedOrderRecord` | `.../server` | existing (options gains `storage`) |
| `VerificationStore`, `MemoryVerificationStore` | `@openmobilehub/attestomcp-gate` | existing (reused) |

## 5. Backward compatibility

- Purely additive: no existing signature changes; `storage` is optional; the in-memory default and the
  28-line quickstart are unchanged.
- `@upstash/redis` is an **optional peer dependency** — absent for in-memory consumers, required only when
  `redisStorage({ url, token })` is actually called.
