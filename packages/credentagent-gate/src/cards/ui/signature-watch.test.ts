// The page's signature watch (spec 015 FR-7): one follow per grant however often the card redraws
// (ChatGPT redraws on every openai:set_globals — the AP2 demo's card restarted its polling each time),
// and the chat is told only when the server says so.
import { describe, it, expect, vi } from "vitest";
import { createSignatureWatch } from "./signature-watch";
import { PERMISSION_STATUS_TOOL } from "../contract";
import type { Bridge, Host } from "./bridge";

function fakeBridge(answers: unknown[], host: Host = "mcp") {
  const queue = [...answers];
  const bridge: Bridge = {
    host,
    call: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    open: async () => {},
    tell: vi.fn(async () => {}),
  };
  return bridge;
}
const options = { sleep: async () => {}, retryMs: 3_000, maxCalls: 3 };
const authorized = (announce: boolean, final: boolean) => ({ status: "authorized", trustLevel: "device-signed", announce, final });

describe("createSignatureWatch", () => {
  it("follows a grant through the card-only tool with only its grant id, until the answer is final", async () => {
    const bridge = fakeBridge([{ status: "pending", announce: false, final: false }, authorized(false, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1")).toEqual({ kind: "signed", trustLevel: "device-signed" }));
    expect(bridge.call).toHaveBeenCalledTimes(2);
    expect(bridge.call).toHaveBeenCalledWith(PERMISSION_STATUS_TOOL, { grantId: "g1" });
  });

  it("follows once per grant, however often the card redraws", async () => {
    const bridge = fakeBridge([{ status: "pending", announce: false, final: false }]);
    const watch = createSignatureWatch(bridge, options);
    for (let i = 0; i < 5; i++) watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(3); // 3 = maxCalls of ONE follow, not 15
  });

  it("tells the chat once when the server says announce, then never follows that grant again", async () => {
    const bridge = fakeBridge([authorized(true, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.tell).toHaveBeenCalledTimes(1));
    expect(bridge.tell).toHaveBeenCalledWith("I signed the permission for BeanBarn on my phone (g1). Please go ahead with the purchase.");
    watch.follow("g1", "BeanBarn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });

  it("a signed answer that is not final keeps asking, and says nothing", async () => {
    const bridge = fakeBridge([authorized(false, false), authorized(false, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalledTimes(2));
    expect(bridge.tell).not.toHaveBeenCalled();
  });

  it("a refusal ends the follow and shows it", async () => {
    const bridge = fakeBridge([{ status: "denied", announce: false, final: true }]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1")).toEqual({ kind: "not-signed", status: "denied" }));
  });

  it("in the preview, with no server behind it, it stops quietly", async () => {
    const bridge = fakeBridge([null], "preview");
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(1);
    expect(watch.state("g1")).toEqual({ kind: "waiting" });
  });

  it("a failed call is retried after retryMs", async () => {
    const sleep = vi.fn(async () => {});
    const bridge = fakeBridge([new Error("offline"), authorized(false, true)]);
    const watch = createSignatureWatch(bridge, { ...options, sleep });
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1").kind).toBe("signed"));
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("tells subscribers when a state changes", async () => {
    const watch = createSignatureWatch(fakeBridge([authorized(false, true)]), options);
    const listener = vi.fn();
    watch.subscribe(listener);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });
});
