// Escape-hatch typing (spec 005, US3): a consumer can import the store contracts and the
// StorageProvider shape to type an explicit store or a custom provider, and RedisStorageOptions
// to build a provider. Checked by `tsc -p tsconfig.test.json` (wired into the package build):
// if any of these exports is removed or renamed, the build fails. Type-only; nothing runs.

import type { CartStore, OrderStore, StorageProvider, StorefrontOptions } from "./server.js";
import type { RedisStorageOptions } from "./redis.js";

// A custom provider is assignable to StorefrontOptions.storage.
declare const provider: StorageProvider;
const withProvider: StorefrontOptions = { storage: provider };
void withProvider;

// The individual store contracts are importable for the per-slot escape hatch.
declare const cart: CartStore;
declare const orders: OrderStore<{ id: string }>;
void cart;
void orders;

// redisStorage's options type is exported for callers constructing a provider explicitly.
const redisOpts: RedisStorageOptions = { url: "u", token: "t", namespace: "n" };
void redisOpts;
