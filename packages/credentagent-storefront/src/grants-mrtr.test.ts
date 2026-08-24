// "Buy the black court sneakers, US 10" — pinning a spending grant to ONE product over MCP's
// multi round-trip pattern (#174), driven through the real MCP wire.
//
// The flow an agent sees: create-spending-grant with the human's words → (maybe) questions and a
// requestState instead of a link → ask the human → call again → an approveUrl for a grant that can
// buy THAT product and nothing else. Every REFUSES/IGNORES test here is a bypass test.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createStorefront } from "./server.js";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

// The gate's priced catalog (dollars) — mirrors the sample storefront catalog it gates.
const GATE_CATALOG = {
  "court-sneakers": { price: 95, category: "Apparel" },
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages" },
  "drift-mouse": { price: 49, category: "Electronics" },
  "aurora-headphones": { price: 199, category: "Audio" },
};

/**
 * Connect an MCP client. `elicitation` is what a client declares when it can put a question to
 * the human itself — the capability MRTR's `inputRequests` requires (spec, server requirement 7).
 * Tests default `approvalHoldMs: 0` (instant answers); the held-redial suite opts back in.
 */
async function connect(grantsOwner: CredentAgent, capabilities: Record<string, unknown> = { elicitation: {} }, storefrontOpts: Record<string, unknown> = {}) {
  const server = createStorefront({ grants: grantsOwner.grants, merchant: "utopia", approvalHoldMs: 0, ...storefrontOpts }).mcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "mrtr-test", version: "1.0.0" }, { capabilities });
  await Promise.all([server.connect(st), c.connect(ct)]);
  return c;
}

const agent = () => new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, any>;
const create = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "create-spending-grant", arguments: args });

const ARGS = { budget: 200, perSpend: 120, item: "sneakers" };
/** Drive the sneakers flow to the pinned grant → the awaiting-approval round. */
async function pinned(c: Client) {
  const first = sc(await create(c, ARGS));
  return sc(await create(c, { ...ARGS, requestState: first.requestState, answers: { size: "US 10", colour: "Black" } }));
}

