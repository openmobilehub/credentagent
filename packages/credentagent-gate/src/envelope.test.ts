// Wire-shape contract for the retained Mode-B primitive (envelope + gated()).
// The `verification_required` shape is a tested contract — agents key on it — so
// these assertions guard against regressions even though v0.1 checkout uses the
// consolidated manifest (see manifest.test.ts) instead.

import { describe, it, expect, vi } from "vitest";
import {
  ageDcql,
  buildVerificationRequired,
  envelopeInstruction,
  isVerificationRequired,
  ENVELOPE_SENTINEL,
  ENVELOPE_VERSION,
} from "./envelope.js";
import { gated } from "./gated.js";
import type { GateOrder } from "./types.js";

const ageOrder: GateOrder = {
  id: "ORD-1",
  total: 124,
  currency: "USD",
  lines: [{ id: "oak-whiskey", quantity: 1, unitPrice: 12400, minimumAge: 21 }],
};
const plainOrder: GateOrder = {
  id: "ORD-2",
  total: 69,
  currency: "USD",
  lines: [{ id: "drift-mouse", quantity: 1, unitPrice: 6900 }],
};

const deps = {
  resolveOrder: (o: GateOrder) => o,
  approveUrl: (o: GateOrder) => `https://shop.example/credential-gate/age?order=${o.id}`,
  minAge: () => 21 as number | undefined,
};

describe("ageDcql", () => {
  it("requests the real mDL age claims (matches the reference verifier)", () => {
    const q = ageDcql();
    const mdl = q.credentials.find((c) => c.meta.doctype_value === "org.iso.18013.5.1.mDL");
    expect(mdl).toBeTruthy();
    const claimIds = mdl!.claims.map((c) => c.path[c.path.length - 1]);
    expect(claimIds).toContain("age_over_21");
    // selective disclosure: never retain
    expect(mdl!.claims.every((c) => c.intent_to_retain === false)).toBe(true);
  });

  it("makes the mDL and EU-PID alternatives (present one OR the other, not both)", () => {
    const q = ageDcql();
    // Without credential_sets, listing two credentials means the wallet must present
    // BOTH (DCQL treats `credentials` as AND) — so a wallet holding only an mDL matches
    // nothing and the picker shows "info not found". The set makes them OR.
    expect(q.credential_sets).toEqual([{ options: [["mdl"], ["eupid"]] }]);
    // Every option references a declared credential id (no dangling reference).
    const ids = new Set(q.credentials.map((c) => c.id));
    for (const option of q.credential_sets![0].options) {
      for (const id of option) expect(ids.has(id)).toBe(true);
    }
  });
});

describe("buildVerificationRequired", () => {
  it("produces the versioned, sentinel-tagged envelope", () => {
    const env = buildVerificationRequired({
      order: ageOrder,
      credential: "age",
      request: ageDcql(),
      approveUrl: "https://shop.example/credential-gate/age?order=ORD-1",
      detail: "needs age",
      minAge: 21,
    });
    expect(env._credentagent).toBe(ENVELOPE_SENTINEL);
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.reason.pass).toBe(false);
    expect(env.present.min_age).toBe(21);
    expect(env.present.approve_url).toContain("ORD-1");
    expect(env.resume.tool).toBe("get-order-status");
    // honest by default: not a safety control yet
    expect(env.trust_level).toBe("presence-only-demo");
    expect(isVerificationRequired(env)).toBe(true);
  });
});

describe("gated (deprecated Mode-B shim)", () => {
  it("REFUSES an age-restricted, unverified order — the handler never runs", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ORDER PLACED" }] }));
    const wrapped = gated(handler, { age: true }, { ...deps, isAgeUnverified: async () => true });
    const res = await wrapped(ageOrder);
    // The bypass is closed: no completion, a drivable envelope instead.
    expect(handler).not.toHaveBeenCalled();
    expect(isVerificationRequired(res.structuredContent)).toBe(true);
    expect(res.content[0].text).toContain("phone");
  });

  it("allows the handler once age is verified", async () => {
    const handler = vi.fn(async (_a: GateOrder, ctx: { order: GateOrder }) => ({
      content: [{ type: "text" as const, text: `link for ${ctx.order.id}` }],
    }));
    const wrapped = gated(handler, { age: true }, { ...deps, isAgeUnverified: async () => false });
    const res = await wrapped(ageOrder);
    expect(handler).toHaveBeenCalledOnce();
    expect(isVerificationRequired(res.structuredContent)).toBe(false);
    expect(res.content[0].text).toContain("ORD-1");
  });

  it("does not gate when the policy doesn't require age", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    // even if the store says unverified, no age policy => no gate
    const wrapped = gated(handler, {}, { ...deps, isAgeUnverified: async () => true });
    await wrapped(plainOrder);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resolves the order exactly once (stable id between gate check and handler)", async () => {
    const resolveOrder = vi.fn((o: GateOrder) => o);
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const wrapped = gated(handler, { age: true }, { ...deps, resolveOrder, isAgeUnverified: async () => false });
    await wrapped(ageOrder);
    expect(resolveOrder).toHaveBeenCalledOnce();
  });
});

describe("envelopeInstruction", () => {
  it("tells the agent not to claim placement and to poll", () => {
    const env = buildVerificationRequired({
      order: ageOrder, credential: "age", request: ageDcql(),
      approveUrl: "https://x/age?order=ORD-1", detail: "d", minAge: 21,
    });
    const text = envelopeInstruction(env);
    expect(text).toContain("get-order-status");
    expect(text.toLowerCase()).toContain("do not tell");
  });
});
