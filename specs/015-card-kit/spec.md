# Feature Specification: One card kit any MCP server can serve

**Issue:** #256 · **Date:** 2026-10-10 · **Branches:** `feat/256-cards-*`, one per stacked pull request
**Builds on:** spec 011 (the grant card gallery, #143 / #151), the multi-store AP2 demo (draft #244, scenarios #253 and #254)
**Follow-ups:** #292 (a developer adds their own card), #293 (the storefront moves onto the kit), #270 (type-check the card page)

## In plain terms

When an AI agent shops for someone inside Claude or ChatGPT, the chat can show small interactive
panels — **cards** — instead of walls of text: the offers side by side, a QR code to sign a
spending permission on the phone, the store's receipt.

Today every server that wants cards writes its own. This spec makes **one card kit in the gate
package** that any MCP server serves in a few lines — an agent's server and, later (#293), a store
built with `createStorefront()` — so no example writes cards again. The AP2 demo's cards are the
visual base; the grant card gallery (spec 011) is reused.

Three rules shape everything below:

1. **A card only shows; it never decides.** Every limit is enforced on the server (security
   invariant 1). A stale or tampered card can unlock nothing.
2. **A card never overclaims.** Every card about a permission, a payment or a grant ends with an
   honesty line the kit writes itself, from a fixed list of trust levels — never from a store's
   own words.
3. **A store is another party.** What a store says (its name, its links, its trust claims, its
   answers) is data. It never becomes an instruction to the model, a sentence written as the
   person, a link the card opens without a check, or an address the server calls.

## Words

- A **grant** is the gate's spending permission: a budget and a per-purchase limit, at one store,
  with a status (`pending`, `authorized`, `denied`, `revoked`). It is the gate's object.
- A **permission card** is the moment a person is asked to sign a grant on their phone: the QR
  code, the limits, the live status. `cards.permission(…)` shows it; `cards.grant(view)` shows a
  grant's state afterwards (budget left, running low, revoked).
- The kit calls the store's grant a **permission** in the cards and the notes, because that is the
  word the person reads. In code, the store's id stays `grantId`; the kit's own id is `permissionId`.

## The surface (caller-first — this IS the DX test)

An agent server (the shape `examples/ap2-multistore/agent.mjs` takes):

```js
import { McpServer } from "@modelcontextprotocol/server";
import { createCards } from "@openmobilehub/credentagent-gate/cards";

// The stores this agent buys from — the only addresses it ever calls. The model names a store by id.
const STORES = new Map([["beanbarn", "https://beanbarn.example"], ["acme", "https://acme.example"]]);

// Once per process.
const cards = createCards({
  // How to read a grant's live status from the store that issued it. Answers { status, trustLevel?, signed? }:
  // `status` is the gate's GrantStatus; `signed` is what the store hands over once the person signed.
  readPermission: ({ store, grantId }) => getJson(`${STORES.get(store.id)}/agent/grants/${grantId}`),
  tools: { buy: "buy" }, // the tool the model calls once the person signed — the kit's notes name it
});

function buildServer() {
  const server = new McpServer({ name: "my-agent", version: "1.0.0" });
  cards.register(server); // the card page, the card's status tool, and the model's wait tool

  server.registerTool("compare-offers", { inputSchema, _meta: cards.toolMeta() }, async ({ product, maxPrice }) =>
    cards.offers({ stores: await readCatalogs(STORES), product, maxPrice, currency: "USD" }),
  );

  server.registerTool("request-permission", { inputSchema, _meta: cards.toolMeta() }, async ({ store, skus, perSpend, budget, why }) => {
    const grant = await postJson(`${STORES.get(store)}/agent/grants`, { skus, perSpend, budget });
    return cards.permission({
      store: { id: store, name: grant.store },
      grantId: grant.grantId,
      approveUrl: grant.approveUrl, // checked (https), shown as a QR code; it reaches the card, not the model's sentences
      products: grant.products,
      limits: { perSpend, budget, currency: "USD" },
      why,
      trustLevel: grant.trustLevel, // shown through the kit's fixed list; an unknown level says so
    }); // the result carries the kit's own permissionId — the model and the card use it from here on
  });

  server.registerTool("buy", { inputSchema, _meta: cards.toolMeta() }, async ({ permissionId, items }) =>
    cards.buy(permissionId, ({ store, signed, idempotencyKey }) =>
      postJson(`${STORES.get(store.id)}/agent/purchase`, { signed, items, idempotencyKey }),
    ), // not signed yet, unknown, or the store's answer — the kit replies for every case
  );
  return server;
}

app.get("/cards", (_req, res) => res.type("html").send(cards.html)); // preview: /cards?view=permission
```

There is no "wait for the signature" tool in the example: `register()` adds it (FR-8), and
`cards.buy()` gets the signed permission without the developer storing it (FR-9).

## Decisions (#256)

| Question | Decision | Why |
| --- | --- | --- |
| Where the kit lives | A new subpath of the gate: `@openmobilehub/credentagent-gate/cards` | An agent depends on the gate (`/agent`) and must never depend on the storefront; the storefront already depends on the gate. |
| React or plain HTML | React, like the gallery | Its pieces are reused, not rewritten. Vite + `vite-plugin-singlefile` build one self-contained HTML at publish time. React and Vite stay dev dependencies. |
| Who registers the tools around the signature | `cards.register(server)` registers the card's status tool AND the model's wait tool | The kit owns both waits, so the "signed" rule and the six outcomes (FR-8) live in one place (principle 7). |
| Who holds the signed permission | The kit, keyed by its own `permissionId`; `cards.buy()` hands it to the purchase | A reader that only reads; no maps in the developer's code (FR-9). |

## Functional requirements

**FR-1 — Packaging.** `packages/credentagent-gate/src/cards/` holds the server half (Node,
published as `./cards`) and `src/cards/ui/` the card page (React, browser only). The server half
imports neither React nor the MCP SDK: it registers through a structural port (the
`registerResource` / `registerTool` methods of the server object it is handed — principle 6); a
lint rule enforces it. The tool input schemas are written by hand (Standard Schema with its JSON
Schema), so the kit needs no schema library. `vite.config.cards.ts` builds `dist/cards/cards.html`
before `tsc`. One new runtime dependency: `uqr` (MIT, no dependencies), the QR encoder.

**FR-2 — `createCards(options?)`, once per process.** Reads the built page and a 12-character hash of
its content at creation and fails fast, with a fix-it message, if the page is missing (no "dev"
fallback URI). Options, all optional:

| Option | Default | Meaning |
| --- | --- | --- |
| `readPermission` | — | How to read a grant's status (FR-8). Required for permission cards. |
| `tools` | `{ wait: "wait-for-signature" }` | `wait`: the name of the model's wait tool the kit registers; `buy`: the developer's purchase tool, named in the kit's notes. |
| `approvalHoldMs` | 45 000 | How long one model wait call holds — under claude.ai's 60 s tool-call limit. Same name and meaning as the storefront's `approvalHoldMs`. |
| `modelGraceMs` | 20 000 | After the model last heard "still waiting", how long it counts as still waiting in its own turn. |

Members: `html`, `register(server)`, `toolMeta({ invoking?, invoked? })`, `grant(view, { note? })`,
`permission(input, { note? })`, `offers(input, { note? })`, `buy(permissionId, purchase)`,
`receipt(answer, { note? })`, and `waitForSignature(permissionId)` (the escape hatch behind the
registered wait tool, returning the FR-8 outcome as typed data).

**The kit's memory is per process.** It remembers permissions for one running copy of the server; a
deploy with several copies (or serverless) needs a shared store, which this spec does not add. The
gate README's card section and the `createCards` doc comment say so.

**FR-3 — One page, two resources.** The same HTML is registered as the MCP Apps resource
(`ui://credentagent-cards/cards-<hash>.html`, `text/html;profile=mcp-app`) for Claude and the Apps SDK
resource (`ui://credentagent-cards/cards-<hash>.skybridge.html`, `text/html+skybridge`) for ChatGPT.
The URI carries the content hash, so a host never serves a stale copy. Both declare a CSP that allows
`data:` images (the QR) and no network origins. The page is served exactly as built — no serve-time
string substitution. `toolMeta()` builds every key both hosts need in one place (`ui.resourceUri`,
`ui/resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible: true`, `openai/toolInvocation`).

**FR-4 — Results, and what is written by whom.** Every builder returns a `CallToolResult`:
`structuredContent` is the card's data, marked with a `kind` (`credentagent.grant` — unchanged —,
`credentagent.permission`, `credentagent.offers`, `credentagent.receipt`); `content` is one text block,
the note for the model followed by the same data as JSON; card-only extras (the QR) ride in `_meta`, so
they cost the model no context. Amounts are in major units of their currency, like the catalog and the
gallery.