describe("create-spending-grant — asking until the product is pinned down", () => {
  it("asks for the choices the words left open, then pins the grant to that exact product", async () => {
    const ca = agent();
    const c = await connect(ca);

    // Round 1: "sneakers" names one product, but not WHICH pair — no link comes back.
    const r1 = await create(c, { budget: 200, perSpend: 120, item: "sneakers" });
    const v1 = sc(r1);
    expect(v1.code).toBe("input-required");
    expect(v1.approveUrl).toBeUndefined();
    expect(v1.questions.map((q: any) => q.key).sort()).toEqual(["colour", "size"]);
    expect(v1.questions.find((q: any) => q.key === "size").fields[0].options).toContain("US 10");

    // Round 2: the human's answers come back with the state, verbatim.
    const v2 = sc(await create(c, {
      budget: 200, perSpend: 120, item: "sneakers",
      requestState: v1.requestState,
      answers: { size: "US 10", colour: "Black" },
    }));
    expect(v2.status).toBe("pending");
    expect(v2.approveUrl).toContain("/credentagent/grants/");
    expect(v2.allow).toMatchObject({ skus: ["court-sneakers"] });
    expect(v2.item).toMatchObject({ productId: "court-sneakers", selections: { size: "US 10", colour: "Black" } });
  });

  it("answers in the MRTR wire shape (resultType / inputRequests / requestState)", async () => {
    const c = await connect(agent());
    const r = await create(c, { budget: 200, perSpend: 120, item: "sneakers" });
    expect(r.resultType).toBe("input_required");
    const requests = r.inputRequests as Record<string, any>;
    expect(requests.size.method).toBe("elicitation/create");
    expect(requests.size.params.mode).toBe("form");
    expect(requests.size.params.requestedSchema).toMatchObject({ type: "object", required: ["size"] });
    expect(typeof r.requestState).toBe("string");
  });

  it("sends NO inputRequests to a client that never declared elicitation (spec requirement 7)", async () => {
    const c = await connect(agent(), {}); // a client that cannot ask the human anything itself
    const r = await create(c, { budget: 200, perSpend: 120, item: "sneakers" });
    expect(r.resultType).toBeUndefined();
    expect(r.inputRequests).toBeUndefined();

    // It still gets the questions — as ordinary tool output, for its agent to relay.
    const v = sc(r);
    expect(v.code).toBe("input-required");
    expect(v.questions.map((q: any) => q.key).sort()).toEqual(["colour", "size"]);
    expect(typeof v.requestState).toBe("string");

    // …and the round trip still completes through the tool-argument fallback.
    const done = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers", requestState: v.requestState, answers: { size: "US 10", colour: "Black" } }));
    expect(done.allow).toMatchObject({ skus: ["court-sneakers"] });
  });

  it("takes the answers through MRTR's request-level params too (inputResponses + requestState)", async () => {
    const c = await connect(agent());
    const first = await create(c, { budget: 200, perSpend: 120, item: "sneakers" });

    // What an MRTR-aware client sends: the answers next to `arguments`, not inside them.
    const retry = await c.request(
      {
        method: "tools/call",
        params: {
          name: "create-spending-grant",
          arguments: { budget: 200, perSpend: 120, item: "sneakers" },
          requestState: first.requestState,
          inputResponses: {
            size: { action: "accept", content: { size: "US 10" } },
            colour: { action: "accept", content: { colour: "Black" } },
          },
        },
      },
      CallToolResultSchema,
    );
    expect(sc(retry as never)).toMatchObject({ status: "pending", allow: { skus: ["court-sneakers"] } });
  });

  it("stops when the human declines a question instead of asking again until the cap", async () => {
    const c = await connect(agent());
    const first = await create(c, { budget: 200, perSpend: 120, item: "sneakers" });

    const retry = await c.request(
      {
        method: "tools/call",
        params: {
          name: "create-spending-grant",
          arguments: { budget: 200, perSpend: 120, item: "sneakers" },
          requestState: first.requestState,
          inputResponses: { size: { action: "decline" }, colour: { action: "accept", content: { colour: "Black" } } },
        },
      },
      CallToolResultSchema,
    );
    const v = sc(retry as never);
    expect(v).toMatchObject({ ok: false, code: "declined", declined: ["size"] });
    expect(v.approveUrl).toBeUndefined();
  });

  it("asks WHICH ONE when the words fit several products, instead of picking for the human", async () => {
    const c = await connect(agent());
    const v = sc(await create(c, { budget: 400, perSpend: 250, item: "wireless" }));
    expect(v.code).toBe("input-required");
    const options = v.questions[0].fields[0].options;
    expect(options).toEqual(expect.arrayContaining(["Aurora Wireless Headphones", "Drift Wireless Mouse"]));

    // Naming one resolves it.
    const v2 = sc(await create(c, { budget: 400, perSpend: 250, item: "wireless", requestState: v.requestState, answers: { item: "Drift Wireless Mouse" } }));
    expect(v2.allow).toMatchObject({ skus: ["drift-mouse"] });
  });

  it("asks again when nothing in the store matches, and gives up honestly instead of looping forever", async () => {
    const c = await connect(agent());
    let state: string | undefined;
    let view = sc(await create(c, { budget: 100, perSpend: 50, item: "a llama saddle" }));
    expect(view.code).toBe("input-required");
    expect(view.questions[0].message).toContain("couldn't find");

    for (let i = 0; i < 4; i++) {
      state = view.requestState;
      view = sc(await create(c, { budget: 100, perSpend: 50, item: "a llama saddle", requestState: state, answers: { item: "still a llama saddle" } }));
    }
    expect(view.code).toBe("unresolved");
    expect(view.approveUrl).toBeUndefined();
  });

  it("pins a product that needs no choices in one round, and flags an age-restricted one", async () => {
    const c = await connect(agent());
    const v = sc(await create(c, { budget: 300, perSpend: 150, item: "Oak Reserve Whiskey Collection" }));
    expect(v.allow).toMatchObject({ skus: ["oak-whiskey"] });
    expect(v.ageRestricted).toBe(21);
    expect(v.ageNote).toContain("step-up");
  });

  it("refuses to create a grant whose caps can never cover the product", async () => {
    const c = await connect(agent());
    const v = sc(await create(c, { budget: 300, perSpend: 40, item: "Oak Reserve Whiskey Collection" }));
    expect(v).toMatchObject({ ok: false, code: "bounds-too-low", productId: "oak-whiskey", price: 124 });
    expect(v.approveUrl).toBeUndefined();
  });

  it("keeps the open, category-only grant working exactly as before (no item, no round trip)", async () => {
    const c = await connect(agent());
    const r = await create(c, { budget: 200, perSpend: 60, categories: ["Electronics"] });
    expect(r.resultType).toBeUndefined();
    expect(sc(r)).toMatchObject({ status: "pending", allow: { categories: ["Electronics"] } });
  });
});

