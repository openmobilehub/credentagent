# Feature Specification: Grant Widgets — a visual, extensible gallery for conveying grants

**Feature branch:** `011-grant-widgets` · **Issue:** #143 (under #104) · **Date:** 2026-07-28
**Informs:** #12 (human-not-present delegation) · builds on #112/#118 (grants + grant tools), #132 (branding), the storefront MCP App widget

## Overview

A spending grant currently reaches the human as a sentence — *"Set up a spending grant — $200
total, $130 per purchase, Beverages and Electronics only."* This spec replaces prose with a
**visual grant card** rendered inline in the conversation as an MCP App (the same mechanism as
the storefront's shopping widget): a budget bar that depletes as the agent spends, the
per-purchase cap as a marker, the allowed products or categories as tiles/chips, and the
lifecycle status (pending approval → active → revoked/denied/exhausted).

Two product decisions shape everything below:

1. **Views are pluggable, not hard-coded.** A typed `GrantView` contract + a **gallery** of
   stock views; developers pick, compose, or extend — never fork. The leading stock view is the
   **product-specific grant** (a grant scoped to one SKU via `allow.skus`), because "buy me
   *this one thing* while I'm away" is the sharpest consent story.
2. **The card is a display, never a control.** All limits are enforced server-side (security
   invariant 1); the card is a projection of server state, and every view — stock or custom —
   carries the honesty trust line through a frame the public interface cannot omit.

## The surface (caller-first — this IS the DX test)

Inside the MCP App widget (React, `@modelcontextprotocol/ext-apps`):

```tsx
import { GrantCard, grantViews, defineGrantView } from "./grants";   // storefront ui bundle

// 1) Zero-config: picks the most specific fitting stock view automatically —
//    a single-SKU grant renders the ProductGrantCard, category bounds render chips, etc.
<GrantCard grant={grant} />

// 2) Choose explicitly, or reorder preference:
<GrantCard grant={grant} views={[grantViews.budgetMeter]} />          // compact, inline

// 3) Extend — a custom view is the SAME contract the stock gallery uses.
//    Views receive the INERT GrantViewData projection — never the live Grant handle —
//    so a custom view structurally cannot call spend()/revoke() (UX review, A1):
const wineClubRow = defineGrantView({
  id: "wine-club-row",
  fits: (g) => (g.allow?.categories?.includes("Wine") ? 30 : false),   // specificity score,
  body: ({ grant, tokens }) => (                                       // not bare boolean (A3)
    <WineRow remaining={grant.remaining} cap={grant.perSpend} />       // body ONLY — the frame
  ),                                                                   // (chrome + trust line)
});                                                                    // is owned by define…
<GrantCard grant={grantData} views={[wineClubRow, ...grantViews.all]} />
```

The host/agent side needs **no new API**: the existing grant tools' results carry the widget
resource, exactly as the shopping tools do today.

## Functional requirements

**FR-1 — `GrantViewData`: one JSON-safe projection, server-derived.** The widget renders a
plain-data snapshot the server emits (via the grant tools' structured content): `id`,
`merchant`, `status`, `budget`, `spent`, `remaining`, `perSpend`, `allow` (`skus` +
`categories`), `description`, `presence`, `trustLevel`, a server-derived **`lifecycle`**
(`pending | active | low | exhausted | revoked | denied` — so `fits` and the frame never
re-derive "low"/"exhausted" independently; UX A2), and — for SKU-bounded grants — the
**resolved product details** (name, price, category, and image when the catalog carries one).
Money values arrive computed from the server; the widget never re-derives amounts
(invariant 2 discipline applied to display). **Views receive ONLY this projection, never the
live `Grant` handle** — display-only by construction, not by convention (UX A1).

**FR-2 — The gallery (stock views), each selected by a declared `fits(grant)`:**

| View | Fits | Shows |
| --- | --- | --- |
| `productGrantCard` | exactly one `allow.skus` entry | product tile (name/price/image), qty math ("up to 3 at $65"), budget bar, status |
| `categoryGrantCard` | `allow.categories` (± multiple skus) | category chips + sku chips, budget bar, per-purchase marker |
| `openGrantCard` | no `allow` bounds | merchant-wide framing ("anything at Utopia"), budget bar, cap |
| `approvalCard` | `status === "pending"` | the consent moment: full bounds + Approve/Decline deep-links to the ceremony |
| `budgetMeter` | any active grant | compact one-line meter for dense layouts |
| terminal states | `revoked` / `denied` / exhausted | unambiguous closed-state card, no live affordances |

Selection: `fits(data)` returns a **specificity score** (or `false`); the highest-scoring
fitting view wins — explicit, not array-order magic (UX A3). The `views` prop overrides the
candidate set.

**FR-3 — Extensibility contract.** `defineGrantView({ id, fits, body })` is the only way to
add a view; the returned object is what the gallery itself is built from (stock views are not
special). `body` receives `{ grant, tokens, slots }` where `grant` is the `GrantViewData` projection
(FR-1). `tokens` expose the full role set — accent, radius, spacing, AND the **fixed status
colors** (low-budget amber, exhausted/revoked red), which are never host-themed: a brand can
color money-you-have, never money-warnings (UX design §meter). The validated
**`<BudgetMeter/>` primitive is exported** so custom views reuse the accessible meter (cap
bracket, `role="meter"`, severity behavior) instead of rebuilding it (UX A4).

**FR-4 — Honesty frame (load-bearing, bypass-tested).** `defineGrantView` composes every
`body` into the shared **frame**: card chrome + status treatment + the trust line
(`presence` / `trustLevel`, e.g. `🔒 delegated-demo · limits enforced server-side`). The
public interface exposes **no way to render a view without the frame** — mirroring
`trustFooter()`'s non-overridable rule from #132. Bypass test: every gallery view and a custom
view render the exact trust line; the test fails if the frame becomes skippable.

**FR-5 — Display-only + live.** No enforcement in the widget: Approve/Decline/Revoke are
deep-links to the server ceremony or calls to the existing grant tools; the card re-renders
from tool results / a `retrieve` refresh (the checkout widget's poll pattern). A stale card
can never unlock anything — it only ever *shows*.

**FR-6 — Customization without forking.** `slots` are named for their finality:
**`topSlot`** and **`bottomSlot`**, where `bottomSlot` renders *above the always-last trust
line* — the trust line's position is legible in the API, not discovered (UX A5). Density
(`card` | `row`) is a **frame** layout: a card-only view asked to render `row` delegates to
`budgetMeter` (UX A6). In dense multi-grant layouts (≥3), `budgetMeter` is the default and
the full trust sentence de-duplicates to the list container while each row keeps the literal
`delegated-demo` token — repetition must not train the eye to skip the honesty line (UX A7;
the bypass test covers both layouts). The token theme is the only other customization; a
need beyond these is a custom view.

## Non-goals (v1)

- No new build stack or npm package — the gallery ships inside the storefront widget bundle
  (`src/ui/grants/`); extraction into a standalone package is a later, separate decision.
- No approval ceremony inside the widget — consent stays on the server-rendered ceremony page.
- No editing of grant bounds from the card.

## Acceptance

- [ ] A single-SKU grant, a category grant, an unbounded grant, a pending grant, and a revoked
      grant each render their gallery view with zero configuration.
- [ ] A custom `defineGrantView` renders inside the frame, themed by `branding`, without
      touching gallery code.
- [ ] Trust-line bypass test in place and verified red-on-revert.
- [ ] The agent-visible flow works end-to-end in an MCP host: create → approval card →
      approve on ceremony → active card with live remaining → revoke → terminal card.
- [ ] UX design doc (`design.md`) + mockup gallery (`mockups.html`) reviewed and reflected here.

## Open questions (for the UX pass)

- Depleting bar vs. donut for budget; where the per-purchase cap marker reads best.
- How loud the pending/consent state should be relative to the active card.
- Whether `budgetMeter` should be the default in dense multi-grant layouts.
