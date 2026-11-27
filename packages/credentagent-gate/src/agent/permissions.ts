// `createPermissions()` — the agent remembers the spending permissions it asked a person to sign, and
// waits for the signature (spec 015, Part 1: FR-1 to FR-3). Plain data in and out: no chat and no card
// are needed, so a text-only agent or a timer uses it the same way a chat does.
//
//   const permissions = createPermissions({ read: ({ store, grantId }) => getJson(`${urls[store.id]}/agent/grants/${grantId}`) });
//   const trackingId = await permissions.track({ store: { id: "beanbarn" }, grantId });
//   const result = await permissions.wait(trackingId);   // holds up to 45 s
//   if (result.ok) { /* approved */ } else if (!result.stop) { /* still waiting: call wait() again */ }
//
// This module reads and remembers; it never decides whether anything may be bought. The store enforces
// every limit on every purchase (security invariant 1).

import { randomBytes } from "node:crypto";
import type { GrantStatus } from "../grants.js";
import { createInMemoryPermissionMemory, type PermissionMemory } from "./permission-memory.js";

/** The shop that issued a permission. `id` is yours (a key into your list of shops); `name` is for display. */
export interface PermissionStore {
  id: string;
  name?: string;
}

/** What `read` answers about a permission. */
export interface PermissionReadAnswer {
  status: GrantStatus;
  /** The store's claim about how strongly it checked the person — never verified here. */
  trustLevel?: string;
  /** What the store hands over once approved. Passed on as given; never kept in memory (it is read each time). */
  approval?: unknown;
}

/** How to read a permission from the store that issued it. A status outside `GrantStatus`, a missing answer or a throw is a failed read — never "not approved". */
export type PermissionRead = (permission: { store: PermissionStore; grantId: string }) => Promise<PermissionReadAnswer>;

export type PermissionStatus = GrantStatus | "unknown" | "read-failed";

/** How one wait ended. `stop` says whether waiting again can help. */
export type PermissionResult =
  | { ok: true; status: "authorized"; trustLevel?: string }
  | { ok: false; status: Exclude<PermissionStatus, "authorized">; trustLevel?: string; stop: boolean };

export interface PermissionsOptions {
  /** How to read a permission from the store that issued it. Required. */
  read: PermissionRead;
  /** Where permissions are remembered. Default: this process only — after a restart, or on another copy, a `trackingId` is `unknown`. */
  memory?: PermissionMemory;
  /** How long one `wait()` holds, in ms. Default 45 000 — under claude.ai's 60 s tool-call limit. */
  approvalHoldMs?: number;
  /** How long a run of waits keeps saying "call again" for a permission that stays pending, in ms. Default 900 000 (15 min). */
  approvalWindowMs?: number;
  /** How long reads may fail with no success before `wait()` says to stop, in ms. Default 120 000 (2 min). */
  readFailureMs?: number;
  /** After a wait ends, how long the caller still counts as waiting — it joins consecutive waits into one run, in ms. Default 20 000. */
  modelGraceMs?: number;
  /** Test seam: a clock whose `sleep` can run instantly. Default: the real one. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

export interface Permissions {
  /** Remember a permission and return its `trackingId`: the same id for the same `(store.id, grantId)`, a new random one otherwise. */
  track(permission: { store: PermissionStore; grantId: string }): Promise<string>;
  /** Wait for the person to sign: re-reads every 1.5 s and holds up to `approvalHoldMs`. */
  wait(trackingId: string): Promise<PermissionResult>;
  /** Drop what is remembered about a permission. */
  forget(trackingId: string): Promise<void>;
}

const POLL_MS = 1_500;
const HOUR = 3_600_000;
const NEVER_APPROVED_TTL = 24 * HOUR;
const FINAL_TTL = 24 * HOUR;
const APPROVED_TTL = 30 * 24 * HOUR;
const GRANT_STATUSES: readonly string[] = ["pending", "authorized", "denied", "revoked"];

