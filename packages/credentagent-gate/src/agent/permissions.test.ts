// `createPermissions()` (spec 015, Part 1: FR-1 to FR-3). A virtual clock runs the waits instantly:
// `sleep(ms)` advances time by `ms`. Every test here fails when the control it names is removed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createPermissions, type PermissionReadAnswer, type PermissionsOptions } from "./permissions.js";
import { createInMemoryPermissionMemory, type PermissionMemory } from "./permission-memory.js";

afterEach(() => vi.useRealTimers());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const beanbarn = { id: "beanbarn", name: "BeanBarn" };

function virtualClock() {
  let t = 1_700_000_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}
type Clock = ReturnType<typeof virtualClock>;

/** A store whose answer depends on the time; counts the reads it was asked for. */
function store(clock: Clock, answer: (t: number) => PermissionReadAnswer | Error | unknown) {
  const reads: { store: string; grantId: string }[] = [];
  const read = async ({ store: s, grantId }: { store: { id: string }; grantId: string }) => {
    reads.push({ store: s.id, grantId });
    const a = answer(clock.now());
    if (a instanceof Error) throw a;
    return a as PermissionReadAnswer;
  };
  return { read, reads };
}
const signedAt = (clock: Clock, at: number, trustLevel = "device-signed") => store(clock, (t) => (t >= at ? { status: "authorized", trustLevel } : { status: "pending" }));

function permissionsFor(clock: Clock, s: { read: PermissionsOptions["read"] }, extra: Partial<PermissionsOptions> = {}) {
  return createPermissions({ read: s.read, clock, approvalHoldMs: 10_000, approvalWindowMs: 25_000, readFailureMs: 30_000, modelGraceMs: 5_000, ...extra });
}

describe("track — one handle per grant", () => {
  it("gives the same trackingId for the same (store.id, grantId), and two ids for two stores with the same grantId", async () => {
    const clock = virtualClock();
    const s = store(clock, () => ({ status: "pending" }));
    const permissions = permissionsFor(clock, s);
    const a = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(await permissions.track({ store: beanbarn, grantId: "g1" })).toBe(a);
    const b = await permissions.track({ store: { id: "leaflodge" }, grantId: "g1" });
    expect(b).not.toBe(a);
    await permissions.wait(b);
    expect(new Set(s.reads.map((r) => r.store))).toEqual(new Set(["leaflodge"])); // the read got the store that was tracked, not another's
  });

  it("two copies sharing one memory that track the same pair at once get one id", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const s = store(clock, () => ({ status: "pending" }));
    const a = permissionsFor(clock, s, { memory });
    const b = permissionsFor(clock, s, { memory });
    const [x, y] = await Promise.all([a.track({ store: beanbarn, grantId: "g1" }), b.track({ store: beanbarn, grantId: "g1" })]);
    expect(x).toBe(y);
  });

  it("says what to pass when store.id or grantId is missing, and when read is missing", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, store(clock, () => ({ status: "pending" })));
    await expect(permissions.track({ store: { id: "" }, grantId: "g1" })).rejects.toThrow("store.id");
    await expect(permissions.track({ store: beanbarn, grantId: "" })).rejects.toThrow("grantId");
    expect(() => createPermissions({} as PermissionsOptions)).toThrow("`read`");
  });

  it("after forget() the trackingId is unknown, and tracking again gives a new one", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, 0));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.forget(id);
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "unknown", stop: true });
    expect(await permissions.track({ store: beanbarn, grantId: "g1" })).not.toBe(id);
  });
});

