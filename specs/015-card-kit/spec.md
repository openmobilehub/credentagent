# Feature Specification: One card kit any MCP server can serve

**Issue:** #256 · **Date:** 2026-10-12 · **Branches:** `feat/256-cards-*`, one per stacked pull request
**Builds on:** spec 011 (the grant card gallery, #143 / #151), spec 014 (AP2 delegation, #235), the multi-store AP2 demo (scenarios #253 and #254)
**Follow-ups:** #292 (a developer adds their own card), #293 (the storefront moves onto the kit), #270 (type-check the card page)

## In plain terms

When an AI agent shops for someone inside Claude or ChatGPT, the chat can show small interactive
panels — **cards** — instead of walls of text: the offers side by side, a QR code to approve a
spending permission from the phone, the store's receipt.

Today every server that wants cards writes its own, and every agent writes its own code to wait for
an approval and to buy with it. This spec adds two things to the gate package:

- **Permissions** (`@openmobilehub/credentagent-gate/agent`): remember the permissions an agent asked
  for, wait for the person to approve one, and buy with it — exactly once per purchase. Plain data in,
  plain data out; no chat and no card needed, so a text-only agent or a timer uses it the same way.
- **Cards** (`@openmobilehub/credentagent-gate/cards`): one card kit any MCP server serves in a few lines
  — an agent's server and, later (#293), a store built with `createStorefront()` — so no example writes
  cards again. The AP2 demo's cards are the visual base; the grant card gallery (spec 011) is reused.

Three rules shape everything below:

1. **A card only shows; it never decides.** Every limit is enforced on the server (security
   invariant 1). A stale or tampered card can unlock nothing. Deciding whether a purchase may be sent,
   and sending it, belongs to permissions — never to a card.
2. **A card never overclaims.** Every card about a permission, a payment or a grant ends with an
   honesty line the kit writes itself, from a fixed list of trust levels — never from a store's
   own words — and it says the level is what the store reports, since the kit cannot check it yet.
3. **A store is another party.** What a store says (its name, its links, its trust claims, its
   answers) is data. It never becomes an instruction to the model, a sentence written as the
   person, a link the card opens without a check, or an address the server calls.

## Words

- A **grant** is the gate's spending permission: a budget and a per-purchase limit, at one store,
  with a status (`pending`, `authorized`, `denied`, `revoked`). It is the store's object.
- The kit calls a grant a **permission** in the cards and the notes, because that is the word the
  person reads. In code, the store's id stays `grantId`; the agent's own id for it is `permissionId`.
- The **approval** is what the store hands over once the person approved (for an AP2 grant, the signed
  intent the agent spends with its own key). Some grants hand over nothing.
- **Which card:** use `cards.permission()` when your server asks the person to approve a new
  permission — it shows the QR and follows the status live. Use `cards.grant(view)` to show a grant
  your server already has — its budget, what was spent, or that it still needs approval (the gallery's
  "Needs approval" state, for a list of grants); it does not follow the status.

## The surface (caller-first — this IS the DX test)

An agent server (the shape `examples/ap2-multistore/agent.mjs` takes):

```js
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentKey, DelegatedIntent, createPermissions } from "@openmobilehub/credentagent-gate/agent";
import { createCards } from "@openmobilehub/credentagent-gate/cards";

// The stores this agent buys from — the only addresses it ever calls. The model names a store by id,
// and the input schemas accept only these ids: the SDK refuses any other before a handler runs.
const STORES = new Map([["beanbarn", "https://beanbarn.example"], ["acme", "https://acme.example"]]);
const storeId = z.enum([...STORES.keys()]);
const agentKey = AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY));
const instrument = { id: "card-on-file", type: "card" };

// Once per process. Permissions remember what the agent asked for, wait, and buy — no card needed.
const permissions = createPermissions({
  // How to read a grant from the store that issued it: { status, trustLevel?, approval? }.
  read: ({ store, grantId }) => getJson(`${STORES.get(store.id)}/agent/grants/${grantId}`),
});
// The cards show them. The kit's notes tell the model to call `buy` once a permission is approved.
const cards = createCards({ permissions, tools: { buy: "buy" } });

const offersInput = z.object({ product: z.string(), maxPrice: z.number().positive().optional() });
const permissionInput = z.object({
  store: storeId, skus: z.array(z.string()), perSpend: z.number().positive(), budget: z.number().positive(),
  why: z.string().optional(),
});
const buyInput = z.object({
  permissionId: z.string(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
  purchaseId: z.string().describe("A new id for each purchase; the same id to retry one."),
});

// Sends one purchase: the store prices the cart, and the agent spends the person's approval with its own key.
const sendPurchase = (items) => async ({ store, approval, idempotencyKey }) => {
  const base = STORES.get(store.id);
  const quote = await postJson(`${base}/agent/checkout`, { items });
  const proof = await DelegatedIntent.fromWalletPresentation(approval)
    .spend({ agentKey, checkoutJwt: quote.checkoutJwt, instrument, audience: quote.audience, nonce: quote.nonce });
  return postJson(`${base}/agent/purchase`, { proof, idempotencyKey }); // the store's answer
};

function buildServer() {
  const server = new McpServer({ name: "my-agent", version: "1.0.0" });
  cards.register(server); // the card page, the card's status tool, and the model's wait tool

  server.registerTool("compare-offers", { inputSchema: offersInput, _meta: cards.toolMeta() }, async ({ product, maxPrice }) =>
    cards.offers({ stores: await readCatalogs(STORES), product, maxPrice, currency: "USD" }),
  );

  server.registerTool("request-permission", { inputSchema: permissionInput, _meta: cards.toolMeta() }, async ({ store, skus, perSpend, budget, why }) => {
    const grant = await postJson(`${STORES.get(store)}/agent/grants`, { skus, perSpend, budget, agentKey: agentKey.publicJwk });
    return cards.permission({
      store: { id: store, name: grant.store },
      grantId: grant.grantId,
      approveUrl: grant.approveUrl,   // the store's link: shown as a QR only if it is a safe web address
      products: grant.products,
      limits: { perSpend, budget, currency: "USD" },
      why,
      trustLevel: grant.trustLevel,   // the store's claim, shown through the kit's fixed list
    }); // tracks it in `permissions`; the result carries the permissionId the model uses from here on
  });

  // The model names each purchase: the same purchaseId twice is one order. Not approved yet,
  // declined, unknown, or the store's answer — `cards.purchase()` replies for every case.
  server.registerTool("buy", { inputSchema: buyInput, _meta: cards.toolMeta() }, async ({ permissionId, items, purchaseId }) =>
    cards.purchase(await permissions.buy(permissionId, { idempotencyKey: purchaseId, send: sendPurchase(items) })),
  );
  return server;
}

app.get("/cards", (_req, res) => res.type("html").send(cards.html)); // preview: /cards?view=permission
```

There is no "wait for approval" tool in the example: `cards.register()` adds it (FR-13). And the same
permission buys outside a chat — a timer that buys when the price drops, with no card page:

```js
const permissionId = permissions.track({ store: { id: "beanbarn" }, grantId: saved.grantId });
const result = await permissions.buy(permissionId, { idempotencyKey: `price-drop-${today}`, send: sendPurchase(saved.items) });
if (result.ok) log(result.answer); // the store's answer
else log(result.code);             // "pending" | "denied" | "revoked" | "unknown" | "read-failed" | "send-failed"
```

## Decisions (#256)

| Question | Decision | Why |
| --- | --- | --- |
| Where the cards live | A new subpath of the gate: `@openmobilehub/credentagent-gate/cards` | An agent depends on the gate and must never depend on the storefront; the storefront already depends on the gate. |
| Where waiting and buying live | `createPermissions()` in `@openmobilehub/credentagent-gate/agent`, beside `AgentKey` and `DelegatedIntent` | The cards stay display only (rule 1). An agent with no card page — text only, or a timer — waits and buys the same way, and reads a plain result. |
| React or plain HTML | React, like the gallery | Its pieces are reused, not rewritten. Vite + `vite-plugin-singlefile` build one self-contained HTML at publish time. React and Vite stay dev dependencies. |
| Who registers the chat tools around an approval | `cards.register(server)` registers the card's status tool and the model's wait tool | Both replies come from one table (FR-3), so a developer writes no branch for them. A developer can switch the wait tool off and use `permissions.wait()` in their own (FR-13). |
| Who names a purchase | The caller, with `idempotencyKey` — required, as in the gate's `spend()` | Only the caller knows whether a second call is the same purchase sent again or a new one. |

## Part 1 — Permissions (`/agent`)

**FR-1 — `createPermissions(options)`, once per process.** Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `read` | — (required) | How to read a grant from the store that issued it (FR-2). |
| `memory` | in memory | Where permissions are remembered: a `PermissionMemory` (`read` / `write` / `clear` by `permissionId`, the same shape as the gate's `VerificationStore`). Named `memory` because "store" means the shop here. |
| `approvalHoldMs` | 45 000 | How long one wait holds — under claude.ai's 60 s tool-call limit. Same name and meaning as the storefront's. |
| `approvalWindowMs` | 900 000 (15 min) | How long a run of waits keeps saying "call again" for a permission that stays `pending` (FR-3). |
| `readFailureMs` | 120 000 (2 min) | How long reads may fail, with no success, before a wait says to stop (FR-3). |
| `modelGraceMs` | 20 000 | After a wait last answered "not approved yet", how long the caller counts as still waiting: it bounds a run of waits (FR-3) and keeps the card quiet (FR-12). |

Members: `track({ store: { id, name? }, grantId })` returns a new `permissionId` (random, `perm_…`);
`wait(permissionId)` (FR-3); `buy(permissionId, { idempotencyKey, send })` (FR-4); `forget(permissionId)`.
`cards.permission()` calls `track()` for you; code outside a chat calls it with the ids it saved.

- **What is remembered:** only `{ store, grantId }` and two flags (FR-3, FR-12) under the
  `permissionId` — never one shared key (invariant 4). The approval itself is not kept: it is read from
  the store each time, so it never goes stale. An entry is dropped when the store reports `denied` or
  `revoked`, or on `forget()`; otherwise it lasts as long as the memory does.
- **One running copy:** the default memory lasts for one running copy of the server. After a restart,
  or on another copy, a `permissionId` is `unknown`, and the model is told to ask for a new one (FR-3),
  even though the grant may still be valid at the store. A deploy that restarts, runs several copies,
  or buys later passes a shared `memory`; code that saved `{ store, grantId }` calls `track()` again.
  The gate README and the `createPermissions` doc comment say so.

**FR-2 — Reading a permission.** `read({ store, grantId })` answers `{ status, trustLevel?, approval? }`:

- `status` is the gate's `GrantStatus` (`"pending" | "authorized" | "denied" | "revoked"`).
- `trustLevel` is the store's claim, read each time because it can change once the person approves; the
  permission card's honesty line shows the latest one (FR-10).
- `approval` is what the store hands over once approved; `buy()` passes it to `send` as given, or
  `undefined` when the store handed over nothing.
- A `status` outside `GrantStatus`, a missing answer or a thrown read is a **failed read** — never
  "not approved".

**FR-3 — Waiting: `permissions.wait(permissionId)`.** Reads every 1.5 s, holds up to `approvalHoldMs`,
and returns a `PermissionResult`:

```ts
type PermissionResult =
  | { ok: true; status: "authorized"; trustLevel?: string }
  | { ok: false; status: "pending" | "denied" | "revoked"; trustLevel?: string; stop: boolean }
  | { ok: false; code: "unknown" | "read-failed"; stop: boolean };
```

`stop` says whether waiting again can help. Each outcome has a fixed reply — the text the model's wait
tool returns (FR-13) — and a fixed next step:

| Outcome | When | The model is told | Next |
| --- | --- | --- | --- |
| `authorized` | the store says approved | "Approved. Call {buy} with this permissionId." | done |
| `pending` | still pending when the hold ends | "Not approved yet — call {wait} again now; don't end your turn." | call again |
| `pending`, `stop` | still pending after `approvalWindowMs` of waiting | "Not approved after 15 minutes. Stop waiting, and tell the person they can approve later and ask you to check again." | stop |
| `denied` | the person declined | "The person declined this permission. Don't ask again unless they say so." | stop |
| `revoked` | the permission was withdrawn | "This permission was withdrawn; nothing can be bought with it." | stop |
| `unknown` | this server does not know the `permissionId` | "This server no longer knows this permission (it may have restarted). Ask for a new one." | stop |
| `read-failed` | the last read of this hold failed | "Couldn't check with the store just now — call {wait} again." | call again |
| `read-failed`, `stop` | reads failed, with no success, for `readFailureMs` | "Couldn't reach the store for 2 minutes. Stop waiting, and tell the person." | stop |

- **A failed read does not end the hold.** The kit keeps reading every 1.5 s until the hold ends, so
  "call again" is never a tight loop.
- **A run of waits** is consecutive calls; a wait that starts more than `modelGraceMs` after the
  previous one ended starts a new run. So after the model stops and the person later says "check
  again", the next wait has the full window.
- The minutes in the two "stop" replies follow `approvalWindowMs` and `readFailureMs`.
- A wait or a buy that finds the permission `authorized` marks its approval **seen** (FR-12).

**FR-4 — Buying, once per purchase: `permissions.buy(permissionId, { idempotencyKey, send })`.**
Reads the permission (FR-2). If it is not `authorized`, it returns without calling `send`. If it is,
it marks the approval seen and calls `send({ store, grantId, approval, idempotencyKey })`, which sends
the purchase and returns the store's answer, as any JSON. It returns a `BuyResult`:

```ts
type BuyResult =
  | { ok: true; answer: unknown } // the store answered — paid or refused; `cards.purchase()` reads it
  | { ok: false; code: "pending" | "denied" | "revoked" | "unknown" | "read-failed" } // nothing was sent
  | { ok: false; code: "send-failed"; idempotencyKey: string; message: string }; // `send` threw: it may have reached the store
```

- **The caller names the purchase.** `idempotencyKey` is required: the same key sent twice is one
  purchase, a new key is a new one. The kit passes it to `send` unchanged, every time.
- **The store is the guard against a second order:** it keeps purchases by idempotency key and answers
  a repeated key with the first answer. After `send-failed`, or an answer that cannot be read (FR-14),
  a retry with the same key cannot become a second order — and a new purchase is never blocked by an
  old one, because it has its own key.
- **A deliberate second purchase** inside the budget is a new key, and the store's limits decide it.

## Part 2 — Cards (`/cards`)

**FR-5 — Packaging.** `packages/credentagent-gate/src/cards/` holds the server half (Node, published
as `./cards`) and `src/cards/ui/` the card page (React, browser only). The server half imports neither
React nor the MCP SDK: it registers through a structural port (the `registerResource` / `registerTool`
methods of the server object it is handed — principle 6); a lint rule enforces it. The tool input
schemas are written by hand (Standard Schema with its JSON Schema), so the kit needs no schema
library. `vite.config.cards.ts` builds `dist/cards/cards.html` before `tsc`. One new runtime
dependency: `uqr` (MIT, no dependencies), the QR encoder. Permissions (Part 1) live in
`src/agent/permissions.ts` and import nothing from `cards/`.

**FR-6 — `createCards(options?)`, once per process.** Reads the built page and a 12-character hash of
its content at creation and fails fast, with a fix-it message, if the page is missing (no "dev"
fallback URI). Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `permissions` | — | The `createPermissions()` result. Needed for `permission()`, the card's status tool and the wait tool; without it, `register()` registers only the page, and `permission()` throws a fix-it error. |
| `tools` | `{ wait: "wait-for-approval" }` | `buy`: the developer's purchase tool, named in the kit's notes — **required when `permissions` is given** (fails at startup otherwise). `wait`: the name of the model's wait tool, or `false` to not register it. |

Members: `html`, `register(server)`, `toolMeta({ invoking?, invoked? })`, `offers(input, { note? })`,
`permission(input, { note? })`, `purchase(result, { note? })`, `grant(view, { note? })`.

These throw only for the developer's own mistakes (a missing page, `permissions` without `tools.buy`,
`permission()` without `permissions`), at startup or at the call. **Nothing a store says makes them throw.**

**FR-7 — One page, two resources.** The same HTML is registered as the MCP Apps resource
(`ui://credentagent-cards/cards-<hash>.html`, `text/html;profile=mcp-app`) for Claude and the Apps SDK
resource (`ui://credentagent-cards/cards-<hash>.skybridge.html`, `text/html+skybridge`) for ChatGPT.
The URI carries the content hash, so a host never serves a stale copy. Both declare a CSP that allows
`data:` images (the QR) and no network origins. The page is served exactly as built — no serve-time
string substitution. `toolMeta()` builds every key both hosts need in one place (`ui.resourceUri`,
`ui/resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible: true`, `openai/toolInvocation`).

**FR-8 — Results, and what is written by whom.** Every builder returns a `CallToolResult`:
`structuredContent` is the card's data, marked with a `kind` (`credentagent.grant` — unchanged —,
`credentagent.permission`, `credentagent.offers`, `credentagent.receipt`, `credentagent.notice`);
`content` is one text block, the note for the model followed by the same data as JSON; card-only extras
(the QR) ride in `_meta`, so they cost the model no context. Amounts are in major units of their
currency, like the catalog and the gallery.

