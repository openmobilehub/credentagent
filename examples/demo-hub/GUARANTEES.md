# What each piece guarantees — and the one command that proves it

You don't have to read the code or take my word for it. Each guarantee below is a plain sentence,
then the **one command** that proves it, and **what you should see**. Every "prove it" command is a
test that **fails if the protection is removed** — so a green run means the protection is really there.

Run all the checks at once:

```bash
npm run build && npm test          # every guarantee below, plus the rest of the suite
```

---

### 1. An age-restricted order can't be completed without proving age

**Guarantee:** a wine order (21+) can never be finished by a shortcut — only through the real wallet
ceremony. Hiding the button isn't enough; the server refuses it.

```bash
node examples/orders-checkout/smoke.mjs
```
**You should see:** `✓ a gated order is REFUSED on the instant-demo path (403)` and
`✓ … stays PENDING after the refused place`.

---

### 2. The price is decided by the server, never trusted from the link

**Guarantee:** the amount is re-derived from your catalog server-side, so a hand-edited link can't
change what settles.

```bash
node examples/orders-checkout/smoke.mjs
```
**You should see:** `✓ ungated order retrieves as ok with the server-derived amount ($5)` — the
amount comes from the server, not the request.

---

### 3. A forged webhook is rejected

**Guarantee:** the receiving service only accepts a notification **signed with the shared secret**.
A forged, tampered, or replayed message is refused — it never triggers fulfillment.

```bash
node examples/order-webhooks/smoke.mjs
```
**You should see:** `✓ a forged event (wrong secret) is rejected with 400` and
`✓ the forged event was NOT recorded`, alongside `✓ … a verified order.settled event`.

---

### 4. The webhook is delivered reliably, and is safe to receive twice

**Guarantee:** every event carries a stable `id` so your service can safely ignore a duplicate, and
delivery is **at-least-once with retry** (a brief receiver outage doesn't lose the event).

```bash
node examples/order-webhooks/smoke.mjs
```
**You should see:** `✓ the event has a stable id to dedupe on`. (The retry-with-backoff behavior is
covered by the full suite — `npm test` — in `webhooks.test.ts`.)

---

### 5. Refusal reasons are typed, so a typo can't slip through

**Guarantee:** when a call is refused, the `code` telling you why is a fixed set of values — a typo
like `"budget-exceded"` fails to compile instead of silently never matching.

```bash
npm run build         # the type check IS the proof
```
**You should see:** a clean build; in your editor, `res.code === "not-found"` autocompletes and a
typo is flagged. (Shipped in the orders door; the grants/webhook refusals were already typed.)

---

### 6. A delegated grant can't buy what you didn't allow — and never age-restricted goods

**Guarantee:** a pre-approved grant ("$100, $30/purchase, Beverages only") is enforced by the
server on every spend: the wrong item refuses `not-allowed`, an unapproved grant refuses
`not-authorized`, over-cap/over-budget refuse, a revoked grant refuses — and **age-restricted goods
always refuse** (`step-up`): buying wine needs a live human, no matter the budget.

```bash
npm run test --workspace=@openmobilehub/credentagent-gate -- run src/grants.test.ts
```
**You should see:** 9 passed — including the two BYPASS tests (each proven to fail when its check is
removed). Or just click through **Section 3 of the hub** and watch every refusal land in the feed.

---

### 7. A real AI agent can complete the flow unaided — proven nightly

**Guarantee:** every night, a real Claude agent is pointed at the live store with one plain-language
task ("buy the whiskey") and no help. The check fails if the agent can no longer figure out our
tools, if the age gate or honesty labels stop reaching the agent, or if anything claims a gated
order completed. This catches what no scripted test can: drift in the *agent-facing* contract.

```bash
ANTHROPIC_API_KEY=... node ci/agent-e2e/agent-e2e.mjs
```
**You should see:** `ALL AGENT-E2E CHECKS PASSED`, with the agent's tool-call chain printed
(browse → add → checkout) and the assertions on the trace. Runs automatically via the
`agent-e2e` GitHub Action (nightly + on-demand).

## The short version

- **Nothing completes without the proof it requires** (age, payment) — enforced on the server (#1).
- **You can't change the price from the outside** (#2).
- **Only genuinely-signed notifications are accepted** (#3), delivered reliably and safe to retry (#4).
- **The API tells you *why* in typed terms, not loose strings** (#5).
- **A grant bounds what, how much, and for whom — and age never delegates** (#6).
- **A real AI agent can drive the whole flow unaided** — checked nightly against the live demo (#7).

Each of these is pinned by a test that goes red if the protection is deleted — that's the difference
between "it looks like it works" and "it's proven to work."
