# Feature Specification: One card kit any MCP server can serve

**Feature branches:** `feat/256-cards-*`, one per stacked pull request below · **Issue:** #256 · **Date:** 2026-10-08
**Builds on:** spec 011 (the grant card gallery, #143 / #151), the multi-store AP2 demo (draft #244, scenarios #253 and #254)
**Broadens:** #176 (publish the gallery), whose remaining half becomes this kit's follow-up

## In plain terms

When an AI agent shops for someone inside Claude or ChatGPT, the chat can show small interactive
panels — **cards** — instead of walls of text: the offers side by side, a QR code to sign a
spending permission on the phone, the store's receipt.

Today every server that wants cards writes its own, and this repository already has two
separate sets: the grant card gallery (React, inside the storefront's widget, served only by
`createStorefront()`), and the AP2 demo's cards (plain HTML, inside the example). This spec
makes **one card kit in the gate package** that any MCP server serves in a couple of lines — a
store built with `createStorefront()` and an agent server alike — so no example writes cards
again. The demo's cards are the visual base; the gallery's pieces are reused.

Two rules shape everything below:

1. **A card only shows; it never decides.** Every limit is enforced on the server (security
   invariant 1). A stale or tampered card can unlock nothing.
2. **A card never overclaims.** Every card about a permission, a payment, or a grant carries the
   honesty line — built from the result's `trustLevel`, impossible to omit — saying the
   credential is a presence-only demo and no real money moves.

## The surface (caller-first — this IS the DX test)

An agent server (the shape `examples/ap2-multistore/agent.mjs` takes once migrated):

```js
import { McpServer } from "@modelcontextprotocol/server";
import { createCards } from "@openmobilehub/credentagent-gate/cards";

// Once per process: the card page for Claude and ChatGPT, and how to read a permission's
// live status — here, from the store that issued it.
const cards = createCards({
  readPermission: ({ grantId, store }) => getJson(`${store.url}/agent/grants/${grantId}`),
});

function buildServer() {                              // stateless servers build one per request
  const server = new McpServer({ name: "my-agent", version: "1.0.0" });
  cards.register(server);                             // card page (both chat apps), its CSP, the card's status tool

  server.registerTool("compare-offers", { inputSchema, _meta: cards.toolMeta() }, async ({ product, maxPrice }) =>
    cards.offers({ stores: await readCatalogs(), product, maxPrice }),
  );

  server.registerTool("request-permission", { inputSchema, _meta: cards.toolMeta() }, async (args) => {
    const grant = await postJson(`${args.store}/agent/grants`, { /* … */ });
    return cards.permission({
      grantId: grant.grantId,
      store: { name: grant.store, url: args.store },
      approveUrl: grant.approveUrl,                   // becomes the QR code: it reaches the card, not the model
      products: grant.products,
      limits: { perPurchase: args.perSpend, total: args.budget },
      why: args.why,
      trustLevel: grant.trustLevel,                   // said out loud, never defaulted
    });
  });

  server.registerTool("check-permission", { inputSchema }, async ({ grantId }) => {
    const signed = await cards.waitForSignature(grantId); // holds up to 45 s; the card stays quiet meanwhile
    return reply(signed.status === "authorized" ? "Signed. Call buy now." : `Not signed yet (${signed.status}). Call again.`);
  });

  server.registerTool("buy", { inputSchema, _meta: cards.toolMeta() }, async (args) =>
    cards.receipt(await purchase(args)),              // the store's answer: { ok: true, order } or { ok: false, reason }
  );
  return server;
}

app.get("/cards", (_req, res) => res.type("html").send(cards.html)); // preview: /cards?view=permission
```

A store built with `createStorefront()` writes nothing: its grant tools keep rendering the
gallery, which now lives in the kit.

## Decisions (#256, `needs-decision`)

| Question | Decision | Why |
| --- | --- | --- |
| Where the kit lives | A new subpath of the gate: `@openmobilehub/credentagent-gate/cards` | An agent depends on the gate (`/agent`) and must never depend on the storefront; the storefront already depends on the gate. A third package is one more thing to version for code both need. |
| React or plain HTML | React, like the gallery | Its pieces are reused, not rewritten. Vite + `vite-plugin-singlefile` build one self-contained HTML at publish time, exactly like the storefront widget. React and Vite stay dev dependencies. |
| Who registers the card-only tool | `cards.register(server)` does | The server supplies one reader, once. The kit owns both waits, so the "signed" announcement rule lives in one place (principle 7: one choke point). |

## Functional requirements

**FR-1 — Packaging.** `packages/credentagent-gate/src/cards/` holds the server half (Node,
published as `./cards`) and `src/cards/ui/` the card page (React, browser only). The server half
imports neither React nor the MCP SDK: it registers through a structural port (the
`registerResource` / `registerTool` methods of the server object it is handed — principle 6).
`vite.config.cards.ts` builds `src/cards/ui/cards.html` into `dist/cards/cards.html`; the
package's `build` script runs it before `tsc`. No new runtime dependency except, from increment
2, `uqr`, a dependency-free QR encoder.

**FR-2 — `createCards(options?)`, once per process.** Reads the built page and a short hash of
its content at creation, and **fails fast** with a fix-it message if the page is missing (the
storefront's `bundleVersion` rule — never a "dev" fallback URI). Options, all optional:
`readPermission` (FR-7), `holdMs` (model wait, default 45 000 — under claude.ai's 60 s
tool-call limit, the storefront's `approvalHoldMs`), `modelGraceMs` (default 20 000).
Returns `cards`:

| Member | What it does |
| --- | --- |
| `register(server)` | Registers the two resources (FR-3) and, when `readPermission` is set, the card-only tool (FR-7). Per server instance. |
| `toolMeta({ invoking?, invoked? })` | The tool `_meta` linking a tool's result to the card page on both hosts: `ui.resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible: true`, `openai/toolInvocation`. One builder, so no key can be forgotten (the storefront's `appToolMeta` rule). |
| `grant(view, { note? })` | Result for a grant (`GrantViewData`, moved from the storefront). |
| `permission(input, { note? })` | Result for a permission to sign (FR-7). |
| `offers(input, { note? })` | Result for compared offers (FR-8). |
| `receipt(answer, { note? })` | Result for the store's answer to a purchase (FR-9). |
| `waitForSignature(grantId)` | The model's hold (FR-7). |
| `html` | The page itself, for a preview route. |

**FR-3 — One page, two resources.** The same HTML is registered as the MCP Apps resource
(`ui://credentagent-cards/cards-<hash>.html`, `text/html;profile=mcp-app`) for Claude and the
Apps SDK resource (`ui://credentagent-cards/cards-<hash>.skybridge.html`,
`text/html+skybridge`) for ChatGPT. The URI carries the content hash, so a host never serves a
stale cached copy. Both declare a CSP that allows `data:` images (the QR) and no network
origins. The page is served exactly as built — **no serve-time string substitution**.

**FR-4 — Results.** Every builder returns a `CallToolResult`: `structuredContent` is the card's
data, marked with a `kind` (`credentagent.grant` — unchanged —, `credentagent.permission`,
`credentagent.offers`, `credentagent.receipt`); `content` is one text block, the note for the
model followed by the JSON; card-only extras (the QR) ride in `_meta`, so they cost the model no
context. Each builder has a default note (what the model should say and do next); `{ note }`
replaces it. Amounts are in major units (dollars), like the catalog and the gallery.

**FR-5 — The card page.** One React page dispatches on `kind`. It detects its host — MCP Apps
(Claude), `window.openai` (ChatGPT), or a top-level window (preview) — behind one bridge:
`call(tool, args)`, `open(url)`, `tell(text)`. Lessons it must keep (each proven on the demo
branch):

- ChatGPT re-delivers globals on every `openai:set_globals`. The page keeps card state outside
  the DOM, re-renders only when the result actually changed, and runs one status poll per
  permission however often it redraws.
- Host theme: the MCP Apps style variables and fonts, with light and dark fallbacks; ChatGPT's
  `window.openai.theme`; `prefers-color-scheme` in preview.
- Tool data is rendered as text only — never `dangerouslySetInnerHTML`.
- An uncaught error shows a sentence in the card, not the host's bare "Runtime error".
- Preview: in a top-level window, `?view=` renders bundled samples — `offers`, `only-one`,
  `over-limit`, `permission`, `receipt`, `refused`, and the gallery's grant states — and
  `&theme=dark` forces dark.

**FR-6 — Honesty frame (load-bearing, bypass-tested).** The permission, receipt, and grant cards
render inside a frame whose last line is the honesty line, built from the data's `trustLevel`
(for `presence-only-demo`: "Demo: the signatures are real, but the payment credential is not
issuer-verified yet (presence-only-demo). No real money moves."). `trustLevel` is **required**
in `permission` and `receipt` input — never defaulted, the same "said out loud" rule
`verifyDelegatedPurchase({ trust })` enforces. There is no public way to render those cards
without the frame. The gallery keeps its existing frame and its existing bypass test unchanged.

**FR-7 — Permission with live status.** `permission(input)` takes `{ grantId, store: { name,
url?, merchantId? }, approveUrl, products, limits: { perPurchase, total }, why?, trustLevel }`;
the QR of `approveUrl` (an SVG data URL) rides in `_meta` under the key `credentagent/qr`
(generated with `uqr`, MIT, no dependencies). The card shows the QR, an "Open link" button, the
limits, the reason, and a live status: "Waiting for your signature" → "Signed on your phone" (or
"Not signed · <status>").

- **The kit remembers what it issued**, keyed by grant id (in memory, per process, entries
  expire an hour after their last use; never one shared key — invariant 4). `readPermission`
  receives that remembered input; the card-only tool takes **only a `grantId`** and never a URL
  from the card.
- **`waitForSignature(grantId)`** (the main path): calls `readPermission` every 1.5 s until the
  status is not `pending` or `holdMs` passes, and returns what the reader returned (so an agent
  keeps, for example, the signed intent). An unknown grant id answers `{ status: "unknown" }`.
- **The card-only tool** `credentagent-permission-status`, registered by `register(server)`,
  hidden from the model (`_meta.ui.visibility: ["app"]`) and callable from the card
  (`openai/widgetAccessible: true`). It holds up to 25 s and answers `{ status, trustLevel?,
  announce, final }`.
- **The announcement rule** (the demo's double-purchase fix): once signed, the card may tell the
  chat "signed" **exactly once per grant, decided on the server, and never while the model is
  waiting in its own turn** — a `waitForSignature` call is open, or one (or `permission()`)
  returned less than `modelGraceMs` ago. If the model already saw the signature, nothing is
  said. A redrawn, reloaded, or duplicated card never announces twice.
- **Announcing** uses MCP Apps `ui/message`. ChatGPT's `sendFollowUpMessage` did **not** post in
  real ChatGPT, so it is wired as a fallback only, and the README says so; the dependable path
  is the model waiting in its turn.

**FR-8 — Offers.** `offers({ stores, product?, maxPrice? })`, where each store is `{ store, url,
products: [{ id, name, price, rating? }] }` or `{ url, error }`. The kit narrows the catalogs to
`product` when given and derives the summary the card states plainly — no store sells it; only
one store sells it, so there is nothing to compare; *n* of *m* sell it within the limit; none is
within the limit and the cheapest costs *x* at *store* — plus a matching default note (for
example: over the limit → do not request a permission, do not buy). "Lowest price" and "Top
rated" tags appear only when two or more stores sell the product; prices over `maxPrice` are
tagged.

**FR-9 — Receipt.** `receipt(answer)` takes the store's answer as-is: `{ ok: true, store?,
order: { id, store, total, currency, items, checks, trustLevel }, receiptUrl? }` or `{ ok:
false, store?, code?, reason }`. Paid: the total, the items, the list of what the store checked,
and "Open receipt". Refused: who refused, the reason, "Nothing was charged."

## Security and honesty

- Display only: no card enforces anything; every status the card shows is read on the server.
- The card-only tool is read-only and takes no URL from the card.
- `trustLevel` is required data on every card that shows consent or payment; copy for a level
  the kit does not know shows the level verbatim and claims nothing more.
- Nothing here changes a ceremony rail, a completion path, or a verifier.

## Non-goals

- No consent inside a card: signing happens on the phone; approval on the ceremony page.
- No multi-instance watch store yet (a shared store is an additive option later).
- Restyling the gallery onto the host theme variables (it keeps its own tokens for now).
- Publishing the React pieces for custom views — that is the follow-up kept in #176
  (`…/cards/react` plus a `createCards({ bundle })` option).

## Increments (stacked pull requests, about 500 lines each, one concern each)

1. **Kit core** — FR-1 to FR-5 with `grant()`, in three pull requests to stay near 500 lines
   each (plan: `plan-increment-1.md`):
   - **1a** — this spec, and the gallery **moved without behavior change**: `GrantViewData` and
     `GRANT_VIEW_KIND` move to the gate's new `./cards` subpath; the storefront's picker
     compiles the gallery from its new home through a relative source import (internal, not a
     published API), so its widget is unchanged.
   - **1b** — the card page: bridge, redraw guard, theme, preview, and its one-file build.
   - **1c** — the server half: `createCards`, `register`, `toolMeta`, `grant()`.
2. **Permission card** — FR-6, FR-7, in four pull requests (plan: `plan-increments-2-3.md`): 2a the
   permission watch (when the card may say "signed"); 2b the API (`permission()`, `waitForSignature()`,
   the QR, the card-only tool); 2c the card on the page; 2d its live status.
3. **Offers and receipt cards** — FR-8 (3a), FR-9 (3b).
4. **Migrate `examples/ap2-multistore`** to the kit and delete its `widget/`. The demo (#244) is
   not for merge, so this pull request sits on the demo's stack (#254) and its stores answer in
   the FR-7/FR-9 shapes. `examples/hnp-on-claude` has no cards of its own (it uses
   `createStorefront()`), so it needs no migration.

## Acceptance

- [ ] Root `npm test` green, including: both resources registered from one page with the
      hashed URI and the CSP; `toolMeta` carries all four keys; a missing page fails fast; the
      built page's inline script parses and contains the MCP Apps client; the gallery's
      existing tests pass unchanged after the move.
- [ ] Bypass tests that fail when their control is removed: the honesty line on the permission
      and receipt cards; a second announcement for the same grant; an announcement while the
      model waits; a card-only call that passes a URL.
- [ ] `node examples/ap2-multistore/smoke.mjs` green after increment 4.
- [ ] Every preview view checked in a browser, light and dark.
- [ ] Each card checked in real Claude and real ChatGPT before saying it works.

## Open questions

- Whether ChatGPT shows `credentagent-permission-status` to the model despite
  `ui.visibility: ["app"]`. Increment 2 checks it in real ChatGPT; if it does, add the Apps
  SDK's own hide-from-model flag.
