// Direct unit tests of the shared per-key serializer. Its two callers' suites (completion.test.ts,
// grants.test.ts) pin that it serializes TWO same-key callers; neither reaches the idle-key
// eviction, because both callers chain before the first cleanup runs. These pin it here.
import { describe, it, expect } from "vitest";
import { KeyedMutex } from "./keyed-mutex.js";

/** Let every queued microtask and the cleanup `.then` run before the next step. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KeyedMutex — idle-key eviction", () => {
  // BYPASS (#140): A finishes while B is still running; C arrives in that gap. The cleanup may
  // drop the key only if nothing newer is queued behind it (`tails.get(key) === tail`). Make that
  // delete unconditional and A's cleanup removes B's entry, so C finds no tail and runs ALONGSIDE
  // B — a double `settle` in completion, a false `revoked` in grants. This goes red.
  it("BYPASS: a caller arriving after A finishes still waits for an in-flight B", async () => {
    const m = new KeyedMutex();
    const seen: string[] = [];
    let releaseB!: () => void;
    const a = m.run("k", async () => {
      seen.push("a");
    });
    const b = m.run("k", async () => {
      seen.push("b-start");
      await new Promise<void>((r) => (releaseB = r));
      seen.push("b-end");
    });
    await a;
    await tick(); // A's cleanup has run; B is parked mid-flight
    const c = m.run("k", async () => {
      seen.push("c");
    });
    await tick(); // a broken eviction lets C run here, before B ends
    releaseB();
    await Promise.all([b, c]);
    expect(seen).toEqual(["a", "b-start", "b-end", "c"]);
  });

  // The memory claim in PR 169: the inline copy this replaced kept one entry per key for the life
  // of the process. Drop the cleanup and this goes red (one entry left per key used).
  it("drops a key once nothing is queued behind it, including after a rejected run", async () => {
    const m = new KeyedMutex();
    const tails = (m as unknown as { tails: Map<string, unknown> }).tails;
    await Promise.all([m.run("a", async () => 1), m.run("a", async () => 2), m.run("b", async () => 3)]);
    await expect(m.run("c", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await tick();
    expect(tails.size).toBe(0);
  });
});