describe("round 2 of the review — found, then fixed", () => {
  it("an approved permission used every month keeps its trackingId: track() after 31 days gives the same id", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, 0));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    clock.advance(29 * DAY);
    await permissions.wait(id); // a use: the permission now lives until day 59
    clock.advance(2 * DAY); // day 31
    expect(await permissions.track({ store: beanbarn, grantId: "g1" })).toBe(id);
  });

  it("a read that never answers is a failed read, so a hold ends on time; and onReadError says why", async () => {
    vi.useFakeTimers();
    const clock = virtualClock();
    const errors: string[] = [];
    const permissions = permissionsFor(clock, { read: () => new Promise<never>(() => {}) }, { onReadError: (error) => errors.push(error.message) });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const result = permissions.wait(id);
    await vi.advanceTimersByTimeAsync(10_001); // 10 s, not a minute: the first read has been given up on
    expect(errors[0]).toContain("did not answer within 10 s");
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ ok: false, status: "read-failed", stop: false });
  });

  it("onReadError hears a throw and an answer that is not a status, and a throwing hook changes nothing", async () => {
    const clock = virtualClock();
    const errors: string[] = [];
    let n = 0;
    const permissions = permissionsFor(clock, { read: async () => (n++ === 0 ? Promise.reject(new Error("404 from the shop")) : ({ status: "PENDING" } as never)) }, {
      approvalHoldMs: 3_000,
      onReadError: (error) => { errors.push(error.message); throw new Error("a broken logger"); },
    });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "read-failed", stop: false });
    expect(errors[0]).toBe("404 from the shop");
    expect(errors[1]).toContain('"pending" | "authorized" | "denied" | "revoked"');
  });

  it("a reader whose memory lookup began before another read finished does not ask the shop again", async () => {
    const clock = virtualClock();
    const inner = createInMemoryPermissionMemory(clock.now);
    let snapshot: { value: unknown; version: string } | undefined;
    let staleIn = -1; // the lookup that gets the older record
    const memory: PermissionMemory = {
      ...inner,
      get: async (k) => (k.startsWith("permission:") && staleIn-- === 0 ? snapshot : inner.get(k)),
    };
    let reads = 0;
    const permissions = permissionsFor(clock, { read: async () => { reads++; return { status: "pending" }; } }, { memory, approvalHoldMs: 0 });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    snapshot = await inner.get(`permission:${id}`); // the record before any read
    await permissions.wait(id);
    expect(reads).toBe(1);
    clock.advance(100);
    staleIn = 1; // this wait's second lookup (its shared read) still sees the record from before the first read
    await permissions.wait(id);
    expect(reads).toBe(1);
  });

  it("forget() leaves the index alone when it points at a newer trackingId", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const permissions = permissionsFor(clock, signedAt(clock, Infinity), { memory });
    const old = await permissions.track({ store: beanbarn, grantId: "g1" });
    const indexKey = `permission-index:${JSON.stringify(["beanbarn", "g1"])}`;
    const index = (await memory.get(indexKey))!;
    await memory.set(indexKey, "trk_newer", { ifVersion: index.version }); // another copy tracked the pair again
    await permissions.forget(old);
    expect((await memory.get(indexKey))?.value).toBe("trk_newer");
  });

  it("a wait that ends early closes its own 'open until'", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const permissions = permissionsFor(clock, signedAt(clock, 0), { memory });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    const run = ((await memory.get(`permission:${id}`))!.value as { run: { openUntil?: number; endedAt?: number } }).run;
    expect(run.openUntil).toBeUndefined();
    expect(run.endedAt).toBeDefined();
  });

  it("trackingIds start with trk_, as the spec says", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, 0));
    expect(await permissions.track({ store: beanbarn, grantId: "g1" })).toMatch(/^trk_[\w-]{20,}$/);
  });
});

describe("wait — what each outcome says", () => {
  it("authorized: answers ok with the store's trust level, once the person approves", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, clock.now() + 3_000));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const before = clock.now();
    expect(await permissions.wait(id)).toEqual({ ok: true, status: "authorized", trustLevel: "device-signed" });
    expect(clock.now() - before).toBeGreaterThanOrEqual(3_000);
  });

  it("pending: holds the whole hold, then says to call again", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, Infinity));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const before = clock.now();
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "pending", stop: false });
    expect(clock.now() - before).toBeGreaterThanOrEqual(10_000);
  });

  it("denied and revoked: final, stop", async () => {
    const clock = virtualClock();
    for (const status of ["denied", "revoked"] as const) {
      const permissions = permissionsFor(clock, store(clock, () => ({ status, trustLevel: "x" })));
      const id = await permissions.track({ store: beanbarn, grantId: `g-${status}` });
      expect(await permissions.wait(id)).toEqual({ ok: false, status, trustLevel: "x", stop: true });
    }
  });

  it("a trackingId this server does not know is unknown, never 'not approved' — and the store is not asked", async () => {
    const clock = virtualClock();
    const s = signedAt(clock, 0);
    const permissions = permissionsFor(clock, s);
    expect(await permissions.wait("perm_nope")).toEqual({ ok: false, status: "unknown", stop: true });
    expect(s.reads).toHaveLength(0);
  });
});