describe("create-spending-grant — the wait round: the flow stays open until the human's tap", () => {
  it("holds the flow open after pinning: the grant is pending and the tool asks for the human's tap", async () => {
    const c = await connect(agent());
    const v = await pinned(c);
    expect(v.code).toBe("awaiting-approval");
    expect(v.status).toBe("pending");
    expect(v.approveUrl).toContain("/credentagent/grants/");
    expect(v.questions.map((q: any) => q.key)).toEqual(["approval"]);
    expect(v.questions[0].message).toContain(v.approveUrl);
    expect(typeof v.requestState).toBe("string");
  });

  it("REFUSES to report the grant authorized on the agent's say-so — status is re-read from the store", async () => {
    const ca = agent();
    const c = await connect(ca);
    const waiting = await pinned(c);

    // The attack: the agent rings the doorbell claiming approval while the human never tapped.
    const still = sc(await create(c, { ...ARGS, requestState: waiting.requestState, answers: { approved: "true" } }));
    expect(still.code).toBe("awaiting-approval");
    expect(still.status).toBe("pending");

    // The human actually approves at the page (the server-side transition) — NOW it reports.
    await ca.grants._authorize(waiting.grantId);
    const done = sc(await create(c, { ...ARGS, requestState: still.requestState, answers: { approved: "true" } }));
    expect(done.status).toBe("authorized");
    expect(done.questions).toBeUndefined();
    expect(done.allow).toMatchObject({ skus: ["court-sneakers"] });
  });

  it("reports a denial honestly and stops asking", async () => {
    const ca = agent();
    const c = await connect(ca);
    const waiting = await pinned(c);
    await ca.grants._deny(waiting.grantId);

    const v = sc(await create(c, { ...ARGS, requestState: waiting.requestState, answers: { approved: "true" } }));
    expect(v.status).toBe("denied");
    expect(v.questions).toBeUndefined();
  });

  it("keeps waiting past the product-question round cap — polling is not 'unresolved'", async () => {
    const c = await connect(agent());
    let v = await pinned(c);
    for (let i = 0; i < 5; i++) {
      v = sc(await create(c, { ...ARGS, requestState: v.requestState, answers: { approved: "true" } }));
      expect(v.code).toBe("awaiting-approval");
      expect(v.status).toBe("pending");
    }
  });
});