/** What is remembered under a `trackingId` (spec 015 FR-1) — one record per permission, never one shared key (invariant 4). */
interface PermissionRecord {
  store: PermissionStore;
  grantId: string;
  trackedAt: number;
  lastUsedAt: number;
  /** A read saw it approved: from then on it expires 30 days after its last use. */
  approved: boolean;
  /** Once the store reports `denied` or `revoked` it stays that way for every later reader. */
  final?: { status: "denied" | "revoked"; trustLevel?: string; at: number };
  /** A wait found it approved: the card must not announce an approval the model already acted on (FR-12). */
  seen: boolean;
  /** The last successful read, shared by every reader for 1.5 s (FR-2). The approval itself is not kept. */
  lastRead?: { at: number; status: GrantStatus; trustLevel?: string };
  /** The current run of waits (FR-3); `openUntil`: a wait is open until then. */
  run?: { startedAt: number; endedAt?: number; openUntil?: number };
  /** When reads started failing, with no success since. */
  failingSince?: number;
}

type ReadOutcome =
  | { kind: "unknown" }
  | { kind: "failed" }
  | { kind: "answer"; status: GrantStatus; trustLevel?: string };

const recordKey = (trackingId: string) => `permission:${trackingId}`;
const indexKey = (storeId: string, grantId: string) => `permission-index:${JSON.stringify([storeId, grantId])}`;

function expiresAt(record: PermissionRecord): number {
  if (record.final) return record.final.at + FINAL_TTL;
  return record.approved ? record.lastUsedAt + APPROVED_TTL : record.trackedAt + NEVER_APPROVED_TTL;
}

