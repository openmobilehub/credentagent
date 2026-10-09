# Card Kit — Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One card page in the gate package that any MCP server serves to Claude and ChatGPT, starting with the existing grant card gallery — moved, not rewritten.

**Architecture:** Three stacked pull requests, each about 500 lines or less. **1a** moves the grant gallery and its data contract from the storefront into `packages/credentagent-gate/src/cards/`, with no behavior change. **1b** builds the card page: a React page (host bridge, a redraw guard, a preview) that Vite compiles into one self-contained `dist/cards/cards.html`. **1c** adds the server half, `createCards()`: it registers that page as two resources (Claude's MCP App, ChatGPT's skybridge) through a structural port, and builds tool results that render as cards.

**Tech Stack:** TypeScript (NodeNext), React 19, Vite 6 + `@vitejs/plugin-react` + `vite-plugin-singlefile`, `@modelcontextprotocol/ext-apps` 2 (bundled into the page only), vitest 2 (root run), `@modelcontextprotocol/server` + `/client` (tests only).

Spec: `specs/015-card-kit/spec.md`. Issue: #256.

## Global Constraints

- All repository content (code, comments, commit messages, PR text) is in **English**.
- Every commit: `git commit -s` (DCO), and the message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verify with the **root** run: `npm run build && npm test && npm run lint`. A per-workspace run is not a verification.
- The server half (`src/cards/*.ts`) imports **neither React nor the MCP SDK**. The SDK appears only in `*.test.ts`.
- The card page renders tool data **as text only** — no `dangerouslySetInnerHTML`.
- **No serve-time string substitution** of the page. (If one is ever needed: a replacer *function*, never a replacement string.)
- Exact values: resource URIs `ui://credentagent-cards/cards-<hash>.html` and `ui://credentagent-cards/cards-<hash>.skybridge.html`; MIME types `text/html;profile=mcp-app` and `text/html+skybridge`; the hash is the first 12 hex characters of the page's SHA-256; CSP `resourceDomains: ["data:"]`, `connectDomains: []` (MCP Apps) and `resource_domains: ["data:"]`, `connect_domains: []` (skybridge); grant kind `credentagent.grant`.
- Each PR is a **draft**, from a branch pushed to this repo (not a fork), with a body following `.github/pull_request_template.md`. Never push to `main`, never merge.
- About 500 changed lines per PR, one concern per PR. Renames detected by git count as moves, not new lines.

---

## PR 1a — the gallery moves into the gate (branch `feat/256-cards-gallery-move`, base `main`)

The branch already exists under the name `feat/256-cards-core` and holds the spec commit. Rename it first:

```bash
git branch -m feat/256-cards-core feat/256-cards-gallery-move
```

### Task 1: The grant card's data contract moves to the gate, under a new `/cards` subpath

**Files:**
- Move: `packages/credentagent-storefront/src/grant-view.ts` → `packages/credentagent-gate/src/cards/grant-view.ts`
- Create: `packages/credentagent-gate/src/cards/index.ts`
- Modify: `packages/credentagent-gate/package.json` (exports), `packages/credentagent-gate/tsconfig.json` (include)
- Modify: `packages/credentagent-storefront/src/grant-project.ts:11`, `packages/credentagent-storefront/tsconfig.json` (include)

**Interfaces:**
- Produces: `@openmobilehub/credentagent-gate/cards` exporting `GRANT_VIEW_KIND` (value `"credentagent.grant"`) and the types `GrantViewData`, `GrantViewProduct` — unchanged shapes.

- [ ] **Step 1: Move the file**

```bash
mkdir -p packages/credentagent-gate/src/cards
git mv packages/credentagent-storefront/src/grant-view.ts packages/credentagent-gate/src/cards/grant-view.ts
```

- [ ] **Step 2: Point its type import at the gate's own module and update its header**

In `packages/credentagent-gate/src/cards/grant-view.ts`, replace:

```ts
// This module is a LEAF on purpose: it imports only TYPES from the gate, so the browser widget
// bundle that imports `GRANT_VIEW_KIND` + the types never pulls the gate's Node runtime in. The
// projection that BUILDS a GrantViewData (which needs the gate's `grantLifecycle` value + a live
// grant handle + catalog) lives server-side in `grant-project.ts`.

import type { GrantLifecycle, GrantStatus } from "@openmobilehub/credentagent-gate";
```

with:

```ts
// This module is a LEAF on purpose: it imports only TYPES, so the card page that imports
// `GRANT_VIEW_KIND` + the types never pulls the gate's Node runtime in. It moved here from the
// storefront (spec 015) so any MCP server can render a grant, not only createStorefront(). The
// projection that BUILDS a GrantViewData (a live grant handle + the catalog) stays in the
// storefront's `grant-project.ts`.

import type { GrantLifecycle, GrantStatus } from "../grants.js";
```

- [ ] **Step 3: Create the subpath entry**

`packages/credentagent-gate/src/cards/index.ts`:

```ts
// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT. This first slice is the grant card's data contract, moved here from
// the storefront so the kit, the storefront and an agent server all speak the same one.
export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
```

- [ ] **Step 4: Publish the subpath and compile it**

In `packages/credentagent-gate/package.json`, add to `"exports"` after the `"./agent"` entry:

```json
    "./cards": {
      "types": "./dist/cards/index.d.ts",
      "default": "./dist/cards/index.js"
    }
```

In `packages/credentagent-gate/tsconfig.json`, add `"src/cards/index.ts",` to `"include"` right after `"src/agent.ts",`.

- [ ] **Step 5: The storefront imports the contract from the gate**

In `packages/credentagent-storefront/src/grant-project.ts`, replace:

```ts
import { GRANT_VIEW_KIND, type GrantViewData, type GrantViewProduct } from "./grant-view.js";
```

with:

```ts
import { GRANT_VIEW_KIND, type GrantViewData, type GrantViewProduct } from "@openmobilehub/credentagent-gate/cards";
```

In `packages/credentagent-storefront/tsconfig.json`, remove `"src/grant-view.ts", ` from `"include"`.

- [ ] **Step 6: Build and run the storefront's grant tests**

Run: `npm run build && npx vitest run packages/credentagent-storefront/src/grants-tools.test.ts packages/credentagent-storefront/src/grants-mrtr.test.ts`
Expected: build succeeds; both files PASS (they assert the `credentagent.grant` kind in tool results, now coming from the gate).

- [ ] **Step 7: Commit**

```bash
git add packages/credentagent-gate packages/credentagent-storefront
git commit -s -F - <<'EOF'
The grant card's data contract moves to the gate, under a new /cards subpath

GrantViewData and GRANT_VIEW_KIND keep their exact shape; the storefront now imports them from
@openmobilehub/credentagent-gate/cards, where the card kit (spec 015, #256) will live.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 2: The grant gallery moves into the gate's card kit, unchanged

**Files:**
- Move: `packages/credentagent-storefront/src/ui/grants/` (10 files) → `packages/credentagent-gate/src/cards/ui/grants/`
- Modify: `packages/credentagent-gate/src/cards/ui/grants/shared.ts` (one type import)
- Modify: `packages/credentagent-storefront/src/ui/app.tsx:23`
- Modify: `packages/credentagent-gate/package.json` (devDependencies)
- Modify: `packages/credentagent-storefront/README.md` (the gallery's location)

**Interfaces:**
- Consumes: Task 1's `src/cards/grant-view.ts` (the gallery's `index.ts` and `types.ts` already import `"../../grant-view"`, which resolves to it from the new location).
- Produces: `packages/credentagent-gate/src/cards/ui/grants/index.ts` — the same exports as before (`GrantCard`, `GrantList`, `grantViews`, `defineGrantView`, `BudgetMeter`, `GrantActionsContext`, `useGrantActions`, `grantTokens`, `GRANT_VIEW_KIND`, and the types `GrantActions`, `GrantViewData`, …).

- [ ] **Step 1: Move the folder**

```bash
mkdir -p packages/credentagent-gate/src/cards/ui
git mv packages/credentagent-storefront/src/ui/grants packages/credentagent-gate/src/cards/ui/grants
```

- [ ] **Step 2: Fix the one import that named the gate by package**

Run: `grep -rn "@openmobilehub/credentagent-gate" packages/credentagent-gate/src/cards/ui/grants`
Expected: one hit, in `shared.ts`. Replace:

```ts
import type { GrantLifecycle } from "@openmobilehub/credentagent-gate";
```

with:

```ts
import type { GrantLifecycle } from "../../../grants.js";
```

- [ ] **Step 3: The storefront's widget compiles the gallery from its new home**

In `packages/credentagent-storefront/src/ui/app.tsx`, replace:

```ts
import { GrantCard, GRANT_VIEW_KIND, type GrantViewData, type GrantActions } from "./grants";
```

with:

```ts
// The grant gallery lives in the gate's card kit (spec 015); this widget compiles it from source.
import { GrantCard, GRANT_VIEW_KIND, type GrantViewData, type GrantActions } from "../../../credentagent-gate/src/cards/ui/grants";
```

- [ ] **Step 4: Declare what the gallery and its test need**

In `packages/credentagent-gate/package.json`, `"devDependencies"` becomes (same versions as the storefront):

```json
  "devDependencies": {
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@types/supertest": "^7.2.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "supertest": "^7.2.2"
  },