describe("create-spending-grant — the held redial (claude.ai kills a call at 60s; hold just under)", () => {
  it("holds a redial to a pending grant and answers the moment the human's tap lands", async () => {
    const ca = agent();
    const c = await connect(ca, { elicitation: {} }, { approvalHoldMs: 2000 });
    const waiting = await pinned(c);
    setTimeout(() => void ca.grants._authorize(waiting.grantId), 300); // the browser tap, mid-hold
    const t0 = Date.now();
    const done = sc(await create(c, { ...ARGS, requestState: waiting.requestState, answers: { approved: "true" } }));
    const elapsed = Date.now() - t0;
    expect(done.status).toBe("authorized");
    expect(elapsed).toBeGreaterThanOrEqual(250); // it really waited for the tap…
    expect(elapsed).toBeLessThan(1800); // …and answered on it, not at the window's end
  });

  it("returns awaiting-approval after the hold expires when the human never taps", async () => {
    const c = await connect(agent(), { elicitation: {} }, { approvalHoldMs: 400 });
    const waiting = await pinned(c);
    const t0 = Date.now();
    const v = sc(await create(c, { ...ARGS, requestState: waiting.requestState, answers: { approved: "true" } }));
    expect(v.code).toBe("awaiting-approval");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(v.note).toContain("IMMEDIATELY"); // the note tells the model to redial, not sleep
  });

  it("never holds the FIRST awaiting-approval — the human needs the link before they can tap", async () => {
    const c = await connect(agent(), { elicitation: {} }, { approvalHoldMs: 5000 });
    const t0 = Date.now();
    const v = await pinned(c);
    expect(v.code).toBe("awaiting-approval");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("create-spending-grant — requestState is attacker-controlled", () => {
  /** Round 1 of the sneakers flow → the sealed state an attacker gets to play with. */
  async function openRound(c: Client) {
    const v = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers" }));
    return v.requestState as string;
  }

  it("REFUSES a hand-edited requestState (smuggled answers never become a grant)", async () => {
    const c = await connect(agent());
    const state = await openRound(c);

    // The attack: pre-load the answers inside the blob so the next call mints a grant outright.
    const [, b64, sig] = state.split(".");
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    payload.answers = { size: "US 10", colour: "Black" };
    const forged = `mrtr1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;

    const v = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers", requestState: forged }));
    expect(v).toMatchObject({ ok: false, code: "tampered" });
    expect(v.approveUrl).toBeUndefined();
  });

  it("REFUSES a requestState re-presented with a bigger budget than it was minted for", async () => {
    const c = await connect(agent());
    const state = await openRound(c);

    const v = sc(await create(c, { budget: 5000, perSpend: 4000, item: "sneakers", requestState: state, answers: { size: "US 10", colour: "Black" } }));
    expect(v).toMatchObject({ ok: false, code: "wrong-request" });
    expect(v.approveUrl).toBeUndefined();
  });

  it("REFUSES an invented requestState instead of treating it as a fresh round", async () => {
    const c = await connect(agent());
    const v = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers", requestState: "mrtr1.bm9wZQ.bm9wZQ" }));
    expect(v).toMatchObject({ ok: false, code: "tampered" });
  });

  it("IGNORES an answer to a question this flow never asked", async () => {
    const c = await connect(agent());
    const state = await openRound(c);

    // "colour" was asked; "item" was not — a smuggled `item` must not redirect the purchase.
    const v = sc(await create(c, {
      budget: 200, perSpend: 120, item: "sneakers",
      requestState: state,
      answers: { size: "US 10", colour: "Black", item: "Oak Reserve Whiskey Collection" },
    }));
    expect(v.allow).toMatchObject({ skus: ["court-sneakers"] });
  });

  it("REFUSES a spend on any product other than the one the human approved", async () => {
    const ca = agent();
    const c = await connect(ca);
    const first = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers" }));
    const g = sc(await create(c, { budget: 200, perSpend: 120, item: "sneakers", requestState: first.requestState, answers: { size: "US 10", colour: "Black" } }));
    await ca.grants._authorize(g.grantId); // the human approves the sneakers, once, then leaves

    // The typed door rides in the result's `spend` (the projection is the display half — spec 011).
    const other = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse" } }));
    expect(other.spend).toMatchObject({ ok: false, code: "not-allowed" });

    const pinned = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "court-sneakers" } }));
    expect(pinned.spend).toMatchObject({ ok: true, amount: 95 });
  });
});