- **The kit's sentences are fixed text.** The default notes, the announced sentence (FR-8) and every
  sentence a card shows are written by the kit. Text from a store (names, reasons, product names,
  trust claims) appears only as values in the data, never inside those sentences. A `{ note }` the
  developer passes replaces the default and is the developer's own.
- **The notes name the next tool** (`tools.wait`, `tools.buy`) and **never assume a card is shown**:
  each result's text holds what the person needs without one — for a permission, the link and the
  limits; for a status, the outcome; for offers, the summary; for a receipt, what was charged or why
  not. Many apps show text only.

**FR-5 — The card page.** One React page dispatches on `kind`. It detects its host — MCP Apps
(Claude), `window.openai` (ChatGPT), or a top-level window (preview) — behind one bridge: `call`,
`open`, `tell`. It keeps state outside the DOM and replaces a card only when the result changed
(ChatGPT re-delivers on every `openai:set_globals`); it follows each permission once, however often it
redraws. It takes the host's theme — the MCP Apps style variables and fonts, ChatGPT's
`window.openai.theme`, `prefers-color-scheme` in preview — with light and dark fallbacks. It renders
tool data as text only. An uncaught error shows a sentence, not the host's bare "Runtime error". In a
top-level window, `?view=` renders bundled samples of every card and state (for example `offers`,
`only-one`, `over-limit`, `permission`, `receipt`, `refused`, `unreadable`, and the gallery's grant
states), and `&theme=dark` forces dark.