- **The kit's sentences are fixed text.** The default notes, the replies (FR-3), the announced sentence
  (FR-12) and every sentence a card shows are written by the kit. Text from a store (names, reasons,
  product names, trust claims) appears only as values in the data, never inside those sentences. A
  `{ note }` the developer passes replaces the default and is the developer's own.
- **The notes name the next tool** (`tools.wait`, `tools.buy`) and **never assume a card is shown**:
  each result's text holds what the person needs without one — for a permission, the link and the
  limits; for a status, the outcome; for offers, the summary; for a purchase, what was charged or why
  not. Many apps show text only.

**FR-9 — The card page.** One React page dispatches on `kind`. It detects its host — MCP Apps
(Claude), `window.openai` (ChatGPT), or a top-level window (preview) — behind one bridge: `call`,
`open`, `tell`. It keeps state outside the DOM and replaces a card only when the result changed
(ChatGPT re-delivers on every `openai:set_globals`); it follows each permission once, however often it
redraws. It takes the host's theme — the MCP Apps style variables and fonts, ChatGPT's
`window.openai.theme`, `prefers-color-scheme` in preview — with light and dark fallbacks. It renders
tool data as text only. An uncaught error shows a sentence, not the host's bare "Runtime error". In a
top-level window, `?view=` renders bundled samples of every card and state (for example `offers`,
`only-one`, `over-limit`, `permission`, `receipt`, `refused`, `unreadable`, `notice`, and the gallery's
grant states), and `&theme=dark` forces dark.