describe("wait — the limits", () => {
  it("a permission still pending after approvalWindowMs gets 'stop' — and not before", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, Infinity)); // hold 10 s (ends at 10.5 s), window 25 s
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const stops: boolean[] = [];
    for (let i = 0; i < 3; i++) stops.push(((await permissions.wait(id)) as { stop: boolean }).stop);
    expect(stops).toEqual([false, false, true]);
  });

  it("a wait that starts more than modelGraceMs after the last one ended starts a new run, with the full window", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, Infinity));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    await permissions.wait(id);
    clock.advance(5_001); // the person comes back later and says "check again"
    expect(await permissions.wait(id)).toMatchObject({ status: "pending", stop: false });
  });

  it("a wait that starts while another wait is still open continues the run, even when an earlier wait ended long ago", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const permissions = permissionsFor(clock, signedAt(clock, Infinity), { memory });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    // The state two overlapping waits leave: one ended 30 s ago, the other is open for 10 s more; the run began 40 s ago.
    const got = (await memory.get(`permission:${id}`))!;
    const record = got.value as { run?: object };
    record.run = { startedAt: clock.now() - 40_000, endedAt: clock.now() - 30_000, openUntil: clock.now() + 10_000 };
    await memory.set(`permission:${id}`, record, { ifVersion: got.version });
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "pending", stop: true }); // 40 s into a 25 s window: the run went on
  });

  it("reads failing with no success for readFailureMs get 'stop' — and a failed read does not end the hold", async () => {
    const clock = virtualClock();
    const s = store(clock, () => new Error("store unreachable"));
    const permissions = permissionsFor(clock, s);
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const before = clock.now();
    const first = await permissions.wait(id);
    expect(first).toEqual({ ok: false, status: "read-failed", stop: false });
    expect(clock.now() - before).toBeGreaterThanOrEqual(10_000); // it kept reading until the hold ended
    expect(s.reads.length).toBeGreaterThan(5);
    let last = first;
    for (let i = 0; i < 5 && !(last as { stop: boolean }).stop; i++) last = await permissions.wait(id);
    expect(last).toEqual({ ok: false, status: "read-failed", stop: true });
  });

  it("failures from an earlier run do not count against a later one", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, store(clock, () => new Error("down")));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    await permissions.wait(id); // 21 s of failures in this run — under the 30 s limit
    clock.advance(5_001); // the person comes back later: a new run
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "read-failed", stop: false }); // 31.5 s since the first failure, but a new run starts clean
  });

  it("a status outside GrantStatus, or no answer at all, is a failed read — never 'pending' or 'not approved'", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, store(clock, () => ({ status: "PENDING" })));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "read-failed", stop: false });
    const none = permissionsFor(clock, store(clock, () => undefined));
    const id2 = await none.track({ store: beanbarn, grantId: "g2" });
    expect(await none.wait(id2)).toEqual({ ok: false, status: "read-failed", stop: false });
  });

  it("reads that throw at first and then work end in authorized", async () => {
    const clock = virtualClock();
    let calls = 0;
    const permissions = permissionsFor(clock, store(clock, () => (calls++ < 3 ? new Error("flaky") : { status: "authorized" })));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(await permissions.wait(id)).toEqual({ ok: true, status: "authorized" });
  });

  it("the run's limits hold when consecutive waits land on two copies sharing one memory", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const s = signedAt(clock, Infinity);
    const a = permissionsFor(clock, s, { memory });
    const b = permissionsFor(clock, s, { memory });
    const id = await a.track({ store: beanbarn, grantId: "g1" });
    const outcomes = [await a.wait(id), await b.wait(id), await a.wait(id)];
    expect(outcomes.map((o) => (o as { stop: boolean }).stop)).toEqual([false, false, true]);

    const failing = store(clock, () => new Error("down"));
    const c = permissionsFor(clock, failing, { memory });
    const d = permissionsFor(clock, failing, { memory });
    const id2 = await c.track({ store: beanbarn, grantId: "g2" });
    const stops: boolean[] = [];
    for (let i = 0; i < 3; i++) stops.push(((await (i % 2 ? d : c).wait(id2)) as { stop: boolean }).stop);
    expect(stops).toEqual([false, false, true]);
  });
});