**FR-6 — Trust levels and the honesty line.** The kit knows a fixed list of levels, each with a
sentence the kit wrote:

| Level | Produced by | The honesty line says |
| --- | --- | --- |
| `presence-only-demo` | a payment credential with no issuer trust anchor yet | "Demo: the signatures are real, but the payment credential is not checked against its issuer yet. No real money moves." |
| `device-signed` | a grant the person signed with their phone's wallet | "Signed on the person's phone; the credential is not checked against its issuer yet." |
| `server-issued-demo` | a grant approved with a click on a page | "Demo: approved with a click on a page — nothing was signed on a phone. No real money moves." |
| anything else | — | "Trust level not recognised by this card; treat it as unverified." |

- A store's own text is never shown as a trust level — not in the honesty line, not in a status
  label. `issuer-verified` from a store's word is "not recognised": the gate never claims it itself,
  and the kit has no verified channel for it yet (issuer-verified trust is #14).
- The permission, receipt and grant cards render inside a frame whose last line is the honesty line;
  there is no public way to render them without it. `trustLevel` is required in `permission()` and in
  the `receipt()` types — said out loud, never defaulted.
- **"Signed on your phone" is said only for `device-signed`.** A grant approved with a click shows
  "Approved on the approval page"; an unknown level shows "Approved (trust level not recognised)".

**FR-7 — Links and addresses.** `approveUrl` is checked where it enters, in `permission()` and
`grant()`: it must be an absolute `https:` URL (`http:` only for `localhost`, `127.0.0.1` or `[::1]`,
for local development). Anything else — `javascript:`, `data:`, a relative path — throws a fix-it
error to the developer before a card or a note is built. The card's status tool takes only the kit's
`permissionId`, never an address. The surface example calls only stores from a list the server knows.

**FR-8 — The permission card and the wait for the signature.** `permission(input)` takes
`{ store: { id, name, url?, merchantId? }, grantId, approveUrl, products, limits: { perSpend, budget,
currency }, why?, trustLevel }`, creates the kit's own **`permissionId`** (random, `perm_…`),
remembers the input under it (in memory, inside the `createCards` instance; an entry expires an hour
after its last use — never one shared key, invariant 4), and returns the card with the QR of
`approveUrl` in `_meta`. The card shows the QR, an "Open link" button, the limits, the reason and a
live status.

`readPermission` receives the remembered `{ store, grantId }` and answers `{ status, trustLevel?, signed? }`, where `status` is the gate's `GrantStatus`
(`"pending" | "authorized" | "denied" | "revoked"`) and `signed` is whatever the store hands over once
the person signed (the AP2 signed intent, for example); the kit keeps `signed` for `buy()`. A
`status` outside `GrantStatus`, a missing answer or a thrown read is a **failed read** — never "not
signed".

The model's wait tool (`tools.wait`, registered by `register()`, taking only a `permissionId`) and
`waitForSignature()` read the status every 1.5 s, hold up to `approvalHoldMs`, and answer one of six
outcomes, each with a fixed reply and a fixed next step:

| Outcome | When | The model is told | Next |
| --- | --- | --- | --- |
| `signed` | `authorized` | "Signed. Call {buy} with this permissionId." | stop waiting |
| `waiting` | still `pending` at the end of the hold | "Not signed yet — call {wait} again now; don't end your turn." | call again |
| `declined` | `denied` | "The person declined this permission. Don't ask again unless they say so." | stop |
| `revoked` | `revoked` | "This permission was withdrawn; nothing can be bought with it." | stop |
| `unknown` | this server does not know the `permissionId` | "This server no longer knows this permission (it may have restarted). Ask for a new one." | stop |
| `unreadable` | a failed read | "Couldn't check with the store just now — call {wait} again." | call again |

The card's status tool (`credentagent-permission-status`) is read-only, hidden from the model
(`_meta.ui.visibility: ["app"]`), callable from the card (`openai/widgetAccessible: true`), holds up to
25 s, and answers the same outcomes. For `unknown`, the card shows "This server no longer knows this permission" — not "Not
signed". The card may tell the chat "signed" **once per permission, decided on the server, never while
the model is still waiting in its own turn** (a wait call is open, or one — or `permission()` —
returned less than `modelGraceMs` ago). If the model already saw the signature, nothing is said; a
redrawn, reloaded or duplicated card never announces twice. The announced sentence is fixed text carrying only the
kit's `permissionId`: "I signed the permission on my phone ({permissionId}). Please go ahead." This
rule removes one cause of a double purchase (the card and the model both going ahead); it is not the
protection against one — FR-9 is. How long the card waits for the model to notice a signature is its
own bound (20 s), not `modelGraceMs`. Announcing uses MCP Apps `ui/message`; ChatGPT's follow-up
message is a fallback only (it did not post in real ChatGPT).

**FR-9 — Buying, and buying once.** `buy(permissionId, purchase)`: for a permission that is not
`signed`, it answers the FR-8 reply for its outcome without calling `purchase`. For a signed one, it
calls `purchase({ store, grantId, signed, idempotencyKey })` and passes the store's answer to
`receipt()`.

- **The store is the guard against a second order:** it keeps purchases by idempotency key and
  answers a repeated key with the first answer.
- **The kit gives each purchase a key and reuses it until it has read the store's answer.** A retry
  after an answer the kit could not read — or after `purchase` threw — sends the same key, so it can
  never become a second order. Once a paid or refused answer was read, the next `buy` is a new
  purchase with a new key.

**FR-10 — Receipt.** `receipt(answer)` takes the store's answer: `{ ok: true, order: { id, store,
total, currency, items, checks }, receiptUrl?, trustLevel }` or `{ ok: false, store?, code?, reason,
trustLevel }`. **It never throws because of what a store answered.** Paid: the total, the items, the
store's checks, "Open receipt". Refused: who, why, "Nothing was charged." Anything it cannot read —
a missing `ok`, a total that is not a number, a currency that is not a three-letter code, a missing
`trustLevel`, an error
body — is shown as its own state: "The store answered, but this card couldn't read the answer. The
purchase may have gone through — check with the store before trying again," with the "not
recognised" honesty sentence, and the note tells the model the same and not to buy again.
`receiptUrl` follows FR-7.

**FR-11 — Offers.** `offers({ stores, product?, maxPrice?, currency })`, where each store is
`{ store, url, products: [{ id, name, price, currency, rating? }] }` or `{ url, error }`.

- **Matching a product:** an exact match is the product's `id`; otherwise the query matches a name
  only as whole words, case-insensitively ("tea" does not match "Steak"). The summary records which
  kind matched; the note tells the model to act only on an exact match and to confirm a name match
  with the person first.
- **The summary,** in fixed sentences: no store sells it; only one store sells it, so there is
  nothing to compare; n of m sell it within the limit; none is within the limit and the cheapest is x.
  A store that could not be read is never counted as "does not sell it": the sentences say "among the
  stores I could read" and the card says how many could not be read. Over the limit, the note says
  not to request a permission and not to buy.
- **Tags:** "Lowest price" and "Top rated" appear only when two or more stores sell the product in the
  same currency; a price over `maxPrice` is tagged.
- **Currency:** amounts are formatted for their currency. `maxPrice` is in `currency`; prices in
  other currencies are listed but never ranked against it or each other — no "Lowest price",
  "cheapest" or "within the limit" across currencies.

## Security and honesty (summary)

- Display only: no card enforces anything; every status a card shows is read on the server.
- The card's status tool is read-only and takes only the kit's id — never an address from the card.
- What a store says is data (rule 3): fixed sentences (FR-4), checked links (FR-7), known stores in
  the example, the kit's own ids (FR-8).
- The honesty line comes from the kit's fixed list (FR-6); the store's own trust words are never shown.
- Nothing here changes a ceremony rail, a completion path or a verifier.

## Constraints (for every step)

- All repository content in English; every commit signed off (DCO).
- Verify with the root run: `npm run build && npm test && npm run lint`.
- The server half imports neither React nor the MCP SDK (lint-enforced); the MCP SDK appears only in tests.
- Tool data is rendered as text only — never `dangerouslySetInnerHTML`. No serve-time substitution of the page.
- New per-permission state lives inside a factory, keyed by the kit's id — never module-level (invariant 4).
- Exact values: resource URIs `ui://credentagent-cards/cards-<hash>.html` / `…skybridge.html`; MIME
  `text/html;profile=mcp-app` / `text/html+skybridge`; CSP `data:` images, no network origins; kinds
  `credentagent.grant`, `credentagent.permission`, `credentagent.offers`, `credentagent.receipt`; the
  card's status tool `credentagent-permission-status`; the QR's `_meta` key `credentagent/qr`.