**FR-10 — Trust levels and the honesty line.** The kit knows a fixed list of levels, each with a
sentence the kit wrote. **The level is the store's claim** — the store returns it, and the kit cannot
check it today — so every sentence says so:

| Level | Produced by | The honesty line says |
| --- | --- | --- |
| `presence-only-demo` | a payment credential with no issuer trust anchor yet | "As the store reports it: a demo — the signatures are real, but the payment credential is not checked against its issuer yet. No real money moves." |
| `device-signed` | a grant the person signed with their phone's wallet | "As the store reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet." |
| `server-issued-demo` | a grant approved with a click on a page | "As the store reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves." |
| anything else, or missing | — | "Trust level not recognised by this card; treat it as unverified." |

- A store's own text is never shown as a trust level — not in the honesty line, not in a status
  label. `issuer-verified` from a store's word is "not recognised": the gate never claims it itself,
  and the kit has no verified channel for it yet (issuer-verified trust is #14).
- The permission, receipt and grant cards render inside a frame whose last line is the honesty line;
  there is no public way to render them without it. `trustLevel` is required in the `permission()` and
  receipt types — said out loud, never defaulted — but a store's answer that arrives without it shows
  the "not recognised" sentence instead of throwing.
- **The grant card too:** its line comes from this list, through `GrantViewData.trustLevel`, in place
  of today's fixed "consent is dev-sealed, not wallet-signed" (false for a grant signed on a phone).
  The gallery's honesty test changes to assert the list's sentence, and still fails when the line is
  removed.
- **The status label never says how a permission was approved.** An `authorized` permission shows
  "Approved", whatever its level; how it was approved is only in the honesty line, attributed to the
  store. A store that claims `device-signed` therefore gets the attributed sentence, never an
  unattributed "Signed on your phone".
- When the kit can check a signature itself (for example, an agent verifying the approval it holds),
  it may drop the attribution for the levels it checked. That is a later step, not this spec.

**FR-11 — A store's links and the addresses the server calls.**

- **A store's link is checked, never thrown on.** `approveUrl` (in `permission()` and `grant()`) and
  `receiptUrl` (in a store's answer) are shown only if they are an absolute `https:` URL (`http:` only
  for `localhost`, `127.0.0.1` or `[::1]`, for local development). Anything else — `javascript:`,
  `data:`, a relative path — shows no QR and no button; the card says "The store's link isn't a safe web
  address, so this card doesn't show it," and the note tells the model the same and not to pass the
  link on.
- The card's status tool takes only a `permissionId`, never an address.
- The surface example calls only stores from a list the server knows: the input schemas accept only
  those ids, so the SDK refuses any other before a handler runs, and `read` and `send` get the store
  that `track()` remembered, which came through that schema.

**FR-12 — The permission card and the announcement.** `permission(input)` takes `{ store: { id, name,
url?, merchantId? }, grantId, approveUrl, products, limits: { perSpend, budget, currency }, why?,
trustLevel }`, calls `permissions.track()`, and returns the card with the QR of `approveUrl` in
`_meta`. The card shows the QR, an "Open link" button, the limits, the reason and a live status.

- **The card's status tool** (`credentagent-permission-status`) is read-only, hidden from the model
  (`_meta.ui.visibility: ["app"]`), callable from the card (`openai/widgetAccessible: true`), holds up
  to 25 s, and answers from the same outcomes as FR-3. For `unknown`, the card shows "This server no
  longer knows this permission" — not "Not approved".
- **The announcement.** Once a permission is approved, the card may tell the chat so, **once per
  permission, decided on the server, and only if nobody has seen the approval**: not after a wait or a
  buy found it approved (FR-3, FR-4), and never while the model is still waiting in its own turn (a
  wait is open, or one — or `permission()` — returned less than `modelGraceMs` ago). A redrawn,
  reloaded or duplicated card never announces twice. The sentence is fixed text carrying only the
  `permissionId` and not saying how it was approved: "I approved the permission ({permissionId}).
  Please go ahead."
- This rule removes one cause of a double purchase (the card and the model both going ahead); it is
  not the protection against one — the caller's idempotency key is (FR-4). The "seen" and "announced"
  flags live with the permission in `memory`; whether a wait is open lives in the running copy.
- How long the card waits for the model to notice an approval is its own bound (20 s), not
  `modelGraceMs`. Announcing uses MCP Apps `ui/message`; ChatGPT's follow-up message is a fallback
  only (it did not post in real ChatGPT).

**FR-13 — The model's wait tool.** `register()` registers it when `permissions` is given and
`tools.wait` is not `false`:

- **Name** `tools.wait` (default `wait-for-approval`); **title** "Wait for approval"; **description**
  "Waits up to 45 seconds for the person to approve a spending permission, then says what to do next.
  Call it right after asking for a permission, and again whenever it says to." (the hold in the
  description follows `approvalHoldMs`); **input** `{ permissionId }`; `readOnlyHint: true`; no card.
