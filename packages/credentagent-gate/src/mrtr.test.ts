// MRTR (Multi Round-Trip Requests) — the pattern's contract AND its bypass surface.
//
// `requestState` travels through the client, so every test here that starts with REFUSES /
// IGNORES is a bypass test: delete the corresponding check in mrtr.ts and it goes red.

import { describe, it, expect } from "vitest";
import { MultiRoundTrip } from "./mrtr.js";

const SECRET = "test-secret-key";
const rounds = new MultiRoundTrip({ secret: SECRET });
const PARAMS = { budget: 200, perSpend: 120, item: "sneakers" };

/** Round 1: nothing known yet → ask for a size. Returns the sealed state to present next. */
function askSize(overrides: Partial<Parameters<MultiRoundTrip["open"]>[0]> = {}) {
  const r = rounds.open({ request: "create-spending-grant", params: PARAMS, ...overrides });
  if (!r.ok) throw new Error(`unexpected refusal: ${r.code}`);
  return r.ask({ size: { message: "Which size?", fields: { size: { type: "string" } } } });
}

/** The client's reply to a `size` question. */
const sizeReply = (size: string) => ({ size: { action: "accept", content: { size } } });

describe("MultiRoundTrip — the shape the spec asks for", () => {
  it("asks with a spec-shaped input_required result (elicitation/create + requestedSchema)", () => {
    const out = askSize();
    expect(out.resultType).toBe("input_required");
    expect(out.inputRequests.size.method).toBe("elicitation/create");
    expect(out.inputRequests.size.params).toMatchObject({
      mode: "form",
      message: "Which size?",
      requestedSchema: { type: "object", properties: { size: { type: "string" } }, required: ["size"] },
    });
    expect(typeof out.requestState).toBe("string");
  });

  it("carries the answers forward across rounds without any server-side session", () => {
    const first = askSize();

    // Round 2: the size comes back; the server asks for a colour, keeping the size.
    const second = rounds.open({ request: "create-spending-grant", params: PARAMS, state: first.requestState, responses: sizeReply("US 40") });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.answers).toEqual({ size: "US 40" });
    expect(second.round).toBe(1);
    const asked = second.ask({ colour: { message: "Which colour?", fields: { colour: { type: "string", enum: ["black", "white"] } } } });

    // Round 3: both answers are present — the flow has what it needs.
    const third = rounds.open({
      request: "create-spending-grant",
      params: PARAMS,
      state: asked.requestState,
      responses: { colour: { action: "accept", content: { colour: "black" } } },
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.answers).toEqual({ size: "US 40", colour: "black" });
    expect(third.round).toBe(2);
  });

  it("surfaces a declined question instead of inventing an answer", () => {
    const first = askSize();
    const r = rounds.open({
      request: "create-spending-grant",
      params: PARAMS,
      state: first.requestState,
      responses: { size: { action: "decline" } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declined).toEqual(["size"]);
    expect(r.answers).toEqual({});
  });

  it("opens a first round with no state (nothing gathered, nothing refused)", () => {
    const r = rounds.open({ request: "create-spending-grant", params: PARAMS });
    expect(r).toMatchObject({ ok: true, round: 0, answers: {}, declined: [] });
  });
});

describe("MultiRoundTrip — requestState is attacker-controlled input", () => {
  it("REFUSES a tampered requestState (a hand-edited answer never becomes trusted state)", () => {
    const first = askSize();
    const [, b64, sig] = first.requestState.split(".");
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    payload.answers = { size: "US 40", smuggled: true }; // the attack: pre-load answers nobody gave
    const forged = `mrtr1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;

    const r = rounds.open({ request: "create-spending-grant", params: PARAMS, state: forged });
    expect(r).toEqual({ ok: false, code: "tampered" });
  });

  it("REFUSES a requestState sealed by a different server (wrong secret)", () => {
    const other = new MultiRoundTrip({ secret: "someone-elses-secret" });
    const foreign = other.open({ request: "create-spending-grant", params: PARAMS });
    if (!foreign.ok) throw new Error("setup");
    const state = foreign.ask({ size: { message: "Which size?", fields: { size: { type: "string" } } } }).requestState;

    expect(rounds.open({ request: "create-spending-grant", params: PARAMS, state })).toEqual({ ok: false, code: "tampered" });
  });

  it("REFUSES a requestState replayed on a DIFFERENT request", () => {
    const first = askSize();
    const r = rounds.open({ request: "spend-from-grant", params: PARAMS, state: first.requestState });
    expect(r).toEqual({ ok: false, code: "wrong-request" });
  });

  it("REFUSES a requestState whose salient params changed underneath it (budget raised)", () => {
    const first = askSize();
    const r = rounds.open({ request: "create-spending-grant", params: { ...PARAMS, budget: 5000 }, state: first.requestState });
    expect(r).toEqual({ ok: false, code: "wrong-request" });
  });

  it("accepts the same params in a different key order (canonical digest, not JSON byte order)", () => {
    const first = askSize();
    const reordered = { item: PARAMS.item, perSpend: PARAMS.perSpend, budget: PARAMS.budget };
    const r = rounds.open({ request: "create-spending-grant", params: reordered, state: first.requestState });
    expect(r.ok).toBe(true);
  });

  it("REFUSES a requestState minted for a DIFFERENT principal (no cross-user reuse)", () => {
    const first = askSize({ principal: "session-alice" });
    const r = rounds.open({ request: "create-spending-grant", params: PARAMS, principal: "session-mallory", state: first.requestState });
    expect(r).toEqual({ ok: false, code: "wrong-principal" });
  });

  it("REFUSES a requestState presented after its TTL lapsed", () => {
    const short = new MultiRoundTrip({ secret: SECRET, ttlMs: 1000 });
    const start = 1_700_000_000_000;
    const opened = short.open({ request: "create-spending-grant", params: PARAMS, now: start });
    if (!opened.ok) throw new Error("setup");
    const state = opened.ask({ size: { message: "Which size?", fields: { size: { type: "string" } } } }).requestState;

    expect(short.open({ request: "create-spending-grant", params: PARAMS, state, now: start + 1_001 })).toEqual({ ok: false, code: "expired" });
    expect(short.open({ request: "create-spending-grant", params: PARAMS, state, now: start + 900 }).ok).toBe(true);
  });

  it("IGNORES answers to questions the server never asked", () => {
    // Attack A: no state at all — nothing was ever asked, so nothing is accepted.
    const cold = rounds.open({ request: "create-spending-grant", params: PARAMS, responses: sizeReply("US 40") });
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.answers).toEqual({});

    // Attack B: a real round, but with extra fields and an extra question smuggled in.
    const first = askSize();
    const warm = rounds.open({
      request: "create-spending-grant",
      params: PARAMS,
      state: first.requestState,
      responses: {
        size: { action: "accept", content: { size: "US 40", ageVerified: true } }, // extra field
        pricingOverride: { action: "accept", content: { perSpend: 99999 } }, // never asked
      },
    });
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(warm.answers).toEqual({ size: "US 40" });
  });

  it("REFUSES junk in the requestState slot rather than treating it as a fresh round", () => {
    for (const state of ["not-a-state", "mrtr1.abc", 42, { forged: true }]) {
      expect(rounds.open({ request: "create-spending-grant", params: PARAMS, state })).toEqual({ ok: false, code: "tampered" });
    }
  });
});

describe("MultiRoundTrip — the flat fallback channel (clients without MRTR)", () => {
  it("accepts a flat answer for a field that was asked", () => {
    const first = askSize();
    const r = rounds.open({ request: "create-spending-grant", params: PARAMS, state: first.requestState, answers: { size: "US 40" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers).toEqual({ size: "US 40" });
  });

  it("IGNORES a flat answer for a field the server never asked for", () => {
    const first = askSize();
    const r = rounds.open({
      request: "create-spending-grant",
      params: PARAMS,
      state: first.requestState,
      answers: { size: "US 40", perSpend: 99999, ageVerified: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers).toEqual({ size: "US 40" });
  });
});