- Every step that adds or changes a card shows it in its pull request: each state in light and dark,
  and real-host captures when the step claims host behaviour.

## Non-goals

- No consent inside a card: signing happens on the phone; approval on the ceremony page.
- No shared store for the kit's memory yet (one running copy; FR-2).
- No custom cards yet: publishing the React pieces and a custom page is #292.
- Restyling the gallery onto the host's theme variables (it keeps its own tokens for now).
- The storefront keeps its own page for now; moving it onto the kit is #293.

## Increments (stacked pull requests, one at a time)

Each step is reviewed and merged before the next is marked ready, and is brought in line with this
spec first. The steps already open, and what each takes from this spec:

| Step | Pull request | Brings in line |
| --- | --- | --- |
| 1 | #258 — the gallery moves into the gate | (merged as is) |
| 2 | #259 — the card page | FR-5 |
| 3 | #272 — `createCards()` serves it | FR-2 names and options; FR-7 for `grant()`'s link |
| 4 | #273 — the server's "signed" rule | FR-8: the kit's `permissionId`, the six outcomes, the card's own notice bound; FR-2 / FR-8 names (`perSpend`, `budget`, `currency`, `approvalHoldMs`) |
| 5 | #274 — `permission()` and the wait | FR-7, FR-8, FR-6 (`trustLevel` list); `perSpend` / `budget` / `currency`; the wait tool registered |
| 6 | #275 — the permission card | FR-6 (honesty line, status label); `perSpend` / `budget` and currency formatting |
| 7 | #276 — the live status | FR-6 ("Signed on your phone" only for `device-signed`), FR-8 (`unknown`, fixed announcement) |
| 8 | #277 — the offers card | FR-4 (fixed notes), FR-11 (matching, currency) |
| 9 | #278 — the receipt card | FR-6 (the receipt's honesty line), FR-9, FR-10 (`buy()`, the unreadable state) |
| — | #279 — the AP2 demo on the kit (not for merge) | known stores, `cards.buy()`, the store's idempotency key |