export function createPermissions(options: PermissionsOptions): Permissions {
  if (typeof options?.read !== "function") {
    throw new TypeError("createPermissions needs `read`: an async function that asks the store for a permission, `({ store, grantId }) => ({ status, trustLevel? })`.");
  }
  const { read } = options;
  const holdMs = options.approvalHoldMs ?? 45_000;
  const windowMs = options.approvalWindowMs ?? 900_000;
  const readFailureMs = options.readFailureMs ?? 120_000;
  const graceMs = options.modelGraceMs ?? 20_000;
  const now = options.clock?.now ?? Date.now;
  const sleep = options.clock?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const memory = options.memory ?? createInMemoryPermissionMemory(now);
  /** Reads in flight in this copy, so a second reader awaits the first instead of asking the store again. */
  const inFlight = new Map<string, Promise<ReadOutcome>>();

  /** Read, change, compare-and-set — retried on a conflict. `undefined` when the permission is not remembered (any more). */
  async function update(trackingId: string, change: (record: PermissionRecord) => void): Promise<PermissionRecord | undefined> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const got = await memory.get(recordKey(trackingId));
      if (!got) return undefined;
      const record = got.value as PermissionRecord;
      change(record);
      if (await memory.set(recordKey(trackingId), record, { ifVersion: got.version, expiresAt: expiresAt(record) })) return record;
    }
    throw new Error("createPermissions: the memory kept refusing an update (a conflict on every try). Check that its compare-and-set honours `ifVersion`.");
  }

  async function readOnce(trackingId: string, record: PermissionRecord): Promise<ReadOutcome> {
    let answer: PermissionReadAnswer | undefined;
    try {
      answer = await read({ store: record.store, grantId: record.grantId });
    } catch {
      answer = undefined;
    }
    const valid = typeof answer === "object" && answer !== null && GRANT_STATUSES.includes(answer.status);
    const at = now();
    if (!valid) {
      const updated = await update(trackingId, (r) => {
        r.failingSince ??= at;
      });
      return updated ? { kind: "failed" } : { kind: "unknown" };
    }
    const trustLevel = typeof answer!.trustLevel === "string" ? answer!.trustLevel : undefined;
    const status = answer!.status;
    const updated = await update(trackingId, (r) => {
      r.lastRead = { at, status, ...(trustLevel ? { trustLevel } : {}) };
      r.failingSince = undefined;
      r.lastUsedAt = at;
      if (status === "authorized") r.approved = true;
      if ((status === "denied" || status === "revoked") && !r.final) r.final = { status, ...(trustLevel ? { trustLevel } : {}), at };
    });
    return updated ? { kind: "answer", status, trustLevel } : { kind: "unknown" };
  }

  /** The one shared read (FR-2): a final status is answered from memory, a read under 1.5 s old is reused, a read in flight is awaited. */
  async function sharedRead(trackingId: string): Promise<ReadOutcome> {
    const got = await memory.get(recordKey(trackingId));
    if (!got) return { kind: "unknown" };
    const record = got.value as PermissionRecord;
    if (record.final) return { kind: "answer", status: record.final.status, trustLevel: record.final.trustLevel };
    if (record.lastRead && now() - record.lastRead.at < POLL_MS) return { kind: "answer", status: record.lastRead.status, trustLevel: record.lastRead.trustLevel };
    const flying = inFlight.get(trackingId);
    if (flying) return flying;
    const started = readOnce(trackingId, record).finally(() => inFlight.delete(trackingId));
    inFlight.set(trackingId, started);
    return started;
  }

  return {
    async track(permission) {
      const storeId = permission?.store?.id;
      const grantId = permission?.grantId;
      if (typeof storeId !== "string" || storeId === "") throw new TypeError("track needs `store.id`: your id for the shop that issued the permission, e.g. `{ store: { id: \"beanbarn\" }, grantId }`.");
      if (typeof grantId !== "string" || grantId === "") throw new TypeError("track needs `grantId`: the id the shop gave the permission.");
      const key = indexKey(storeId, grantId);
      for (let attempt = 0; attempt < 20; attempt++) {
        const index = await memory.get(key);
        if (index && (await memory.get(recordKey(index.value as string)))) return index.value as string;
        const trackingId = `perm_${randomBytes(16).toString("base64url")}`;
        const at = now();
        const store: PermissionStore = { id: storeId, ...(permission.store.name ? { name: permission.store.name } : {}) };
        const record: PermissionRecord = { store, grantId, trackedAt: at, lastUsedAt: at, approved: false, seen: false };
        await memory.set(recordKey(trackingId), record, { ifVersion: null, expiresAt: expiresAt(record) });
        if (await memory.set(key, trackingId, { ifVersion: index ? index.version : null, expiresAt: at + APPROVED_TTL })) return trackingId;
        await memory.delete(recordKey(trackingId)); // another copy tracked the same pair first: use its id
      }
      throw new Error("createPermissions: the memory kept refusing to track a permission (a conflict on every try). Check that its compare-and-set honours `ifVersion`.");
    },

    async wait(trackingId) {
      const startedAt = now();
      const myOpenUntil = startedAt + holdMs;
      const begun = await update(trackingId, (r) => {
        const run = r.run;
        const continuing = run !== undefined && (run.endedAt === undefined ? (run.openUntil ?? 0) > startedAt : startedAt - run.endedAt <= graceMs);
        if (!continuing) r.failingSince = undefined; // a new run starts clean
        r.run = continuing ? { ...run!, endedAt: undefined, openUntil: Math.max(run!.openUntil ?? 0, myOpenUntil) } : { startedAt, openUntil: myOpenUntil };
        r.lastUsedAt = startedAt;
      });
      if (!begun) return { ok: false, status: "unknown", stop: true };
      const runStartedAt = begun.run!.startedAt;

      let last: ReadOutcome;
      for (;;) {
        last = await sharedRead(trackingId);
        if (last.kind === "unknown" || (last.kind === "answer" && last.status !== "pending")) break;
        if (now() >= myOpenUntil) break;
        await sleep(POLL_MS);
      }

      const ended = await update(trackingId, (r) => {
        if (r.run) {
          r.run.endedAt = now();
          if (r.run.openUntil === myOpenUntil) r.run.openUntil = undefined;
        }
        if (last.kind === "answer" && last.status === "authorized") r.seen = true;
      });
      if (last.kind === "unknown" || !ended) return { ok: false, status: "unknown", stop: true };
      if (last.kind === "failed") {
        const stop = ended.failingSince !== undefined && now() - ended.failingSince >= readFailureMs;
        return { ok: false, status: "read-failed", stop };
      }
      const trustLevel = last.trustLevel ? { trustLevel: last.trustLevel } : {};
      if (last.status === "authorized") return { ok: true, status: "authorized", ...trustLevel };
      if (last.status === "pending") return { ok: false, status: "pending", ...trustLevel, stop: now() - runStartedAt >= windowMs };
      return { ok: false, status: last.status, ...trustLevel, stop: true };
    },

    async forget(trackingId) {
      const got = await memory.get(recordKey(trackingId));
      await memory.delete(recordKey(trackingId));
      if (got) {
        const record = got.value as PermissionRecord;
        await memory.delete(indexKey(record.store.id, record.grantId));
      }
    },
  };
}
