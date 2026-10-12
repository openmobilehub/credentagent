// The permission watch (spec 015 FR-7): the kit owns both waits on a signature — the model's and the
// card's — so it alone decides when the card may tell the chat "signed": once per grant, and never
// while the model is still waiting in its own turn (two "go ahead"s could make the model buy twice).
// A virtual clock runs the waits instantly: `sleep(ms)` advances time by `ms`.
import { describe, it, expect } from "vitest";
import { createPermissionWatch, type PermissionStatus } from "./permissions.js";
import type { PermissionInput } from "./contract.js";

const permission: PermissionInput = {
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend"],
  limits: { perPurchase: 25, total: 50 },
  trustLevel: "presence-only-demo",
};

function virtualClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

/** A store that answers "pending" until `signedAt`, then "authorized" (plus the signed intent). */
function storeSigningAt(clock: { now: () => number }, signedAt: number) {
  const reads: PermissionInput[] = [];
  const read = async (p: PermissionInput): Promise<PermissionStatus & { intent?: string }> => {
    reads.push(p);
    return clock.now() >= signedAt ? { status: "authorized", trustLevel: "device-signed", intent: "signed-intent" } : { status: "pending" };
  };
  return { read, reads };
}

const watchFor = (clock: ReturnType<typeof virtualClock>, read: (p: PermissionInput) => Promise<PermissionStatus>, holdMs = 45_000) =>
  createPermissionWatch({ read, holdMs, modelGraceMs: 20_000, now: clock.now, sleep: clock.sleep });

describe("waitForSignature — the model waits in its own turn", () => {
  it("answers what the store answered once signed, extra fields included", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 3_000).read);
    watch.issued(permission);
    expect(await watch.waitForSignature("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });
    expect(clock.now()).toBeGreaterThanOrEqual(3_000);
  });

  it("gives up after holdMs with pending, so the model can ask again", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, Infinity).read, 10_000);
    watch.issued(permission);
    expect(await watch.waitForSignature("g1")).toEqual({ status: "pending" });
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
  });

  it("a grant this process never issued is unknown", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    expect(await watch.waitForSignature("nope")).toEqual({ status: "unknown" });
    expect(await watch.cardStatus("nope")).toEqual({ status: "unknown", announce: false, final: true });
  });
});

describe("cardStatus — the card follows the signature, and the server decides what it may say", () => {
  it("announces once the model has stopped waiting — and only once", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: true, final: true });
    expect(clock.now()).toBeGreaterThanOrEqual(20_000); // it waited out the model's grace window first
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("stays quiet while the model is coming back for the signature in its own turn", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 12_000).read, 10_000);
    watch.issued(permission);
    expect((await watch.waitForSignature("g1")).status).toBe("pending"); // the model heard "pending" and will call again
    const card = watch.cardStatus("g1");
    const model = watch.waitForSignature("g1"); // …and it does, while the card is following
    expect((await model).status).toBe("authorized");
    expect(await card).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("says nothing when the model already saw the signature", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    await watch.waitForSignature("g1");
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("re-issuing a permission never lets the card announce twice", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    expect((await watch.waitForSignature("g1")).status).toBe("authorized"); // the model was told
    watch.issued(permission); // the same grant is shown again
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("stays quiet while the model's wait is still open, even past the grace window", async () => {
    const clock = virtualClock();
    // Both waits share the one virtual clock, so each polling round costs 3_000 — the card's 25s hold would
    // run out before a signature at 30_000. Signing at 22_000 (past the 20s grace) is first seen at t=24_000,
    // by the card (it polls first), while the model's 45s wait is still open.
    const watch = watchFor(clock, storeSigningAt(clock, 22_000).read);
    watch.issued(permission);
    const card = watch.cardStatus("g1");
    const model = watch.waitForSignature("g1");
    expect((await model).status).toBe("authorized");
    expect(await card).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("a failed model wait still counts as heard, then the card may speak", async () => {
    const clock = virtualClock();
    let calls = 0;
    const read = async (): Promise<PermissionStatus> => {
      if (calls++ === 0) throw new Error("store unreachable");
      return { status: "authorized", trustLevel: "device-signed" };
    };
    const watch = watchFor(clock, read);
    watch.issued(permission);
    await expect(watch.waitForSignature("g1")).rejects.toThrow("store unreachable");
    // openWaits went back to 0, so the card waits out the grace window from that failed wait — then tells the chat
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: true, final: true });
    expect(clock.now()).toBeGreaterThanOrEqual(20_000);
  });

  it("pending is not final; a refusal is final and says nothing", async () => {
    const clock = virtualClock();
    const pending = watchFor(clock, storeSigningAt(clock, Infinity).read);
    pending.issued(permission);
    expect(await pending.cardStatus("g1")).toEqual({ status: "pending", announce: false, final: false });
    const denied = watchFor(clock, async () => ({ status: "denied" }));
    denied.issued(permission);
    expect(await denied.cardStatus("g1")).toEqual({ status: "denied", announce: false, final: true });
  });

  it("a failed read asks the card to try again", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, async () => { throw new Error("store unreachable"); });
    watch.issued(permission);
    expect(await watch.cardStatus("g1")).toEqual({ status: "pending", announce: false, final: false });
    expect(clock.now()).toBeGreaterThanOrEqual(1_500); // it backed off before answering, so the card does not hammer a failing store
  });

  it("reads the permission the kit issued — the card supplies only a grant id", async () => {
    const clock = virtualClock();
    const store = storeSigningAt(clock, 0);
    const watch = watchFor(clock, store.read);
    watch.issued(permission);
    await watch.cardStatus("g1");
    expect(store.reads[0]).toEqual(permission);
  });

  it("forgets a permission an hour after it was last used", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    clock.advance(3_600_001);
    expect(await watch.waitForSignature("g1")).toEqual({ status: "unknown" });
    watch.issued(permission);
    clock.advance(3_600_001);
    expect(await watch.cardStatus("g1")).toEqual({ status: "unknown", announce: false, final: true }); // the card's lookup forgets it too
  });

  it("a permission in use is not forgotten", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    clock.advance(3_000_000);
    await watch.waitForSignature("g1"); // signed already, so it answers at once — and counts as a use
    clock.advance(1_000_000);
    expect((await watch.waitForSignature("g1")).status).not.toBe("unknown");
  });
});