## Acceptance

- [ ] Root `npm test` green, including: both resources from one page with the hashed URI and the CSP;
      `toolMeta` carries every key; a missing page fails fast; the built page's script parses and
      carries the MCP Apps client; the gallery's tests unchanged after the move.
- [ ] **The README's card example is run by a test** (like `src/ap2/readme-example.test.ts`), plus one
      test per wait outcome (FR-8).
- [ ] Tests that fail when their control is removed:
  - the honesty line on the permission, receipt and grant cards (the gallery's test unchanged);
  - a store's name or reason never appears inside a kit sentence (notes, the announcement, card copy);
  - a call to the card's status tool that passes an address is refused;
  - `approveUrl` other than `https:` (or local `http:`) is refused, in `permission()` and `grant()`;
  - an unknown trust level, including a store's `issuer-verified`, shows the "not recognised" sentence;
  - "Signed on your phone" never shows for `server-issued-demo`;
  - two stores with the same `grantId` are never mixed up;
  - an unknown `permissionId` never shows as "not signed";
  - a `status` outside `GrantStatus` is a failed read;
  - a retry after an unreadable answer sends the same idempotency key;
  - `receipt()` never throws for a malformed store answer and shows the unreadable state;
  - a name match never counts as exact; prices in two currencies are never ranked;
  - the announcement fires once per permission and never while the model waits.
- [ ] `node examples/ap2-multistore/smoke.mjs` green on the demo (#279) once it is on the kit.
- [ ] Every card state checked in a browser, light and dark; each card checked in real Claude and
      real ChatGPT before saying it works.

## Open questions

- Whether ChatGPT shows `credentagent-permission-status` to the model despite `ui.visibility: ["app"]`;
  if it does, add the Apps SDK's own hide-from-model flag.
