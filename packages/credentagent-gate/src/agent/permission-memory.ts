// Where `createPermissions()` remembers permissions (spec 015 FR-1). The interface is async and has
// compare-and-set, so a shared store (Redis and the like) can implement it and two copies of a server
// never both apply a change. The default lives in this process; a shared one is a later step.

/** Where permissions are remembered. Named `memory` because "store" means the shop here. */
export interface PermissionMemory {
  get(key: string): Promise<{ value: unknown; version: string } | undefined>;
  /** `false` when `ifVersion` no longer matches (`null`: only if absent) — the caller re-reads and retries. */
  set(key: string, value: unknown, opts: { ifVersion: string | null; expiresAt?: number }): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** The default memory: one running copy of the server. Values are copied in and out, as a real store would. */
export function createInMemoryPermissionMemory(now: () => number = Date.now): PermissionMemory {
  const entries = new Map<string, { value: unknown; version: number; expiresAt?: number }>();
  let versions = 0;

  function live(key: string) {
    const entry = entries.get(key);
    if (entry?.expiresAt !== undefined && now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      const entry = live(key);
      return entry ? { value: structuredClone(entry.value), version: String(entry.version) } : undefined;
    },
    async set(key, value, opts) {
      const entry = live(key);
      if (opts.ifVersion === null ? entry !== undefined : entry === undefined || String(entry.version) !== opts.ifVersion) return false;
      entries.set(key, { value: structuredClone(value), version: ++versions, expiresAt: opts.expiresAt });
      return true;
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}