- It calls `permissions.wait()` and replies with FR-3's text, followed by the result as JSON.
- With `tools.wait: false`, a developer writes their own tool around `permissions.wait()`, which
  returns the same `PermissionResult`.

**FR-14 — The purchase card: `cards.purchase(result)`.** Takes a `BuyResult` (FR-4):

- **`ok: true`** — the store's answer, read as `{ ok: true, order: { id, store, total, currency, items,
  checks }, receiptUrl?, trustLevel }` or `{ ok: false, store?, code?, reason, trustLevel }`. Paid: the
  receipt card (`credentagent.receipt`) — the total, the items, the store's checks, "Open receipt".
  Refused: who, why, "Nothing was charged."
- **An answer it cannot read** — a missing `ok`, a total that is not a number, a currency that is not a
  three-letter code, an error body — is its own receipt state: "The store answered, but this card
  couldn't read the answer. The purchase may have gone through — check with the store before trying
  again," with the "not recognised" honesty sentence. The note tells the model the same, and that a
  retry must reuse the same `idempotencyKey`.
- **Nothing was sent** (`pending`, `denied`, `revoked`, `unknown`, `read-failed`) — a one-line notice
  card (`credentagent.notice`) with FR-3's fixed sentence; the note is the same sentence.
- **`send-failed`** — a notice: "The purchase may not have reached the store. Retry with the same
  idempotencyKey (in the data below) — it will not be charged twice."
- None of these is marked `isError`: each is an answer the model acts on, not a broken tool.

**FR-15 — Offers.** `offers({ stores, product?, maxPrice?, currency? })`, where each store is
`{ store: { id, name }, url, products: [{ id, name, price, currency, rating? }] }` or `{ url, error }`.
`store.id` is the id the model passes to `request-permission`; `currency` is the currency of
`maxPrice`, needed only with it.

- **Matching a product:** an exact match is the product's `id`; otherwise the query matches a name
  only as whole words, case-insensitively ("tea" does not match "Steak"). The summary records which
  kind matched; the note tells the model to act only on an exact match and to confirm a name match
  with the person first. On a first request the model has only words, so that question is intended:
  the person picks the product before a card asks them to approve spending on it.
- **The summary,** in fixed sentences: no store sells it; only one store sells it, so there is
  nothing to compare; n of m sell it within the limit; none is within the limit and the cheapest is x.
  A store that could not be read is never counted as "does not sell it": the sentences say "among the
  stores I could read" and the card says how many could not be read. Over the limit, the note says
  not to request a permission and not to buy.
- **Tags:** "Lowest price" and "Top rated" appear only when two or more stores sell the product in the
  same currency; a price over `maxPrice` is tagged.
- **Currency:** amounts are formatted for their currency. Prices in another currency than `maxPrice`
  are listed but never ranked against it or each other — no "Lowest price", "cheapest" or "within the
  limit" across currencies.

## Security and honesty (summary)

- Display only: no card enforces anything; every status a card shows is read on the server. Waiting
  and buying are permissions (Part 1), which a card never calls except through the read-only status tool.
- One purchase, one order: the caller names each purchase; the store keeps purchases by that key.
- What a store says is data (rule 3): fixed sentences (FR-8), checked links that never throw (FR-11),
  known stores in the example, the agent's own ids (FR-1).
- The honesty line comes from the kit's fixed list (FR-10) and presents the level as the store's claim;
  the store's own trust words are never shown.
- Nothing here changes a ceremony rail, a completion path or a verifier.

## Constraints (for every step)

- All repository content in English; every commit signed off (DCO).
- Verify with the root run: `npm run build && npm test && npm run lint`.
- The cards' server half imports neither React nor the MCP SDK (lint-enforced); the MCP SDK appears
  only in tests. Permissions import nothing from `cards/`.
- Tool data is rendered as text only — never `dangerouslySetInnerHTML`. No serve-time substitution of the page.
- New per-permission state lives inside a factory, keyed by `permissionId` — never module-level (invariant 4).
- Exact values: resource URIs `ui://credentagent-cards/cards-<hash>.html` / `…skybridge.html`; MIME
  `text/html;profile=mcp-app` / `text/html+skybridge`; CSP `data:` images, no network origins; kinds
  `credentagent.grant`, `credentagent.permission`, `credentagent.offers`, `credentagent.receipt`,
  `credentagent.notice`; the card's status tool `credentagent-permission-status`; the model's wait tool
  `wait-for-approval`; the QR's `_meta` key `credentagent/qr`.
