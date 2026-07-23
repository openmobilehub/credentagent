---
name: gate-my-tool
description: Use when asked to gate an existing MCP tool behind a credential — "gate my <tool> tool", add a consent / age / credential check to a registered tool, or make a tool refuse-until-proven. Do NOT use for storefront/checkout gating (that's requirements() + mount()) or for building a new proving ceremony (add-ceremony-rail).
---

# Gate an MCP tool (refuse-until-proven)

Install a CredentAgent consent gate onto an existing tool in **one honest call** — never
hand-roll the `verification_required` envelope, the store check, or the deprecated
`gated()` shim. `credentagent.gate()` absorbs all of it, and the wrap IS the server-side
enforcement point (Security invariant 1 — hiding a button is not enforcement).

## Steps

1. **Locate** the named tool's `registerTool(name, config, handler)` call, and the host's
   `CredentAgent` instance. If the server has none, create ONE (`new CredentAgent()` —
   zero-config for local dev), reuse it server-wide, and **export it**: its store is where
   proofs live, and the bypass test must write proof onto the exact store the gate reads.
2. **Wrap** the handler — change nothing inside it:

   ```js
   server.registerTool("release-records", config, credentagent.gate(handler, {
     require: age.over(21),                       // TODO(dev): the real credential — any defineCredential works
     provenBy: (_args, extra) => extra.sessionId, // whose proof unlocks the call — key by the CALLER
     name: "release-records",                     // must equal the registered tool id exactly
   }));
   ```

   - `require` takes bare `gate()`-effect credentials (one or an array) — no `required()`
     wrapper. Payment / discount steps throw at wrap time by design.
   - `provenBy` must derive a **per-caller** id — the MCP per-request `extra` (with
     `sessionId`) is its second argument. Key by a tool arg ONLY when that subject is the
     prover (self-service), never by the requested resource on a multi-user server. A
     constant means the first person who proves unlocks the tool for EVERYONE
     (invariant 4). Empty throws fail-closed.
3. **Delete any `outputSchema`** on that tool (no-op when only `inputSchema` is declared):
   the refusal envelope replaces the success shape in `structuredContent`, and the SDK
   validates `structuredContent` against a declared schema — the gate would break.
4. **Add the load-bearing bypass test** — in the project's existing test runner (vitest
   here; a stray `node:test` file in a vitest glob fails the suite with "No test suite
   found"). REQUIRED SUB-SKILL: follow `write-bypass-test`.
   Drive the REAL server in-memory — `Client` from
   `@modelcontextprotocol/sdk/client/index.js`, `InMemoryTransport.createLinkedPair()`
   from `@modelcontextprotocol/sdk/inMemory.js`, `isVerificationRequired` from
   `@openmobilehub/credentagent-gate` — using the exported `CredentAgent`. Assert the
   attack precisely (each refusal prints the expected `[credentagent] gate(): …
   mount(app) has not run` warning when no ceremony is mounted — not a failure):
   - unproven call → the action did NOT happen (e.g. `structuredContent.released !== true`)
     AND `isVerificationRequired(result.structuredContent)` with `reason.pass === false`,
     `present.credential` === the credential's **id** (e.g. `"age"`), `present.min_age`,
     and `order.id` === the `provenBy` value;
   - proof written under the envelope's `order.id` → same subject unlocks, a **different**
     subject is still refused (invariant 4);
   - a record with the claim false/absent is refused — presence ≠ proof (invariant 5).
5. **Prove the test is load-bearing**: remove the wrap, run — red; restore — green. Say
   which line you deleted. A bypass test that stays green with the control removed is not
   a useful test.

## Traps (each observed or blocked by design)

| Trap | Reality |
| :-- | :-- |
| Gating in the page/HTML/prose only | The wrap is the enforcement point — server-side, every call |
| `provenBy: () => "shared"` | Cross-user bleed: one proof unlocks everyone |
| `provenBy` keyed by the requested resource | Same bleed per-record: anyone asking for casey's records rides one proof — key by the caller |
| Keeping `outputSchema` | SDK rejects the envelope against your schema |
| Hand-rolling `buildVerificationRequired` / using `gated()` | One call: `credentagent.gate()` |
| A second `CredentAgent` just for the gate | Proofs land in a store the ceremony never writes — share ONE instance |
| Test asserts only "not success" | Assert the typed refusal AND red-when-wrap-removed |

Refusal wire shape + agent loop: package README, "Gate a single tool". Runnable before/after
target: `examples/gate-my-tool-sample/`. The refusal is a success-shaped result (`isError`
unset) — `trust_level` stays `"presence-only-demo"`; don't claim more than it proves.
