import { describe, it, expect } from "vitest";
import { updateQueue } from "./update-queue.js";

/** A task the test finishes by hand, recording when it started. */
function gate(log: string[], name: string) {
  let finish!: (v: string) => void;
  const done = new Promise<string>((resolve) => (finish = resolve));
  return { task: () => (log.push(`start ${name}`), done), finish: () => finish(name) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("updateQueue — one cart update at a time", () => {
  it("does not start the next update until the previous one answered", async () => {
    const enqueue = updateQueue();
    const log: string[] = [];
    const a = gate(log, "a");
    const b = gate(log, "b");
    const ra = enqueue(a.task);
    const rb = enqueue(b.task);
    await tick();
    expect(log).toEqual(["start a"]); // b waits — it must read the cart a leaves behind
    a.finish();
    await ra;
    await tick();
    expect(log).toEqual(["start a", "start b"]);
    b.finish();
    await rb;
  });

  it("marks only the newest reply as the one to show", async () => {
    const enqueue = updateQueue();
    const log: string[] = [];
    const a = gate(log, "a");
    const b = gate(log, "b");
    const ra = enqueue(a.task);
    const rb = enqueue(b.task);
    a.finish();
    expect(await ra).toEqual({ value: "a", latest: false }); // b was queued after it
    await tick();
    b.finish();
    expect(await rb).toEqual({ value: "b", latest: true });
  });

  it("keeps going after a failed update", async () => {
    const enqueue = updateQueue();
    const failed = enqueue(() => Promise.reject(new Error("network")));
    const next = enqueue(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("network");
    expect(await next).toEqual({ value: "ok", latest: true });
  });
});