describe("a denied permission stays denied, and entries expire", () => {
  it("denied stays denied for every later reader, from memory — then is forgotten 24 h after it became final", async () => {
    const clock = virtualClock();
    const s = store(clock, () => ({ status: "denied" }));
    const permissions = permissionsFor(clock, s);
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    expect(s.reads).toHaveLength(1);
    clock.advance(23 * HOUR);
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "denied", stop: true });
    expect(s.reads).toHaveLength(1); // a final status is answered without reading
    clock.advance(2 * HOUR);
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "unknown", stop: true });
  });

  it("a denied permission is forgotten 24 h after it became final, not 24 h after it was tracked", async () => {
    const clock = virtualClock();
    let denied = false;
    const permissions = permissionsFor(clock, store(clock, () => ({ status: denied ? "denied" : "pending" })), { approvalHoldMs: 0 });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    clock.advance(20 * HOUR);
    denied = true;
    await permissions.wait(id); // becomes final 20 h after it was tracked
    clock.advance(23 * HOUR); // 43 h after tracking, 23 h after final
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "denied", stop: true });
  });

  it("tracking a grant whose entry expired starts a fresh entry", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, Infinity));
    const old = await permissions.track({ store: beanbarn, grantId: "g1" });
    clock.advance(DAY + 1);
    const fresh = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(fresh).not.toBe(old);
    expect(await permissions.wait(fresh)).toMatchObject({ status: "pending" });
  });

  it("a permission never approved is forgotten 24 h after it was tracked", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, Infinity));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    clock.advance(DAY + 1);
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "unknown", stop: true });
  });

  it("an approved permission is forgotten 30 days after its last use, not 24 h after it was tracked", async () => {
    const clock = virtualClock();
    const permissions = permissionsFor(clock, signedAt(clock, 0));
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect((await permissions.wait(id)).ok).toBe(true);
    clock.advance(29 * DAY);
    expect((await permissions.wait(id)).ok).toBe(true); // a use: the 30 days start again
    clock.advance(29 * DAY);
    expect((await permissions.wait(id)).ok).toBe(true);
    clock.advance(30 * DAY + 1);
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "unknown", stop: true });
  });
});

describe("the shared read, and what a wait marks", () => {
  it("two waits at the same moment read the store once", async () => {
    const clock = virtualClock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const permissions = permissionsFor(clock, { read: async () => { reads++; await gate; return { status: "authorized" }; } });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    const both = Promise.all([permissions.wait(id), permissions.wait(id)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    expect((await both).map((r) => r.ok)).toEqual([true, true]);
    expect(reads).toBe(1);
  });

  it("a read under 1.5 s old is reused; an older one is not", async () => {
    const clock = virtualClock();
    const s = signedAt(clock, Infinity);
    const permissions = permissionsFor(clock, s, { approvalHoldMs: 0 });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    await permissions.wait(id);
    clock.advance(1_000);
    await permissions.wait(id);
    expect(s.reads).toHaveLength(1);
    clock.advance(600);
    await permissions.wait(id);
    expect(s.reads).toHaveLength(2);
  });

  it("a wait that finds the permission approved marks the approval seen; a wait that ends pending does not", async () => {
    const clock = virtualClock();
    const memory = createInMemoryPermissionMemory(clock.now);
    const seenOf = async (id: string) => ((await memory.get(`permission:${id}`))!.value as { seen: boolean }).seen;
    const pending = permissionsFor(clock, signedAt(clock, Infinity), { memory });
    const idPending = await pending.track({ store: beanbarn, grantId: "p" });
    await pending.wait(idPending);
    expect(await seenOf(idPending)).toBe(false);
    const signed = permissionsFor(clock, signedAt(clock, 0), { memory });
    const idSigned = await signed.track({ store: beanbarn, grantId: "s" });
    await signed.wait(idSigned);
    expect(await seenOf(idSigned)).toBe(true);
  });

  it("a permission forgotten while a wait is holding ends that wait as unknown", async () => {
    const clock = virtualClock();
    let permissions!: ReturnType<typeof createPermissions>;
    let id = "";
    permissions = permissionsFor(clock, { read: async () => { await permissions.forget(id); return { status: "pending" }; } });
    id = await permissions.track({ store: beanbarn, grantId: "g1" });
    expect(await permissions.wait(id)).toEqual({ ok: false, status: "unknown", stop: true });
  });

  it("a conflict in the memory is retried, not surfaced", async () => {
    const clock = virtualClock();
    const inner = createInMemoryPermissionMemory(clock.now);
    let refuseNext = 0;
    const memory: PermissionMemory = {
      get: (k) => inner.get(k),
      delete: (k) => inner.delete(k),
      set: async (k, v, o) => (o.ifVersion !== null && refuseNext-- > 0 ? false : inner.set(k, v, o)),
    };
    const permissions = permissionsFor(clock, signedAt(clock, 0), { memory });
    const id = await permissions.track({ store: beanbarn, grantId: "g1" });
    refuseNext = 3;
    expect(await permissions.wait(id)).toEqual({ ok: true, status: "authorized", trustLevel: "device-signed" });
  });
});