- Every pull request opens with a video of the change working (a storyboard for a spec), a short story
  about one person, and the few lines a developer writes. Every step that adds or changes a card shows
  each state in light and dark, and real-host captures when the step claims host behaviour.

## Non-goals

- No consent inside a card: approving happens on the phone; approval on the ceremony page.
- No shared `PermissionMemory` implementation yet (Redis and the like): the interface is here, the
  default is in memory (FR-1).
- No custom cards yet: publishing the React pieces and a custom page is #292.
- Restyling the gallery onto the host's theme variables (it keeps its own tokens for now).
- The storefront keeps its own page for now; moving it onto the kit is #293.

## Increments (stacked pull requests, one at a time)

Each step is reviewed and merged before the next is marked ready, and is brought in line with this
spec first. The steps already open, and what each takes from this spec:

| Step | Pull request | Brings in line |
| --- | --- | --- |
| 1 | #258 — the gallery moves into the gate | (as is) |
| 2 | #294 — this spec | — |
| 3 | #259 — the card page | FR-9 |
| 4 | #272 — `createCards()` serves it | FR-6, FR-7; FR-10 and FR-11 for `grant()` (the list's sentence, the link check) |
| 5 | #273 — becomes `createPermissions()` in `/agent` | FR-1 to FR-3: tracking, memory, the read, the wait and its limits, gate words |
| 6 | #274 — `cards.permission()` and the wait tool | FR-11, FR-12 (status tool), FR-13 |
| 7 | #275 — the permission card | FR-10 (honesty line, label), `perSpend` / `budget`, currency formatting |
| 8 | #276 — the live status | FR-12 (seen, the announcement), FR-10 (label "Approved") |
| 9 | #277 — the offers card | FR-8 (fixed notes), FR-15 (store ids, matching, currency) |
| 10 | #278 — buying and the purchase card | FR-4, FR-14 (split in two if it passes ~500 lines) |
| — | #279 — the AP2 demo on the kit (not for merge) | known stores in the input schemas, `permissions.buy()` with the signing step, `purchaseId`, the store's idempotency key |