```

Run: `npm install`
Expected: exits 0; `package-lock.json` gains the gate's new dev dependencies (already hoisted at the root, so nothing new downloads).

- [ ] **Step 5: Point the storefront README at the new location**

In `packages/credentagent-storefront/README.md`, replace:

```md
Inside the widget (own-the-code, `src/ui/grants/` — the gallery is **not yet a package
export**: today a custom view means building your own widget from this source; publishing the
components + a supported custom-bundle seam is
[#176](https://github.com/openmobilehub/credentagent/issues/176)):
```

with:

```md
Inside the widget (own-the-code — the gallery's source now lives in the gate's card kit,
`packages/credentagent-gate/src/cards/ui/grants/`, spec 015 /
[#256](https://github.com/openmobilehub/credentagent/issues/256); it is **not yet a package
export**: today a custom view means building your own widget from this source; publishing the
components and a custom-page option is the kit's follow-up in
[#176](https://github.com/openmobilehub/credentagent/issues/176)):
```

- [ ] **Step 6: Verify nothing changed in behavior**

Run: `npm run build && npm test && npm run lint`
Expected: all green. The gallery's 17 tests now run from `packages/credentagent-gate/src/cards/ui/grants/grants.test.tsx`; the total test count equals `main`'s.

Run: `grep -c "SPENDING GRANT" packages/credentagent-storefront/dist/ui/mcp-app.html`
Expected: `1` — the storefront widget still carries the gallery.

Run: `git diff main --stat -M | tail -3`
Expected: the gallery files show as renames; only `shared.ts`, `app.tsx`, the two `package.json`s, the two `tsconfig.json`s, `grant-project.ts`, `grant-view.ts`, the README and `package-lock.json` have line changes.

- [ ] **Step 7: Commit**

```bash
git add -A packages package-lock.json
git commit -s -F - <<'EOF'
The grant card gallery moves into the gate's card kit, unchanged

The components, their styles and their tests move from the storefront's widget source to
packages/credentagent-gate/src/cards/ui/grants/. The storefront's widget compiles them from
there, so what it shows is the same; only the files' home changed (spec 015, #256).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 3: Open draft PR 1a

- [ ] **Step 1: Push and open the draft**

```bash
git push -u origin feat/256-cards-gallery-move
gh pr create --draft --base main --head feat/256-cards-gallery-move \
  --title "Card kit, step 1: the spec, and the grant card gallery moves into the gate (no change in behavior)" \
  --body-file <scratchpad>/pr-1a.md
```

`pr-1a.md` follows the template. **In plain terms:** the grant cards (the visual cards that show a spending grant in the chat) move from the storefront package to the gate package, where the new card kit described in issue #256 will live, so an agent server can show them without depending on the storefront. Nothing a person sees changes. **What you're approving:** a file move plus the kit's spec; worst case, the storefront's widget fails to build — caught by CI. **How to test:** `npm run build && npm test && npm run lint`. **Below the divider:** the spec's three decisions, the moved files, the one import change, and that the storefront's widget compiles the gallery through a relative source import (internal, not a published API — publishing is the follow-up in issue #176).

---

## PR 1b — the card page (branch `feat/256-cards-page`, base `feat/256-cards-gallery-move`)

```bash
git checkout -b feat/256-cards-page
```

### Task 4: The card store — the card lives outside the DOM and changes only when its data changes

**Files:**
- Create: `packages/credentagent-gate/src/cards/ui/card-store.ts`
- Test: `packages/credentagent-gate/src/cards/ui/card-store.test.ts`

**Interfaces:**
- Produces: `readCard(result: HostResult | null | undefined): ShownCard | null`; `createCardStore(): CardStore` with `show(result): boolean`, `current(): ShownCard | null`, `subscribe(listener): () => void`. Types `CardData { kind: string; [key: string]: unknown }`, `ShownCard { data: CardData; meta: Record<string, unknown>; key: string }`, `HostResult { structuredContent?: unknown; _meta?: unknown }`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/card-store.test.ts`:

```ts
// The redraw guard (spec 015 FR-5). ChatGPT re-delivers the tool output on every
// `openai:set_globals`; the AP2 demo's card re-rendered on each one, flickered back to "Waiting",
// and restarted its work. These tests go red if the store stops comparing the data it shows.
import { describe, it, expect, vi } from "vitest";
import { createCardStore, readCard } from "./card-store";

const grant = { kind: "credentagent.grant", id: "g1", remaining: 146 };

describe("readCard", () => {
  it("takes the card's data from structuredContent and its card-only extras from _meta", () => {
    expect(readCard({ structuredContent: grant, _meta: { qr: "data:image/svg+xml;base64,AA" } })).toMatchObject({
      data: grant,
      meta: { qr: "data:image/svg+xml;base64,AA" },
    });
  });

  it("is no card without a kind", () => {
    expect(readCard({ structuredContent: { id: "g1" } })).toBeNull();
    expect(readCard({ structuredContent: "plain text" })).toBeNull();
    expect(readCard(undefined)).toBeNull();
  });
});

describe("createCardStore", () => {
  it("re-delivering the same result changes nothing", () => {
    const store = createCardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.show({ structuredContent: grant })).toBe(true);
    expect(store.show({ structuredContent: { ...grant } })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a changed result replaces the card", () => {
    const store = createCardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show({ structuredContent: grant });
    expect(store.show({ structuredContent: { ...grant, remaining: 100 } })).toBe(true);
    expect(store.current()?.data.remaining).toBe(100);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a result that is not a card leaves the card on screen", () => {
    const store = createCardStore();
    store.show({ structuredContent: grant });
    expect(store.show({ structuredContent: { text: "hello" } })).toBe(false);
    expect(store.current()?.data).toEqual(grant);
  });

  it("an unsubscribed listener hears nothing more", () => {
    const store = createCardStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.show({ structuredContent: grant });
    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/card-store.test.ts`
Expected: FAIL — `Failed to resolve import "./card-store"`.

- [ ] **Step 3: Implement**

`packages/credentagent-gate/src/cards/ui/card-store.ts`:

```ts
// What the card page shows, kept OUTSIDE the DOM (spec 015 FR-5). ChatGPT re-delivers the tool
// output on every `openai:set_globals` event, and a host may re-announce a result; re-rendering on
// each one made the AP2 demo's card flicker and restart its work. The store keeps the card on
// screen and replaces it only when the result's data actually changed.

/** A card's data: any JSON object marked with a `kind`. */
export interface CardData {
  kind: string;
  [key: string]: unknown;
}

/** The card on screen: its data, its card-only extras (`_meta`), and a key that changes with the data. */
export interface ShownCard {
  data: CardData;
  meta: Record<string, unknown>;
  key: string;
}

/** What a host delivers: an MCP Apps tool result, or ChatGPT's toolOutput + toolResponseMetadata. */
export interface HostResult {
  structuredContent?: unknown;
  _meta?: unknown;
}

/** A host's tool result as a card — or null when it is not a card result (no `kind`). */
export function readCard(result: HostResult | null | undefined): ShownCard | null {
  const data = result?.structuredContent;
  if (!data || typeof data !== "object" || typeof (data as { kind?: unknown }).kind !== "string") return null;
  const meta = result?._meta && typeof result._meta === "object" ? (result._meta as Record<string, unknown>) : {};
  return { data: data as CardData, meta, key: JSON.stringify(data) };
}

export interface CardStore {
  /** Show a result. Returns false, changing nothing, when it is no card or the card already shown. */
  show(result: HostResult | null | undefined): boolean;
  current(): ShownCard | null;
  subscribe(listener: () => void): () => void;
}

export function createCardStore(): CardStore {
  let shown: ShownCard | null = null;
  const listeners = new Set<() => void>();
  return {
    show(result) {
      const card = readCard(result);
      if (!card || card.key === shown?.key) return false;
      shown = card;
      for (const listener of listeners) listener();
      return true;
    },
    current: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/card-store.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Prove the guard test is load-bearing**

Temporarily change `if (!card || card.key === shown?.key) return false;` to `if (!card) return false;` and rerun.
Expected: "re-delivering the same result changes nothing" FAILS. Restore the line; rerun; PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credentagent-gate/src/cards/ui/card-store.ts packages/credentagent-gate/src/cards/ui/card-store.test.ts
git commit -s -F - <<'EOF'
The card page keeps its card outside the DOM and redraws only when the data changes

ChatGPT re-delivers a tool's output on every openai:set_globals; the AP2 demo's card redrew on each
one and flickered. The store compares the data before replacing the card (spec 015 FR-5).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 5: The bridge — the card page knows which app shows it

**Files:**
- Create: `packages/credentagent-gate/src/cards/ui/bridge.ts`
- Test: `packages/credentagent-gate/src/cards/ui/bridge.test.ts`

**Interfaces:**
- Produces: `type Host = "mcp" | "chatgpt" | "preview"`; `interface Bridge { host: Host; call(name: string, args: Record<string, unknown>): Promise<unknown>; open(url: string): Promise<void> }`; `detectHost(win: { openai?: unknown; self: unknown; top: unknown }): Host`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/bridge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectHost } from "./bridge";

describe("detectHost", () => {
  it("ChatGPT injects window.openai", () => {
    expect(detectHost({ openai: {}, self: 1, top: 2 })).toBe("chatgpt");
  });

  it("any other frame is an MCP Apps host, such as Claude", () => {
    expect(detectHost({ self: 1, top: 2 })).toBe("mcp");
  });

  it("a top-level browser tab is the preview", () => {
    const win = {};
    expect(detectHost({ self: win, top: win })).toBe("preview");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/bridge.test.ts`
Expected: FAIL — `Failed to resolve import "./bridge"`.

- [ ] **Step 3: Implement**

`packages/credentagent-gate/src/cards/ui/bridge.ts`:

```ts
// The card page's one bridge to whichever app shows it (spec 015 FR-5). Its methods are the card's
// only reach outside itself — open a link, call a server tool — and neither decides anything: the
// server does (security invariant 1).

export type Host = "mcp" | "chatgpt" | "preview";

export interface Bridge {
  host: Host;
  /** Call a server tool from the card; resolves to its structured result (null in the preview). */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Open a link through the host — a sandboxed card cannot open one itself. */
  open(url: string): Promise<void>;
}

/** ChatGPT injects `window.openai`; any other frame is an MCP Apps host (Claude); a top-level tab is the preview. */
export function detectHost(win: { openai?: unknown; self: unknown; top: unknown }): Host {
  if (win.openai) return "chatgpt";
  return win.self !== win.top ? "mcp" : "preview";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/bridge.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credentagent-gate/src/cards/ui/bridge.ts packages/credentagent-gate/src/cards/ui/bridge.test.ts
git commit -s -F - <<'EOF'
The card page knows which app shows it: Claude, ChatGPT, or a preview tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 6: The card page picks a card by kind, with a preview of every grant state

**Files:**
- Create: `packages/credentagent-gate/src/cards/ui/preview.ts`
- Create: `packages/credentagent-gate/src/cards/ui/CardView.tsx`
- Test: `packages/credentagent-gate/src/cards/ui/card-view.test.tsx`

**Interfaces:**
- Consumes: Task 4 `readCard`, `ShownCard`, `CardStore["show"]`; Task 5 `Bridge`; the gallery's `GrantCard`, `GRANT_VIEW_KIND`, `GrantActions`, `GrantViewData` from `./grants`.
- Produces: `previewViews(): string[]`; `previewResult(view: string | null): { structuredContent: object } | null`; `CardView({ card, bridge, show })`; `CardBoundary`; `Trouble({ what, error })`; `PreviewIndex({ views })`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/card-view.test.tsx`:

```tsx
// The card page's dispatch (spec 015 FR-5): a result's `kind` picks the card, an unknown kind shows
// nothing, and every preview sample renders inside the gallery's frame — the trust line included.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "./CardView";
import { readCard } from "./card-store";
import { previewResult, previewViews } from "./preview";
import type { Bridge } from "./bridge";

const bridge: Bridge = { host: "preview", call: async () => null, open: async () => {} };
const render = (result: { structuredContent: unknown } | null): string =>
  renderToStaticMarkup(<CardView card={readCard(result)} bridge={bridge} show={() => false} />);

describe("CardView", () => {
  it("renders a grant result as the gallery's card", () => {
    const html = render(previewResult("grant-product"));
    expect(html).toContain("Oak Reserve Whiskey");
    expect(html).toContain("limits enforced server-side");
  });

  it("shows nothing for a kind it does not know", () => {
    expect(render({ structuredContent: { kind: "someone.else" } })).toBe("");
  });

  it("every preview sample is a card that carries the trust line", () => {
    expect(previewViews().length).toBe(8);
    for (const view of previewViews()) expect(render(previewResult(view)), view).toContain("delegated-demo");
  });

  it("an unknown or missing preview name is no card", () => {
    expect(previewResult("constructor")).toBeNull();
    expect(previewResult(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/card-view.test.tsx`
Expected: FAIL — `Failed to resolve import "./CardView"`.

- [ ] **Step 3: Implement the preview samples**

`packages/credentagent-gate/src/cards/ui/preview.ts`:

```ts
// Sample results for previewing every card without a chat (spec 015 FR-5). Open the built page in a
// browser tab with `?view=<name>` (add `&theme=dark` for dark); with no view it lists them all. Each
// sample is shaped exactly like a tool result, so the preview runs the same code path as a chat.

import { GRANT_VIEW_KIND, type GrantViewData } from "../grant-view";

const grant = (over: Partial<GrantViewData>): GrantViewData => ({
  kind: GRANT_VIEW_KIND,
  id: "grant_preview",
  merchant: "Utopia",
  status: "authorized",
  lifecycle: "active",
  budget: 200,
  spent: 54,
  remaining: 146,
  perSpend: 130,
  allow: { skus: [], categories: [] },
  approveUrl: "https://utopia.example/credentagent/grants/grant_preview",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
  credentials: { ageVerified: null, loyaltyDiscountPct: null },
  ...over,
});

const whiskey = { id: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, currency: "USD", category: "Beverages" };

const SAMPLES: Readonly<Record<string, object>> = {
  "grant-pending": grant({ status: "pending", lifecycle: "pending", spent: 0, remaining: 200, allow: { skus: [whiskey.id], categories: [] }, product: whiskey }),
  "grant-product": grant({ allow: { skus: [whiskey.id], categories: [] }, product: whiskey }),
  "grant-category": grant({ allow: { skus: ["drift-mouse"], categories: ["Beverages", "Electronics"] } }),
  "grant-open": grant({}),
  "grant-low": grant({ lifecycle: "low", spent: 180, remaining: 20 }),
  "grant-spent": grant({ lifecycle: "exhausted", spent: 200, remaining: 0 }),
  "grant-revoked": grant({ status: "revoked", lifecycle: "revoked" }),
  "grant-declined": grant({ status: "denied", lifecycle: "denied", spent: 0, remaining: 200 }),
};

/** The names `?view=` accepts, in display order. */
export const previewViews = (): string[] => Object.keys(SAMPLES);

/** A sample tool result for a view name, or null for an unknown or missing name. */
export function previewResult(view: string | null): { structuredContent: object } | null {
  return view !== null && Object.hasOwn(SAMPLES, view) ? { structuredContent: SAMPLES[view] } : null;
}
```

- [ ] **Step 4: Implement the dispatch**

`packages/credentagent-gate/src/cards/ui/CardView.tsx`:

```tsx
// Picks the card for a tool result by its `kind` (spec 015 FR-5). A card only shows: its buttons
// open a link or call a server tool, and the server decides everything (security invariant 1).

import { Component, type ReactNode } from "react";
import { GrantCard, GRANT_VIEW_KIND, type GrantActions, type GrantViewData } from "./grants";
import type { Bridge } from "./bridge";
import type { CardStore, ShownCard } from "./card-store";

export interface CardViewProps {
  card: ShownCard | null;
  bridge: Bridge;
  show: CardStore["show"];
}

export function CardView({ card, bridge, show }: CardViewProps) {
  if (!card) return null;
  if (card.data.kind === GRANT_VIEW_KIND) {
    return <GrantCard grant={card.data as unknown as GrantViewData} actions={grantActions(bridge, show)} />;
  }
  return null; // a kind this page does not know: show nothing rather than guess
}

/** The gallery's buttons. Approve/Decline open the approval page; Revoke calls the server's
 *  `revoke-grant` tool — the name the storefront's grant tools use — and shows the grant it returns. */
function grantActions(bridge: Bridge, show: CardStore["show"]): GrantActions {
  return {
    openLink: (url) => bridge.open(url),
    revoke: async (grantId) => {
      show({ structuredContent: await bridge.call("revoke-grant", { grantId }) });
    },
  };
}

/** A host turns an uncaught error into a bare "Runtime error"; the card says what went wrong instead. */
export class CardBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    return this.state.error ? <Trouble what="show this card" error={this.state.error} /> : this.props.children;
  }
}

export function Trouble({ what, error }: { what: string; error: unknown }) {
  return (
    <p className="trouble">
      This card couldn&apos;t {what}: {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** The preview's index: every sample view, light and dark. */
export function PreviewIndex({ views }: { views: string[] }) {
  return (
    <nav className="preview" aria-label="Card previews">
      <p>Preview a card:</p>
      <ul>
        {views.map((view) => (
          <li key={view}>
            <a href={`?view=${view}`}>{view}</a> · <a href={`?view=${view}&theme=dark`}>dark</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/card-view.test.tsx`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credentagent-gate/src/cards/ui/preview.ts packages/credentagent-gate/src/cards/ui/CardView.tsx packages/credentagent-gate/src/cards/ui/card-view.test.tsx
git commit -s -F - <<'EOF'
The card page picks a card by its kind, with a preview sample for every grant state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 7: The page builds into one self-contained HTML that reaches Claude and ChatGPT intact

**Files:**
- Create: `packages/credentagent-gate/vite.config.cards.ts`
- Create: `packages/credentagent-gate/src/cards/ui/cards.html`, `main.tsx`, `hosts.ts`, `theme.css`, `vite-env.d.ts`
- Test: `packages/credentagent-gate/src/cards/ui/page-build.test.ts`
- Modify: `packages/credentagent-gate/package.json` (build script, devDependencies)

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces: `packages/credentagent-gate/dist/cards/cards.html` after `npm run build` — PR 1c's `loadCardsPage()` reads it. `connectHost(store: CardStore, win?: Window): Promise<Bridge>`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/page-build.test.ts`:

```ts
// The built card page must reach the chat apps intact (spec 015 FR-3). The AP2 demo learned this the
// hard way: it inlined the MCP Apps client with a replacement STRING, where "$&", "$`" and "$$" are
// patterns, and ChatGPT showed a bare "Runtime error". This test fails if a build step mangles the
// page's script, if the page loads anything from elsewhere, or if the MCP Apps client goes missing.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const page = fileURLToPath(new URL("../../../dist/cards/cards.html", import.meta.url));

describe("the built card page", () => {
  it("exists — run `npm run build` first", () => {
    expect(existsSync(page)).toBe(true);
  });

  it("is one self-contained file: no script or stylesheet loaded from elsewhere", () => {
    const html = readFileSync(page, "utf8");
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/);
  });

  it("its inline script parses as a module and carries the MCP Apps client", () => {
    const html = readFileSync(page, "utf8");
    const scripts = [...html.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "cards-page-"));
    for (const [i, code] of scripts.entries()) {
      const file = join(dir, `script-${i}.mjs`);
      writeFileSync(file, code);
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    }
    expect(scripts.join("\n")).toContain("ui/initialize");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/page-build.test.ts`
Expected: FAIL — "exists" is false (no build yet), the others throw ENOENT.

- [ ] **Step 3: Add the build**

`packages/credentagent-gate/vite.config.cards.ts`:

```ts
// Builds the card page (spec 015 FR-1) into ONE self-contained dist/cards/cards.html — React, the
// MCP Apps client and the styles all inlined — which createCards() serves to Claude and ChatGPT.
// Named *.cards.ts (not vite.config.ts) so no vitest run picks it up as a test config; invoked
// explicitly by `npm run build`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("./src/cards/ui"),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: here("./dist/cards"),
    // Only dist/cards is wiped; tsc writes the server half there right after.
    emptyOutDir: true,
    rollupOptions: { input: here("./src/cards/ui/cards.html") },
  },
});
```

In `packages/credentagent-gate/package.json`, set:

```json
    "build": "vite build --config vite.config.cards.ts && tsc -p tsconfig.json && tsc -p tsconfig.test.json",
```

and `"devDependencies"` becomes:

```json
  "devDependencies": {
    "@modelcontextprotocol/ext-apps": "^2.0.0",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@types/supertest": "^7.2.0",
    "@vitejs/plugin-react": "^4.3.4",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "supertest": "^7.2.2",
    "vite": "^6.0.0",
    "vite-plugin-singlefile": "^2.3.0"
  },
```

Run: `npm install`
Expected: exits 0.

- [ ] **Step 4: Add the page**

`packages/credentagent-gate/src/cards/ui/cards.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>CredentAgent cards</title>
</head>
<body>
  <div id="root" aria-live="polite"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

`packages/credentagent-gate/src/cards/ui/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
```

`packages/credentagent-gate/src/cards/ui/theme.css`:

```css
/* The card page's base (spec 015 FR-5). Light by default; dark from the host's theme (data-theme and
   color-scheme, set by hosts.ts) or the OS. The host's MCP Apps style variables land on :root, and
   every color here falls back to a light/dark pair when a host sends none. */
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  font: 15px/1.5 var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--color-text-primary, light-dark(#1f2328, #e6edf3));
}
.trouble, .preview { margin: 0; padding: 12px; font-size: 14px; color: var(--color-text-secondary, light-dark(#57606a, #9198a1)); }
.preview a { color: var(--color-text-info, light-dark(#0969da, #4493f8)); }
```

`packages/credentagent-gate/src/cards/ui/hosts.ts`:

```ts
// Connects the card page to whichever app shows it (spec 015 FR-5) and returns its Bridge.
//  • Claude and other MCP Apps hosts: the ext-apps client — results arrive as `toolresult`.
//  • ChatGPT: `window.openai` — the result is re-delivered on every `openai:set_globals`, which the
//    card store absorbs (it replaces the card only when the data changed).
//  • A plain browser tab: the preview, from the `?view=` samples.

import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { detectHost, type Bridge } from "./bridge";
import type { CardStore } from "./card-store";
import { previewResult } from "./preview";

/** The part of ChatGPT's `window.openai` the page uses (the surface evolves, so every call is optional). */
interface OpenAiGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  theme?: "light" | "dark";
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (options: { href: string }) => void | Promise<void>;
}
type CardWindow = Window & { openai?: OpenAiGlobals };

export async function connectHost(store: CardStore, win: CardWindow = window): Promise<Bridge> {
  const host = detectHost(win);
  if (host === "chatgpt") return connectChatGpt(store, win, win.openai!);
  if (host === "mcp") return connectMcp(store);
  return connectPreview(store, win);
}

async function connectMcp(store: CardStore): Promise<Bridge> {
  const app = new App({ name: "credentagent-cards", version: "1.0.0" });
  // Listen before connecting, so the result that opened the card is not missed.
  app.addEventListener("toolresult", (result) => {
    store.show(result);
  });
  app.addEventListener("hostcontextchanged", (context) => applyHostContext(context));
  await app.connect();
  applyHostContext(app.getHostContext());
  return {
    host: "mcp",
    call: async (name, args) => (await app.callServerTool({ name, arguments: args })).structuredContent ?? null,
    open: async (url) => {
      await app.openLink({ url });
    },
  };
}

function connectChatGpt(store: CardStore, win: CardWindow, openai: OpenAiGlobals): Bridge {
  const read = (): void => {
    if (openai.theme) setTheme(openai.theme);
    store.show({ structuredContent: openai.toolOutput, _meta: openai.toolResponseMetadata });
  };
  read();
  win.addEventListener("openai:set_globals", read);
  return {
    host: "chatgpt",
    call: async (name, args) => {
      const result = await openai.callTool?.(name, args);
      return result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : (result ?? null);
    },
    open: async (url) => {
      await openai.openExternal?.({ href: url });
    },
  };
}

function connectPreview(store: CardStore, win: CardWindow): Bridge {
  const params = new URLSearchParams(win.location.search);
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") setTheme(theme);
  store.show(previewResult(params.get("view")));
  return {
    host: "preview",
    call: async () => null,
    open: async (url) => {
      win.open(url, "_blank", "noopener");
    },
  };
}

/** Force light or dark: `data-theme` for CSS selectors, `color-scheme` for the gallery's light-dark() colors. */
function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** The host's theme, style variables and fonts (MCP Apps); the page's own fallbacks cover the rest. */
function applyHostContext(context: Partial<McpUiHostContext> | undefined): void {
  if (!context) return;
  if (context.theme) {
    applyDocumentTheme(context.theme);
    setTheme(context.theme);
  }
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
```

`packages/credentagent-gate/src/cards/ui/main.tsx`:

```tsx
// The card page (spec 015): connects to whichever app shows it, then renders the card for the latest
// tool result. vite.config.cards.ts builds it into ONE self-contained dist/cards/cards.html.

import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createCardStore } from "./card-store";
import { connectHost } from "./hosts";
import { previewViews } from "./preview";
import type { Bridge } from "./bridge";
import { CardBoundary, CardView, PreviewIndex, Trouble } from "./CardView";
import "./theme.css";

const store = createCardStore();
const root = createRoot(document.getElementById("root")!);

function Cards({ bridge }: { bridge: Bridge }) {
  const card = useSyncExternalStore(store.subscribe, store.current);
  if (!card && bridge.host === "preview") return <PreviewIndex views={previewViews()} />;
  // Keyed by the card, so a card that failed to render never hides the next one.
  return (
    <CardBoundary key={card?.key ?? "none"}>
      <CardView card={card} bridge={bridge} show={store.show} />
    </CardBoundary>
  );
}

connectHost(store).then(
  (bridge) =>
    root.render(
      <StrictMode>
        <Cards bridge={bridge} />
      </StrictMode>,
    ),
  (error: unknown) => root.render(<Trouble what="connect to the chat" error={error} />),
);
```

- [ ] **Step 5: Build, then run the page test**

Run: `npm run build --workspace packages/credentagent-gate && ls -la packages/credentagent-gate/dist/cards/`
Expected: `cards.html` exists next to `index.js` and `grant-view.js`.

Run: `npx vitest run packages/credentagent-gate/src/cards/ui/page-build.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 6: Prove the parse check is load-bearing**

Run:

```bash
cp packages/credentagent-gate/dist/cards/cards.html packages/credentagent-gate/dist/cards/cards.html.bak && \
node -e 'const f=process.argv[1],fs=require("fs");const h=fs.readFileSync(f,"utf8");fs.writeFileSync(f,h.replace("ui/initialize", () => "ui/initialize\"$&"))' packages/credentagent-gate/dist/cards/cards.html && \
npx vitest run packages/credentagent-gate/src/cards/ui/page-build.test.ts; mv packages/credentagent-gate/dist/cards/cards.html.bak packages/credentagent-gate/dist/cards/cards.html
```

Expected: "its inline script parses as a module…" FAILS (the stray quote breaks the script, as a `$&` corruption would). After the restore, rerun: PASS.

- [ ] **Step 7: Full root verification**

Run: `npm run build && npm test && npm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/credentagent-gate package-lock.json
git commit -s -F - <<'EOF'
The card page builds into one self-contained HTML that reaches Claude and ChatGPT intact

Vite compiles the React page, the MCP Apps client and the styles into dist/cards/cards.html. A test
parses its inline script, so a build step that corrupts it — the AP2 demo's "$&" bug, which ChatGPT
showed as a bare "Runtime error" — goes red here first (spec 015 FR-3, FR-5).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 8: Check every preview in a browser, light and dark; open draft PR 1b

- [ ] **Step 1: Serve the built page**

Add a local, **uncommitted** entry to `.claude/launch.json` (create the file if absent):

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "cards-preview",
      "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "4310", "--directory", "packages/credentagent-gate/dist/cards"],
      "port": 4310
    }
  ]
}
```

Start it with the browser pane's `preview_start` (name `cards-preview`), open `http://localhost:4310/cards.html`.
Expected: the index lists 8 views, each with a "dark" link.

- [ ] **Step 2: Look at each view, light and dark**

Open each `?view=grant-…` and `?view=grant-…&theme=dark`. For each, confirm: the gallery card renders as it does in the storefront (title, status pill, meter or terminal line), the trust line `🔒 delegated-demo · limits enforced server-side · …` is last, nothing overflows at 375 px wide (`resize_window` preset `mobile`), and the console has no errors (`read_console_messages`). Reset the viewport to `desktop` afterwards.

- [ ] **Step 3: Push and open the draft**

```bash
git push -u origin feat/256-cards-page
gh pr create --draft --base feat/256-cards-gallery-move --head feat/256-cards-page \
  --title "Card kit, step 2: the card page — one HTML for Claude, ChatGPT and a browser preview" \
  --body-file <scratchpad>/pr-1b.md
```

`pr-1b.md`: **In plain terms:** the gate gets a card page — the small web page Claude and ChatGPT show inside the chat — built into one file, with a preview anyone can open in a browser to see every card without a chat. It shows grant cards today; the permission, offers and receipt cards come next (issue #256). **What you're approving:** a new page built with the package, nothing served yet (step 3 does that); worst case, the build fails — CI. **How to test:** `npm run build`, then open `packages/credentagent-gate/dist/cards/cards.html` through any static server and try `?view=grant-product&theme=dark`. **Below the divider:** the redraw guard and why (ChatGPT's `openai:set_globals`), the build-integrity test and the demo bug it encodes, host detection, theme handling, and the bypass checks run (Task 4 Step 5, Task 7 Step 6).

---

## PR 1c — any MCP server serves the card page (branch `feat/256-cards-serve`, base `feat/256-cards-page`)

```bash
git checkout -b feat/256-cards-serve
```

### Task 9: Read the built page once, hash it, and fail fast when it is missing

**Files:**
- Create: `packages/credentagent-gate/src/cards/page.ts`
- Test: `packages/credentagent-gate/src/cards/page.test.ts`
- Modify: `packages/credentagent-gate/tsconfig.test.json` (include)

**Interfaces:**
- Produces: `interface CardsPage { html: string; hash: string }`; `loadCardsPage(candidates?: string[]): CardsPage` — `hash` is 12 lowercase hex characters.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/page.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCardsPage } from "./page.js";

const dir = mkdtempSync(join(tmpdir(), "cards-page-"));
const file = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

describe("loadCardsPage", () => {
  it("reads the first page it finds and hashes its content", () => {
    const page = loadCardsPage([join(dir, "missing.html"), file("a.html", "<p>a</p>")]);
    expect(page.html).toBe("<p>a</p>");
    expect(page.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a changed page gets a new hash, so a host never serves a stale cached copy", () => {
    const one = loadCardsPage([file("one.html", "<p>one</p>")]).hash;
    const two = loadCardsPage([file("two.html", "<p>two</p>")]).hash;
    const again = loadCardsPage([file("one-again.html", "<p>one</p>")]).hash;
    expect(one).not.toBe(two);
    expect(again).toBe(one);
  });

  it("fails fast, saying how to fix it, when the page was never built", () => {
    expect(() => loadCardsPage([join(dir, "nope.html")])).toThrow(/cards\.html was not found[\s\S]*npm run build/);
  });

  it("finds the built page by default", () => {
    expect(loadCardsPage().html).toContain("ui/initialize");
  });
});
```

In `packages/credentagent-gate/tsconfig.test.json`, `"include"` becomes `["src/types.test-d.ts", "src/ap2/**/*.test.ts", "src/cards/*.test.ts"]` (the server half's tests only; the page's tests are not NodeNext modules).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/page.test.ts`
Expected: FAIL — cannot resolve `./page.js`.

- [ ] **Step 3: Implement**

`packages/credentagent-gate/src/cards/page.ts`:

```ts
// The built card page (spec 015 FR-2): read once, hashed, and FAIL FAST when missing — never a
// "dev" fallback URI, which would poison connected hosts' caches (the storefront's #55 lesson).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CardsPage {
  html: string;
  /** First 12 hex characters of the page's SHA-256 — the resource URIs carry it. */
  hash: string;
}

/** Next to the compiled module (dist/cards/), or — when this module runs from source under the
 *  test runner — in the package's dist/cards/. */
function pageCandidates(): string[] {
  return [join(import.meta.dirname, "cards.html"), join(import.meta.dirname, "..", "..", "dist", "cards", "cards.html")];
}

export function loadCardsPage(candidates: string[] = pageCandidates()): CardsPage {
  for (const path of candidates) {
    let html: string;
    try {
      html = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    return { html, hash: createHash("sha256").update(html).digest("hex").slice(0, 12) };
  }
  throw new Error(
    "credentagent-gate/cards: the card page cards.html was not found — the package was built without it " +
      "(run `npm run build` in packages/credentagent-gate) or a serverless deploy's includeFiles is missing it. " +
      `Looked in: ${[...new Set(candidates)].join(", ")}.`,
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/page.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credentagent-gate/src/cards/page.ts packages/credentagent-gate/src/cards/page.test.ts packages/credentagent-gate/tsconfig.test.json
git commit -s -F - <<'EOF'
The card kit reads its page once, hashes it, and fails fast when it was never built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 10: One page, two resources, and the tool `_meta` that links a result to them

**Files:**
- Create: `packages/credentagent-gate/src/cards/meta.ts`
- Test: `packages/credentagent-gate/src/cards/meta.test.ts`
- Modify: `packages/credentagent-gate/package.json` (devDependencies: the MCP SDK, tests only)

**Interfaces:**
- Produces: `MCP_APP_MIME`, `SKYBRIDGE_MIME`; `interface CardUris { resourceUri: string; skybridgeUri: string }`; `cardUris(hash: string): CardUris`; `interface CardToolMeta` (keys `ui`, `ui/resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible`, `openai/toolInvocation`); `cardToolMeta(uris: CardUris, status?: { invoking?: string; invoked?: string }): CardToolMeta`; `interface CardsServer { registerResource(name, uri, metadata: { mimeType: string }, read: () => Promise<ResourceRead>): unknown }`; `registerCardResources(server: CardsServer, html: string, uris: CardUris): void`.

- [ ] **Step 1: Add the SDK for tests**

In `packages/credentagent-gate/package.json` `"devDependencies"`, add (alphabetical order):

```json
    "@modelcontextprotocol/client": "^2.1.0",
    "@modelcontextprotocol/server": "^2.1.0",
```

Run: `npm install`
Expected: exits 0.

- [ ] **Step 2: Write the failing test**

`packages/credentagent-gate/src/cards/meta.test.ts`:

```ts
// The card page reaches both chat apps (spec 015 FR-2, FR-3), proven against the REAL MCP SDK: the
// kit registers through a structural port, so this test is what shows McpServer fits it.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { cardToolMeta, cardUris, registerCardResources } from "./meta.js";

const uris = cardUris("0123456789ab");
// The page is served exactly as built: replacement-string patterns must survive untouched.
const html = "<!doctype html><p>$& $` $$ survive</p>";

async function connect(build: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "cards-test", version: "1.0.0" });
  build(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cards-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("the card page's two resources", () => {
  it("are one page, for Claude (MCP Apps) and ChatGPT (skybridge), under URIs that carry its hash", async () => {
    const client = await connect((server) => registerCardResources(server, html, uris));
    const listed = (await client.listResources()).resources.map((r) => ({ uri: r.uri, mimeType: r.mimeType }));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { uri: "ui://credentagent-cards/cards-0123456789ab.html", mimeType: "text/html;profile=mcp-app" },
        { uri: "ui://credentagent-cards/cards-0123456789ab.skybridge.html", mimeType: "text/html+skybridge" },
      ]),
    );
  });

  it("serve the page exactly as built, with a CSP that allows data: images and no network", async () => {
    const client = await connect((server) => registerCardResources(server, html, uris));
    const [claude] = (await client.readResource({ uri: uris.resourceUri })).contents;
    const [chatgpt] = (await client.readResource({ uri: uris.skybridgeUri })).contents;
    expect(claude).toMatchObject({ text: html, _meta: { ui: { csp: { resourceDomains: ["data:"], connectDomains: [] } } } });
    expect(chatgpt).toMatchObject({ text: html, _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } } });
  });
});

describe("cardToolMeta", () => {
  it("links a tool's result to the page on both hosts, with every key a card's buttons need in ChatGPT", async () => {
    const client = await connect((server) => {
      registerCardResources(server, html, uris);
      server.registerTool(
        "compare",
        { description: "shows a card", _meta: cardToolMeta(uris, { invoking: "Reading the stores…" }) },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });
    const [tool] = (await client.listTools()).tools;
    expect(tool._meta).toEqual({
      ui: { resourceUri: uris.resourceUri },
      "ui/resourceUri": uris.resourceUri,
      "openai/outputTemplate": uris.skybridgeUri,
      "openai/widgetAccessible": true,
      "openai/toolInvocation": { invoking: "Reading the stores…", invoked: "Done" },
    });
  });

  it("defaults the status lines", () => {
    expect(cardToolMeta(uris)["openai/toolInvocation"]).toEqual({ invoking: "Working…", invoked: "Done" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/meta.test.ts`
Expected: FAIL — cannot resolve `./meta.js`.

- [ ] **Step 4: Implement**

`packages/credentagent-gate/src/cards/meta.ts`:

```ts
// How the card page is offered to the two chat apps (spec 015 FR-2, FR-3): one page, two resources,
// and the tool `_meta` that links a tool's result to them. Plain data and a structural port — the kit
// imports no MCP SDK (principle 6); `McpServer` from @modelcontextprotocol/server fits the port.

/** MCP Apps (Claude) — the same value as `RESOURCE_MIME_TYPE` in @modelcontextprotocol/ext-apps. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The Apps SDK (ChatGPT) "skybridge" template. */
export const SKYBRIDGE_MIME = "text/html+skybridge";

export interface CardUris {
  resourceUri: string;
  skybridgeUri: string;
}

/** Hosts cache a resource by URI, so the URI carries the page's hash: a changed page is a new URI. */
export function cardUris(hash: string): CardUris {
  return {
    resourceUri: `ui://credentagent-cards/cards-${hash}.html`,
    skybridgeUri: `ui://credentagent-cards/cards-${hash}.skybridge.html`,
  };
}

export interface CardToolMeta {
  [key: string]: unknown;
  /** MCP Apps (Claude): the resource that renders this tool's result. */
  ui: { resourceUri: string };
  /** The same, under the key older MCP Apps hosts read (what ext-apps' `registerAppTool` adds). */
  "ui/resourceUri": string;
  /** ChatGPT: the skybridge template. */
  "openai/outputTemplate": string;
  /** ChatGPT: lets the card call tools — without it, a card's buttons are silently dead. */
  "openai/widgetAccessible": true;
  /** ChatGPT: the status lines shown while the tool runs. */
  "openai/toolInvocation": { invoking: string; invoked: string };
}

/** One builder for every key, so none can be forgotten (the storefront's `appToolMeta` rule). */
export function cardToolMeta(uris: CardUris, status: { invoking?: string; invoked?: string } = {}): CardToolMeta {
  return {
    ui: { resourceUri: uris.resourceUri },
    "ui/resourceUri": uris.resourceUri,
    "openai/outputTemplate": uris.skybridgeUri,
    "openai/widgetAccessible": true,
    "openai/toolInvocation": { invoking: status.invoking ?? "Working…", invoked: status.invoked ?? "Done" },
  };
}

interface ResourceRead {
  [key: string]: unknown;
  contents: Array<{ uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }>;
}

/** The slice of an MCP server the kit registers through. */
export interface CardsServer {
  registerResource(name: string, uri: string, metadata: { mimeType: string }, read: () => Promise<ResourceRead>): unknown;
}

/** Register the page twice — MCP Apps and skybridge — served exactly as built, never rewritten. The
 *  CSP allows `data:` images (the permission card's QR code) and no network origins. */
export function registerCardResources(server: CardsServer, html: string, uris: CardUris): void {
  server.registerResource(uris.resourceUri, uris.resourceUri, { mimeType: MCP_APP_MIME }, async () => ({
    contents: [
      { uri: uris.resourceUri, mimeType: MCP_APP_MIME, text: html, _meta: { ui: { csp: { resourceDomains: ["data:"], connectDomains: [] } } } },
    ],
  }));
  server.registerResource("credentagent-cards-skybridge", uris.skybridgeUri, { mimeType: SKYBRIDGE_MIME }, async () => ({
    contents: [
      { uri: uris.skybridgeUri, mimeType: SKYBRIDGE_MIME, text: html, _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } } },
    ],
  }));
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/meta.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credentagent-gate/src/cards/meta.ts packages/credentagent-gate/src/cards/meta.test.ts packages/credentagent-gate/package.json package-lock.json
git commit -s -F - <<'EOF'
The card page is offered to Claude and ChatGPT as two resources, linked from a tool by one _meta

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 11: `createCards()` — configure once, register per server, return cards as tool results

**Files:**
- Create: `packages/credentagent-gate/src/cards/results.ts`
- Modify: `packages/credentagent-gate/src/cards/index.ts`
- Test: `packages/credentagent-gate/src/cards/cards.test.ts`

**Interfaces:**
- Consumes: Task 9 `loadCardsPage`; Task 10 `cardUris`, `cardToolMeta`, `registerCardResources`, `CardsServer`, `CardToolMeta`; Task 1 `GrantViewData`.
- Produces: `createCards(): Cards` with `html: string`, `register(server: CardsServer): void`, `toolMeta(status?): CardToolMeta`, `grant(view: GrantViewData, options?: { note?: string }): CardResult`; `interface CardResult { [key: string]: unknown; content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; _meta?: Record<string, unknown> }`; `cardResult(data, note, extras?)` (internal, used by the next increments' builders).

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/cards.test.ts`:

```ts
// The card kit end to end (spec 015 — the surface): configure once, register on a real MCP server,
// link a tool to the page, and return a grant as a card result.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCards, GRANT_VIEW_KIND, type GrantViewData } from "./index.js";

const grant: GrantViewData = {
  kind: GRANT_VIEW_KIND,
  id: "grant_test",
  merchant: "Utopia",
  status: "authorized",
  lifecycle: "active",
  budget: 200,
  spent: 54,
  remaining: 146,
  perSpend: 130,
  allow: { skus: [], categories: [] },
  approveUrl: "https://utopia.example/credentagent/grants/grant_test",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
  credentials: { ageVerified: null, loyaltyDiscountPct: null },
};

async function connect(build: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "cards-test", version: "1.0.0" });
  build(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cards-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("createCards", () => {
  it("serves the built page and links a tool to it; the tool's result is the grant card's data", async () => {
    const cards = createCards();
    const client = await connect((server) => {
      cards.register(server);
      server.registerTool("get-grant", { description: "the grant", _meta: cards.toolMeta() }, async () => cards.grant(grant));
    });
    const page = (await client.listResources()).resources.find((r) => r.mimeType === "text/html;profile=mcp-app")!;
    const [tool] = (await client.listTools()).tools;
    expect(tool._meta?.ui).toEqual({ resourceUri: page.uri });
    expect((await client.readResource({ uri: page.uri })).contents[0]).toMatchObject({ text: cards.html });
    expect((await client.callTool({ name: "get-grant", arguments: {} })).structuredContent).toEqual(grant);
  });

  it("a stateless server registers the same page on every per-request server", async () => {
    const cards = createCards();
    const first = await connect((server) => cards.register(server));
    const second = await connect((server) => cards.register(server));
    expect((await first.listResources()).resources).toEqual((await second.listResources()).resources);
  });
});

describe("cards.grant", () => {
  it("tells the model what to do next, then gives it the same data the card shows", () => {
    const [block] = createCards().grant(grant).content;
    expect(block.text.startsWith("The person sees this grant in a card.")).toBe(true);
    expect(block.text).toContain(JSON.stringify(grant, null, 2));
  });

  it("a note replaces the default", () => {
    const [block] = createCards().grant(grant, { note: "AUTHORIZED — you can spend now." }).content;
    expect(block.text.startsWith("AUTHORIZED — you can spend now.\n\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/cards.test.ts`
Expected: FAIL — `createCards` is not exported from `./index.js`.

- [ ] **Step 3: Implement the result builder**

`packages/credentagent-gate/src/cards/results.ts`:

```ts
// Tool results that render as a card (spec 015 FR-4): the card's data as `structuredContent`, marked
// with a `kind`; one text block for the model — a note on what to do next, then the same data as
// JSON; and card-only extras in `_meta`, which reach the card without costing the model context.

export interface CardResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export function cardResult(data: { kind: string }, note: string, extras?: Record<string, unknown>): CardResult {
  return {
    content: [{ type: "text", text: `${note}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: { ...data },
    ...(extras ? { _meta: extras } : {}),
  };
}
```

- [ ] **Step 4: Implement `createCards`**

Replace `packages/credentagent-gate/src/cards/index.ts` with:

```ts
// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT, and the tool results that render as cards on it.
//
//   const cards = createCards();                                    // once per process
//   cards.register(server);                                          // per server instance
//   server.registerTool("get-grant", { inputSchema, _meta: cards.toolMeta() }, async () => cards.grant(view));
//
// A card only shows; it never decides — every limit is enforced on the server (security invariant 1).

import { loadCardsPage } from "./page.js";
import { cardToolMeta, cardUris, registerCardResources, type CardsServer, type CardToolMeta } from "./meta.js";
import { cardResult, type CardResult } from "./results.js";
import type { GrantViewData } from "./grant-view.js";

export interface Cards {
  /** The card page itself — serve it on a route to preview every card without a chat (`?view=`). */
  readonly html: string;
  /** Register the card page on an MCP server, once per server instance (a stateless server builds one per request). */
  register(server: CardsServer): void;
  /** The tool `_meta` that makes a tool's result render as a card, in Claude and ChatGPT alike. */
  toolMeta(status?: { invoking?: string; invoked?: string }): CardToolMeta;
  /** A tool result that shows a grant; the gallery picks the view that fits it. */
  grant(view: GrantViewData, options?: { note?: string }): CardResult;
}

const GRANT_NOTE = "The person sees this grant in a card. Don't repeat its numbers; say in a sentence what changed.";

/** Configure once per process. Reads the built page now, so a missing build fails at startup, not mid-chat. */
export function createCards(): Cards {
  const page = loadCardsPage();
  const uris = cardUris(page.hash);
  return {
    html: page.html,
    register: (server) => registerCardResources(server, page.html, uris),
    toolMeta: (status) => cardToolMeta(uris, status),
    grant: (view, options) => cardResult(view, options?.note ?? GRANT_NOTE),
  };
}

export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
export type { CardsServer, CardToolMeta } from "./meta.js";
export type { CardResult } from "./results.js";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/`
Expected: all cards tests PASS (server half and page).

- [ ] **Step 6: Typecheck the server half against the real SDK**

Run: `npm run build --workspace packages/credentagent-gate`
Expected: exits 0 — `tsc -p tsconfig.test.json` compiles `src/cards/*.test.ts`, proving `McpServer` fits `CardsServer` and `CardResult` is a valid tool result.

- [ ] **Step 7: Commit**

```bash
git add packages/credentagent-gate/src/cards
git commit -s -F - <<'EOF'
Any MCP server serves the card page with createCards(): register once, link a tool, return a card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 12: Docs, real-host check, draft PR 1c

**Files:**
- Modify: `packages/credentagent-gate/README.md` (new section before `## Bring your own host — mount on YOUR MCP server`)
- Modify: `CLAUDE.md` (Architecture: one bullet under `packages/credentagent-gate/src/`)

- [ ] **Step 1: README section**

Insert before `## Bring your own host — mount on YOUR MCP server`:

````md
## Cards — show the moment in the chat (`/cards`)

Claude and ChatGPT can show a small interactive card inside the conversation instead of a wall of
text. `@openmobilehub/credentagent-gate/cards` is one card page that **any** MCP server serves — a
storefront or an agent — with no widget code of its own:

```js
import { createCards } from "@openmobilehub/credentagent-gate/cards";

const cards = createCards(); // once per process — fails at startup if the package was built without its page

function buildServer() {
  const server = new McpServer({ name: "my-server", version: "1.0.0" });
  cards.register(server); // the page for Claude (MCP Apps) and ChatGPT (skybridge), with its CSP
  server.registerTool("get-grant", { inputSchema, _meta: cards.toolMeta() }, async ({ grantId }) =>
    cards.grant(await viewOf(grantId)), // renders as the grant card; the model gets a short note + the data
  );
  return server;
}

app.get("/cards", (_req, res) => res.type("html").send(cards.html)); // preview: /cards?view=grant-product
```

A card only shows; it never decides — every limit is enforced on the server. Today the page renders
grants (the gallery: product, category, open, approval, low, spent, revoked, declined). The
permission card with a QR code, the offers card and the receipt card are next
([#256](https://github.com/openmobilehub/credentagent/issues/256)).
````

- [ ] **Step 2: CLAUDE.md bullet**

In `CLAUDE.md`, under `- packages/credentagent-gate/src/`, after the `store.ts` bullet, add:

```md
  - `cards/` — the card kit (`./cards`, spec 015): `createCards()` serves one card page to Claude and
    ChatGPT from any MCP server. `ui/` is the page (React, built to `dist/cards/cards.html`),
    `ui/grants/` the grant gallery. A card only shows; the server enforces.
```

- [ ] **Step 3: Full root verification**

Run: `npm run build && npm test && npm run lint`
Expected: all green.

- [ ] **Step 4: Check it in real Claude and real ChatGPT**

Write an **uncommitted** `examples/cards-try.local.mjs`: an Express + `McpServer` server (copy the transport block of `examples/ap2-multistore/agent.mjs` on the demo branch) with `const cards = createCards()`, `cards.register(server)`, one tool `show-grant` (`_meta: cards.toolMeta()`) that returns `cards.grant(sample)` for an active single-product grant, and `app.get("/cards", …)`. Run it on port 4400, tunnel it (`cloudflared tunnel --url http://localhost:4400`), and **ask the user** to add `<tunnel>/mcp` as a connector in Claude and in ChatGPT (adding a connector changes their account settings — they do it, or explicitly allow it). In each app, ask the model to call `show-grant`.
Expected: the grant card renders in both, in the app's light and dark theme, with no "Runtime error"; in ChatGPT it does not flicker. Delete `examples/cards-try.local.mjs` afterwards.

- [ ] **Step 5: Commit, push, open the draft**

```bash
git add packages/credentagent-gate/README.md CLAUDE.md
git commit -s -F - <<'EOF'
Docs: the card kit — serve cards from any MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git push -u origin feat/256-cards-serve
gh pr create --draft --base feat/256-cards-page --head feat/256-cards-serve \
  --title "Card kit, step 3: any MCP server serves the card page with createCards()" \
  --body-file <scratchpad>/pr-1c.md
```

`pr-1c.md`: **In plain terms:** any MCP server — an online store or an AI agent's own server — can now show CredentAgent's cards in Claude and ChatGPT by adding three lines; today they show spending grants, next the permission to sign with a QR code, offers and receipts (issue #256). **What you're approving:** a new public subpath, `@openmobilehub/credentagent-gate/cards`, with `createCards()`; nothing existing changes; worst case, a card does not render — the server still enforces every limit. **How to test:** root `npm run build && npm test`; the README snippet; the real-host check above. **Below the divider:** the structural port (no SDK import) and the test that proves `McpServer` fits it, the two resources and their CSP, the content-hashed URIs, fail-fast loading, the legacy `ui/resourceUri` key, and the release note: the storefront's dependency range on the gate must move to the version that ships `/cards`.

---

## Self-review (done)

- **Spec coverage (increment 1 = FR-1 to FR-5 + `grant()`):** FR-1 packaging → Tasks 1, 2, 7, 11; FR-2 `createCards`, fail fast, `register`, `toolMeta`, `grant`, `html` → Tasks 9–11 (the options `readPermission` / `holdMs` / `modelGraceMs` and `permission` / `offers` / `receipt` / `waitForSignature` belong to increments 2–3); FR-3 two resources, hash, CSP, no substitution → Tasks 7, 9, 10; FR-4 results → Task 11; FR-5 page, bridge, redraw guard, theme, text-only, error sentence, preview → Tasks 4–8 (the bridge's `tell` arrives with increment 2, the only card that announces). Gallery moved unchanged → Tasks 1–2.
- **Placeholders:** none; `<scratchpad>` is the session's scratchpad directory.
- **Type consistency:** `ShownCard.key` (Task 4) is used in `main.tsx` (Task 7); `CardStore["show"]` (Task 4) in `CardView` (Task 6); `Bridge` (Task 5) in Tasks 6–7; `CardsServer` / `CardToolMeta` (Task 10) and `CardResult` (Task 11) re-exported from `index.ts`.