## Acceptance

- [ ] Root `npm test` green, including: both resources from one page with the hashed URI and the CSP;
      `toolMeta` carries every key; a missing page fails fast; `permissions` without `tools.buy` fails
      at startup; the built page's script parses and carries the MCP Apps client.
- [ ] **The README examples are run by tests** (like `src/ap2/readme-example.test.ts`): the agent
      server, and the timer that buys with no card page. Plus one test per wait outcome (FR-3's eight rows).
- [ ] Tests that fail when their control is removed:
  - the honesty line on the permission, receipt and grant cards, from the list (the gallery's test updated);
  - a store's name or reason never appears inside a kit sentence (notes, replies, the announcement, card copy);
  - a call to the card's status tool that passes an address is refused;
  - a store's `approveUrl` or `receiptUrl` other than `https:` (or local `http:`) shows no QR or button, and nothing throws;
  - an unknown or missing trust level, including a store's `issuer-verified`, shows the "not recognised" sentence;
  - a store that claims `device-signed` gets the attributed sentence, and no status label says "Signed on your phone";
  - the example's `request-permission` refuses a store id outside its list, before any network call;
  - two stores with the same `grantId` are never mixed up;
  - an unknown `permissionId` never shows as "not approved";
  - a `status` outside `GrantStatus` is a failed read, and a failed read does not end the hold;
  - a permission still pending after `approvalWindowMs` gets the "stop" reply; reads failing for `readFailureMs` get the "stop" reply;
  - `buy()` on a permission that is not `authorized` never calls `send`;
  - the same purchase sent twice (the same `idempotencyKey`) gives one order; `send` always gets the caller's key, unchanged;
  - the model buys first, so the card never announces;
  - `cards.purchase()` never throws for a malformed store answer, and shows the unreadable state;
  - a name match never counts as exact; prices in two currencies are never ranked;
  - the announcement fires once per permission and never while the model waits.
- [ ] `node examples/ap2-multistore/smoke.mjs` green on the demo (#279) once it is on the kit.
- [ ] Every card state checked in a browser, light and dark; each card checked in real Claude and
      real ChatGPT before saying it works.

## Open questions

- Whether ChatGPT shows `credentagent-permission-status` to the model despite `ui.visibility: ["app"]`;
  if it does, add the Apps SDK's own hide-from-model flag.
