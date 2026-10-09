# Card Kit — Increments 2 and 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AP2 demo's three cards — the permission to sign with a QR code and live status, the offers, the receipt — become cards of the SDK's card kit (`@openmobilehub/credentagent-gate/cards`), with the demo's look and wording.

**Architecture:** Six stacked pull requests on top of increment 1 (#258 → #259 → #272). The server half gains a shared data contract (`contract.ts`), the permission watch that owns both waits on a signature and decides when the card may tell the chat (`permissions.ts`), a dependency-free QR (`qr.ts`, `uqr`), the card-only status tool, and the builders `permission()`, `offers()`, `receipt()`, `waitForSignature()`. The card page gains the demo's tokens, a shared honesty frame, and three React views ported from `examples/ap2-multistore/widget/widget.html` on the demo branch, plus a page-side signature watch.

**Tech Stack:** as increment 1 (TypeScript NodeNext server half, React 19 page built by Vite into one HTML, vitest), plus `uqr` 0.1.3 (MIT, zero dependencies) as the gate's one new runtime dependency.

Spec: `specs/015-card-kit/spec.md` (FR-6 to FR-9). Issue: #256. Visual source of truth: `git show demo/scenario-2a-over-limit:examples/ap2-multistore/widget/widget.html`.

## Global Constraints

- All repository content is in **English**.
- Every commit: `git commit -s` (DCO); the message ends with `Co-Authored-By: <the model that wrote the commit> <noreply@anthropic.com>`.
- Verify with the **root** run: `npm run build && npm test && npm run lint`.
- The server half (`packages/credentagent-gate/src/cards/*.ts`) imports neither React nor the MCP SDK (the eslint rule enforces it). Server modules use NodeNext imports with `.js` extensions; page modules (`src/cards/ui/**`) use extensionless imports.
- Tool data is rendered **as text only** — never `dangerouslySetInnerHTML`.
- `trustLevel` is **required** wherever a card shows consent or payment (permission, receipt) — never defaulted; the honesty line is built from it and cannot be omitted.
- A card only shows; the server enforces (security invariant 1). The card-only tool takes **only a grant id**, never a URL from the card.
- New per-grant state is keyed by grant id inside a factory, never module-level (invariant 4; the lint enforces it for `.ts`).
- Exact values: kinds `credentagent.permission`, `credentagent.offers`, `credentagent.receipt`; card-only tool `credentagent-permission-status`; QR `_meta` key `credentagent/qr`; defaults `holdMs` 45 000, `modelGraceMs` 20 000; card hold 25 000 ms; poll 1 500 ms; grace poll 500 ms; forget after 3 600 000 ms; page retry 3 000 ms, 60 calls.
- Copy (verbatim from the demo): see each view's code below.
- Each PR is a **draft**, from a branch pushed to this repo, body per `.github/pull_request_template.md`. Never push to `main`, never merge. About 500 changed lines per PR.

---

## PR 2a — the server decides when the card may say "signed" (branch `feat/256-cards-permission-watch`, base `feat/256-cards-serve`)

```bash
git checkout feat/256-cards-serve && git checkout -b feat/256-cards-permission-watch
```

### Task 1: The permission contract and the permission watch

**Files:**
- Create: `packages/credentagent-gate/src/cards/contract.ts`
- Create: `packages/credentagent-gate/src/cards/permissions.ts`
- Test: `packages/credentagent-gate/src/cards/permissions.test.ts`

**Interfaces:**
- Produces (`contract.ts`): `PERMISSION_KIND`, `PERMISSION_STATUS_TOOL`, `QR_META_KEY`; types `PermissionInput`, `PermissionCardData`, `PermissionStatusAnswer`.
- Produces (`permissions.ts`): types `PermissionStatus`, `ReadPermission<R>`, `UnknownPermission`, `PermissionWatch<R>`; `createPermissionWatch<R>({ read, holdMs, modelGraceMs, now?, sleep? }): PermissionWatch<R>` with `issued(permission)`, `waitForSignature(grantId)`, `cardStatus(grantId)`.

- [ ] **Step 1: Write the contract**

`packages/credentagent-gate/src/cards/contract.ts`:

```ts
// The card kit's data contract (spec 015): what a tool result carries for each card, shared by the
// server half (which builds it) and the card page (which renders it). A LEAF on purpose — plain types
// and constants, no Node and no React — so both sides import it.

/** A permission to sign on the phone (spec 015 FR-7). */
export const PERMISSION_KIND = "credentagent.permission";
/** The card-only tool the permission card follows the signature through — hidden from the model. */
export const PERMISSION_STATUS_TOOL = "credentagent-permission-status";
/** Where the QR code of the signing link rides: the result's `_meta`, so it costs the model no context. */
export const QR_META_KEY = "credentagent/qr";

/** What a server passes to `cards.permission()`. */
export interface PermissionInput {
  /** The store's id for the permission (the grant) the person is asked to sign. */
  grantId: string;
  store: { name: string; url?: string; merchantId?: string };
  /** The signing link — the card shows it as a QR code and an "Open link" button. */
  approveUrl: string;
  /** The products the permission covers, as the person should read them. */
  products: string[];
  /** In dollars. */
  limits: { perPurchase: number; total: number };
  /** One sentence: why this store (shown to the person). */
  why?: string;
  /** What the purchase will be verified at — said out loud, never defaulted (e.g. "presence-only-demo"). */
  trustLevel: string;
}

/** The permission card's data: the input, marked with its kind. */
export interface PermissionCardData extends PermissionInput {
  kind: typeof PERMISSION_KIND;
}

/** What the card-only status tool answers. `announce`: the card should tell the chat the permission
 *  was signed — decided on the server, once per grant, never while the model waits in its own turn.
 *  `final`: the card can stop asking. */
export interface PermissionStatusAnswer {
  status: string;
  trustLevel?: string;
  announce: boolean;
  final: boolean;
}
```

- [ ] **Step 2: Write the failing test**

`packages/credentagent-gate/src/cards/permissions.test.ts`:

```ts
// The permission watch (spec 015 FR-7): the kit owns both waits on a signature — the model's and the
// card's — so it alone decides when the card may tell the chat "signed": once per grant, and never
// while the model is still waiting in its own turn (two "go ahead"s could make the model buy twice).
// A virtual clock runs the waits instantly: `sleep(ms)` advances time by `ms`.
import { describe, it, expect } from "vitest";
import { createPermissionWatch, type PermissionStatus } from "./permissions.js";
import type { PermissionInput } from "./contract.js";

const permission: PermissionInput = {
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend"],
  limits: { perPurchase: 25, total: 50 },
  trustLevel: "presence-only-demo",
};

function virtualClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

/** A store that answers "pending" until `signedAt`, then "authorized" (plus the signed intent). */
function storeSigningAt(clock: { now: () => number }, signedAt: number) {
  const reads: PermissionInput[] = [];
  const read = async (p: PermissionInput): Promise<PermissionStatus & { intent?: string }> => {
    reads.push(p);
    return clock.now() >= signedAt ? { status: "authorized", trustLevel: "device-signed", intent: "signed-intent" } : { status: "pending" };
  };
  return { read, reads };
}

const watchFor = (clock: ReturnType<typeof virtualClock>, read: (p: PermissionInput) => Promise<PermissionStatus>, holdMs = 45_000) =>
  createPermissionWatch({ read, holdMs, modelGraceMs: 20_000, now: clock.now, sleep: clock.sleep });

describe("waitForSignature — the model waits in its own turn", () => {
  it("answers what the store answered once signed, extra fields included", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 3_000).read);
    watch.issued(permission);
    expect(await watch.waitForSignature("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });
    expect(clock.now()).toBeGreaterThanOrEqual(3_000);
  });

  it("gives up after holdMs with pending, so the model can ask again", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, Infinity).read, 10_000);
    watch.issued(permission);
    expect(await watch.waitForSignature("g1")).toEqual({ status: "pending" });
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
  });

  it("a grant this process never issued is unknown", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    expect(await watch.waitForSignature("nope")).toEqual({ status: "unknown" });
    expect(await watch.cardStatus("nope")).toEqual({ status: "unknown", announce: false, final: true });
  });
});

describe("cardStatus — the card follows the signature, and the server decides what it may say", () => {
  it("announces once the model has stopped waiting — and only once", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: true, final: true });
    expect(clock.now()).toBeGreaterThanOrEqual(20_000); // it waited out the model's grace window first
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("stays quiet while the model is coming back for the signature in its own turn", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 12_000).read, 10_000);
    watch.issued(permission);
    expect((await watch.waitForSignature("g1")).status).toBe("pending"); // the model heard "pending" and will call again
    const card = watch.cardStatus("g1");
    const model = watch.waitForSignature("g1"); // …and it does, while the card is following
    expect((await model).status).toBe("authorized");
    expect(await card).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("says nothing when the model already saw the signature", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    await watch.waitForSignature("g1");
    expect(await watch.cardStatus("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
  });

  it("pending is not final; a refusal is final and says nothing", async () => {
    const clock = virtualClock();
    const pending = watchFor(clock, storeSigningAt(clock, Infinity).read);
    pending.issued(permission);
    expect(await pending.cardStatus("g1")).toEqual({ status: "pending", announce: false, final: false });
    const denied = watchFor(clock, async () => ({ status: "denied" }));
    denied.issued(permission);
    expect(await denied.cardStatus("g1")).toEqual({ status: "denied", announce: false, final: true });
  });

  it("a failed read asks the card to try again", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, async () => { throw new Error("store unreachable"); });
    watch.issued(permission);
    expect(await watch.cardStatus("g1")).toEqual({ status: "pending", announce: false, final: false });
  });

  it("reads the permission the kit issued — the card supplies only a grant id", async () => {
    const clock = virtualClock();
    const store = storeSigningAt(clock, 0);
    const watch = watchFor(clock, store.read);
    watch.issued(permission);
    await watch.cardStatus("g1");
    expect(store.reads[0]).toEqual(permission);
  });

  it("forgets a permission an hour after it was last used", async () => {
    const clock = virtualClock();
    const watch = watchFor(clock, storeSigningAt(clock, 0).read);
    watch.issued(permission);
    clock.advance(3_600_001);
    watch.issued({ ...permission, grantId: "g2" });
    expect(await watch.waitForSignature("g1")).toEqual({ status: "unknown" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/credentagent-gate/src/cards/permissions.test.ts`
Expected: FAIL — cannot resolve `./permissions.js`.

- [ ] **Step 4: Implement the watch**

`packages/credentagent-gate/src/cards/permissions.ts`:

```ts
// The permission card's live status, on the server (spec 015 FR-7). The kit remembers each permission
// it issued and owns BOTH waits on its signature: the model's (`waitForSignature`, the main path — the
// model waits in its own turn) and the card's (the card-only status tool). Owning both is what lets
// it decide, in one place, when the card may tell the chat "signed": once per grant, and never while
// the model is still waiting in its turn — a second "go ahead" could make the model buy twice.
//
// State is in memory, per process, keyed by grant id (invariant 4). A multi-instance deploy would
// need a shared store here — an additive option for later.

import type { PermissionInput, PermissionStatusAnswer } from "./contract.js";

/** What `readPermission` answers. Anything else it returns (the signed intent, say) passes through `waitForSignature`. */
export interface PermissionStatus {
  /** "pending" until the person signs; then "authorized" — or "denied", "revoked", … */
  status: string;
  trustLevel?: string;
}

/** How the server reads a permission's live status, given the permission the kit issued. */
export type ReadPermission<R extends PermissionStatus = PermissionStatus> = (permission: PermissionInput) => Promise<R>;

/** `waitForSignature` for a grant this process never issued, or forgot an hour after its last use. */
export interface UnknownPermission {
  status: "unknown";
}

export interface PermissionWatch<R extends PermissionStatus> {
  /** Remember a permission the kit just showed: the model has its QR code and is about to wait. */
  issued(permission: PermissionInput): void;
  /** The model's wait, in its own turn: re-reads until signed, refused, or `holdMs` passes. */
  waitForSignature(grantId: string): Promise<R | UnknownPermission>;
  /** The card's wait: what the card-only status tool answers. */
  cardStatus(grantId: string): Promise<PermissionStatusAnswer>;
}

/** How long one card-only status call holds. */
const CARD_HOLD_MS = 25_000;
/** How often both waits re-read the status, and how often the card re-checks the model during its grace. */
const POLL_MS = 1_500;
const GRACE_POLL_MS = 500;
/** A permission is forgotten an hour after it was last used. */
const FORGET_AFTER_MS = 3_600_000;

interface Entry {
  permission: PermissionInput;
  /** The model knows it was signed: its wait answered "authorized", or the card told the chat. */
  told: boolean;
  /** `waitForSignature` calls in flight. */
  openWaits: number;
  /** When the model last heard "pending" (or got the card) — it calls again within the grace window. */
  lastHeard: number;
  lastUsed: number;
}

export function createPermissionWatch<R extends PermissionStatus>(options: {
  read: ReadPermission<R>;
  holdMs: number;
  modelGraceMs: number;
  /** Seams for the tests' virtual clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): PermissionWatch<R> {
  const { read, holdMs, modelGraceMs } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const entries = new Map<string, Entry>();

  const modelIsWaiting = (entry: Entry): boolean => entry.openWaits > 0 || now() - entry.lastHeard < modelGraceMs;

  /** Re-read until the status is no longer "pending" or `ms` passes. */
  async function hold(entry: Entry, ms: number): Promise<R> {
    const until = now() + ms;
    for (;;) {
      const answer = await read(entry.permission);
      if (answer.status !== "pending" || now() >= until) return answer;
      await sleep(POLL_MS);
    }
  }

  return {
    issued(permission) {
      for (const [grantId, entry] of entries) if (now() - entry.lastUsed > FORGET_AFTER_MS) entries.delete(grantId);
      entries.set(permission.grantId, { permission, told: false, openWaits: 0, lastHeard: now(), lastUsed: now() });
    },

    async waitForSignature(grantId) {
      const entry = entries.get(grantId);
      if (!entry) return { status: "unknown" };
      entry.openWaits += 1;
      try {
        const answer = await hold(entry, holdMs);
        if (answer.status === "authorized") entry.told = true;
        return answer;
      } finally {
        entry.openWaits -= 1;
        entry.lastHeard = now();
        entry.lastUsed = now();
      }
    },

    async cardStatus(grantId) {
      const entry = entries.get(grantId);
      if (!entry) return { status: "unknown", announce: false, final: true };
      entry.lastUsed = now();
      let answer: R;
      try {
        answer = await hold(entry, CARD_HOLD_MS);
      } catch {
        return { status: "pending", announce: false, final: false }; // a failed read: the card asks again
      }
      const status = { status: answer.status, ...(answer.trustLevel ? { trustLevel: answer.trustLevel } : {}) };
      if (answer.status !== "authorized") return { ...status, announce: false, final: answer.status !== "pending" };
      // Signed. While the model is waiting in its turn it will see the signature itself: stay quiet.
      const until = now() + modelGraceMs;
      while (!entry.told && modelIsWaiting(entry) && now() < until) await sleep(GRACE_POLL_MS);
      if (entry.told) return { ...status, announce: false, final: true };
      if (modelIsWaiting(entry)) return { ...status, announce: false, final: false }; // the card asks again
      entry.told = true; // the model ended its turn: the card tells the chat, exactly once
      return { ...status, announce: true, final: true };
    },
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run packages/credentagent-gate/src/cards/permissions.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 6: Prove the two load-bearing rules**

(a) Replace the `while (…) await sleep(GRACE_POLL_MS);` line and the `if (modelIsWaiting(entry)) return …final: false…` line with nothing; rerun — "stays quiet while the model is coming back…" must FAIL. Restore.
(b) Replace `if (entry.told) return { ...status, announce: false, final: true };` with nothing; rerun — "announces … and only once" must FAIL. Restore. Rerun: PASS.

- [ ] **Step 7: Root verification and commit**

Run: `npm run build && npm test && npm run lint` — all green. (`tsconfig.test.json` already includes `src/cards/*.test.ts`.)

```bash
git add packages/credentagent-gate/src/cards/contract.ts packages/credentagent-gate/src/cards/permissions.ts packages/credentagent-gate/src/cards/permissions.test.ts
git commit -s -F - <<'EOF'
The server decides when a permission card may tell the chat it was signed

The kit remembers each permission it shows and owns both waits on its signature — the model's and
the card's — so the "signed" message goes out once per grant, and never while the model is still
waiting in its own turn (spec 015 FR-7; the AP2 demo's double-purchase fix).

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 2: Open draft PR 2a (controller)

Push and `gh pr create --draft --base feat/256-cards-serve`. Title: "Card kit, step 4: the server decides when a permission card may say \"signed\"". Body per template — plain terms: a person signs a spending permission on their phone; the chat should learn about it without the person typing "signed", but never twice (a second "go ahead" could make the AI buy twice); this adds the server-side rule; the card itself comes in the next pull requests.

---

## PR 2b — the permission API (branch `feat/256-cards-permission-api`, base `feat/256-cards-permission-watch`)

### Task 3: The QR code, and the card-only status tool

**Files:**
- Create: `packages/credentagent-gate/src/cards/qr.ts`; Test: `packages/credentagent-gate/src/cards/qr.test.ts`
- Modify: `packages/credentagent-gate/src/cards/meta.ts`; Test: `packages/credentagent-gate/src/cards/meta.test.ts`
- Modify: `packages/credentagent-gate/package.json` (dependency `uqr`)

**Interfaces:**
- Produces: `qrDataUrl(text: string): string`; `GRANT_ID_INPUT` (a Standard Schema for `{ grantId: string }`); `CardsServer` gains `registerTool`; `registerPermissionStatusTool(server, answer: (grantId: string) => Promise<PermissionStatusAnswer>): void`.

- [ ] **Step 1: Add the dependency**

In `packages/credentagent-gate/package.json` `"dependencies"`, add `"uqr": "^0.1.3"` (alphabetical: after `"jose"`). Run `npm install` — exits 0.

- [ ] **Step 2: Write the failing tests**

`packages/credentagent-gate/src/cards/qr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { qrDataUrl } from "./qr.js";

describe("qrDataUrl", () => {
  it("is an SVG data URL the card shows as an image", () => {
    const url = qrDataUrl("https://beanbarn.example/credentagent/grants/g1");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toMatch(/^<svg [\s\S]*<\/svg>$/);
  });

  it("a different link is a different code", () => {
    expect(qrDataUrl("https://a.example/1")).not.toBe(qrDataUrl("https://a.example/2"));
  });
});
```

Append to `packages/credentagent-gate/src/cards/meta.test.ts` (it already has `connect`, `uris`, `html`; add the import of `registerPermissionStatusTool` to the existing `./meta.js` import and `import { PERMISSION_STATUS_TOOL } from "./contract.js";`):

```ts
describe("the permission card's status tool", () => {
  const status = { status: "authorized", trustLevel: "device-signed", announce: true, final: true };

  it("is hidden from the model, callable from the card, and takes only a grant id", async () => {
    const client = await connect((server) => registerPermissionStatusTool(server, async () => status));
    const [tool] = (await client.listTools()).tools;
    expect(tool.name).toBe(PERMISSION_STATUS_TOOL);
    expect(tool._meta).toEqual({ ui: { visibility: ["app"] }, "openai/widgetAccessible": true });
    expect(tool.inputSchema).toEqual({ type: "object", properties: { grantId: { type: "string" } }, required: ["grantId"], additionalProperties: false });
  });

  it("answers what the server decided, and never hands a URL from the card to the server", async () => {
    const asked: string[] = [];
    const client = await connect((server) => registerPermissionStatusTool(server, async (grantId) => { asked.push(grantId); return status; }));
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: "g1", store: "https://evil.example" } });
    expect(result.structuredContent).toEqual(status);
    expect(asked).toEqual(["g1"]);
  });

  it("refuses a call without a string grant id", async () => {
    const client = await connect((server) => registerPermissionStatusTool(server, async () => status));
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: 5 } });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/credentagent-gate/src/cards/qr.test.ts packages/credentagent-gate/src/cards/meta.test.ts`
Expected: FAIL — `./qr.js` missing; `registerPermissionStatusTool` not exported.

- [ ] **Step 4: Implement**

`packages/credentagent-gate/src/cards/qr.ts`:

```ts
// The signing link as a QR code the person scans with their phone (spec 015 FR-7): an SVG data URL.
// `uqr` has no dependencies and runs in Node and the browser alike (the card page's preview uses it too).
import { renderSVG } from "uqr";

export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(text, { ecc: "M", border: 1 }))}`;
}
```

In `packages/credentagent-gate/src/cards/meta.ts`: add at the top

```ts
import { PERMISSION_STATUS_TOOL, type PermissionStatusAnswer } from "./contract.js";
import type { CardResult } from "./results.js";
```

replace the `CardsServer` interface with:

```ts
/** `{ grantId: string }` as a Standard Schema with its JSON Schema — written by hand, so the kit needs
 *  no schema library. The MCP SDK validates tool input through `validate` and lists `jsonSchema`. */
export interface GrantIdSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: { grantId: string } } | { issues: ReadonlyArray<{ message: string }> };
    readonly jsonSchema: { readonly input: (options: unknown) => Record<string, unknown>; readonly output: (options: unknown) => Record<string, unknown> };
  };
}

const GRANT_ID_JSON = { type: "object", properties: { grantId: { type: "string" } }, required: ["grantId"], additionalProperties: false };

export const GRANT_ID_INPUT: GrantIdSchema = {
  "~standard": {
    version: 1,
    vendor: "credentagent",
    validate: (value) =>
      value !== null && typeof value === "object" && typeof (value as { grantId?: unknown }).grantId === "string"
        ? { value: { grantId: (value as { grantId: string }).grantId } } // only the grant id goes through
        : { issues: [{ message: "grantId must be a string" }] },
    jsonSchema: { input: () => ({ ...GRANT_ID_JSON }), output: () => ({ ...GRANT_ID_JSON }) },
  },
};

/** The slice of an MCP server the kit registers through. */
export interface CardsServer {
  registerResource(name: string, uri: string, metadata: { mimeType: string }, read: () => Promise<ResourceRead>): unknown;
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: GrantIdSchema; annotations: { readOnlyHint: true }; _meta: Record<string, unknown> },
    handler: (args: { grantId: string }) => Promise<CardResult>,
  ): unknown;
}
```

and append:

```ts
/** The card-only tool the permission card follows the signature through: hidden from the model
 *  (`ui.visibility: ["app"]`), callable from the card (`openai/widgetAccessible`). It takes only a grant
 *  id — never a URL from the card — and answers what the server decided. */
export function registerPermissionStatusTool(server: CardsServer, answer: (grantId: string) => Promise<PermissionStatusAnswer>): void {
  server.registerTool(
    PERMISSION_STATUS_TOOL,
    {
      title: "Permission status (card only)",
      description: "Used by the permission card to follow the phone signature. The model does not call it.",
      inputSchema: GRANT_ID_INPUT,
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
    },
    async ({ grantId }) => {
      const status = await answer(grantId);
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: { ...status } };
    },
  );
}
```

- [ ] **Step 5: Run them to verify they pass, root verification, commit**

Run: `npx vitest run packages/credentagent-gate/src/cards/` — all PASS. Then `npm run build && npm test && npm run lint`.

```bash
git add packages/credentagent-gate/package.json package-lock.json packages/credentagent-gate/src/cards/qr.ts packages/credentagent-gate/src/cards/qr.test.ts packages/credentagent-gate/src/cards/meta.ts packages/credentagent-gate/src/cards/meta.test.ts
git commit -s -F - <<'EOF'
The permission card gets its QR code and its card-only status tool

The QR is an SVG data URL from uqr (MIT, no dependencies). The status tool is hidden from the model,
callable from the card, and takes only a grant id; its input schema is written by hand, so the kit
still imports no schema library and no MCP SDK (spec 015 FR-7).

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 4: `createCards({ readPermission })`, `cards.permission()`, `cards.waitForSignature()`

**Files:**
- Modify: `packages/credentagent-gate/src/cards/index.ts`; Test: `packages/credentagent-gate/src/cards/cards.test.ts`
- Modify: `packages/credentagent-gate/README.md` (the Cards section), `specs/015-card-kit/spec.md` (FR-7 and Increments)

**Interfaces:**
- Consumes: Task 1 `createPermissionWatch`, `PermissionStatus`, `ReadPermission`, `UnknownPermission`, contract constants; Task 3 `qrDataUrl`, `registerPermissionStatusTool`.
- Produces: `createCards<R>(options?: CardsOptions<R>): Cards<R>`; `Cards<R>` gains `permission(input, options?): CardResult` and `waitForSignature(grantId): Promise<R | UnknownPermission>`; new exports listed in Step 3.

- [ ] **Step 1: Write the failing tests** — append to `packages/credentagent-gate/src/cards/cards.test.ts` (extend its `./index.js` import with `PERMISSION_KIND, PERMISSION_STATUS_TOOL, QR_META_KEY, type PermissionInput`):

```ts
const permission: PermissionInput = {
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend",
  trustLevel: "presence-only-demo",
};

describe("cards.permission", () => {
  const signed = async () => ({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });

  it("shows the permission; its QR code reaches the card in _meta and costs the model no context", () => {
    const result = createCards({ readPermission: signed }).permission(permission);
    expect(result.structuredContent).toEqual({ kind: PERMISSION_KIND, ...permission });
    expect(String(result._meta?.[QR_META_KEY])).toMatch(/^data:image\/svg\+xml;/);
    expect(result.content[0].text).toContain(JSON.stringify({ kind: PERMISSION_KIND, ...permission }, null, 2));
    expect(result.content[0].text).not.toContain("data:image");
  });

  it("needs readPermission — without it the card could never learn the permission was signed", async () => {
    const cards = createCards();
    expect(() => cards.permission(permission)).toThrow(/readPermission/);
    await expect(cards.waitForSignature("g1")).rejects.toThrow(/readPermission/);
  });

  it("needs a trust level, said out loud", () => {
    const withoutTrust = { ...permission, trustLevel: undefined } as unknown as PermissionInput;
    expect(() => createCards({ readPermission: signed }).permission(withoutTrust)).toThrow(/trustLevel is required/);
  });

  it("the model's wait answers what readPermission answered, extra fields included", async () => {
    const cards = createCards({ readPermission: signed });
    cards.permission(permission);
    expect(await cards.waitForSignature("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });
  });

  it("register adds the card-only status tool when readPermission is set, and only then", async () => {
    // One ordinary tool on both servers, so tools/list exists either way.
    const names = async (cards: ReturnType<typeof createCards>) =>
      (await (await connect((s) => { cards.register(s); s.registerTool("other", { description: "another tool" }, async () => ({ content: [] })); })).listTools()).tools.map((t) => t.name).sort();
    expect(await names(createCards({ readPermission: signed }))).toEqual([PERMISSION_STATUS_TOOL, "other"].sort());
    expect(await names(createCards())).toEqual(["other"]);
  });

  it("over MCP, the card learns it was signed — from the permission the kit issued, not from the card", async () => {
    const read: PermissionInput[] = [];
    const cards = createCards({ readPermission: async (p) => { read.push(p); return { status: "authorized", trustLevel: "device-signed" }; }, modelGraceMs: 0 });
    const client = await connect((server) => cards.register(server));
    cards.permission(permission);
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: "g1", store: "https://evil.example" } });
    expect(result.structuredContent).toEqual({ status: "authorized", trustLevel: "device-signed", announce: true, final: true });
    expect(read[0].store.url).toBe("https://beanbarn.example");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/credentagent-gate/src/cards/cards.test.ts`
Expected: FAIL — `cards.permission` is not a function / missing exports.

- [ ] **Step 3: Implement** — in `packages/credentagent-gate/src/cards/index.ts`:

Replace the header comment's example block with:

```ts
//   const cards = createCards({ readPermission });                   // once per process
//   cards.register(server);                                           // per server instance
//   server.registerTool("request-permission", { inputSchema, _meta: cards.toolMeta() }, async (a) => cards.permission({ … }));
//   server.registerTool("check-permission", { inputSchema }, async ({ grantId }) => reply(await cards.waitForSignature(grantId)));
```

Replace the imports with:

```ts
import { loadCardsPage } from "./page.js";
import { cardToolMeta, cardUris, registerCardResources, registerPermissionStatusTool, type CardsServer, type CardToolMeta } from "./meta.js";
import { cardResult, type CardResult } from "./results.js";
import { createPermissionWatch, type PermissionStatus, type ReadPermission, type UnknownPermission } from "./permissions.js";
import { qrDataUrl } from "./qr.js";
import { PERMISSION_KIND, QR_META_KEY, type PermissionCardData, type PermissionInput } from "./contract.js";
import type { GrantViewData } from "./grant-view.js";
```

Add before `export interface Cards`:

```ts
export interface CardsOptions<R extends PermissionStatus = PermissionStatus> {
  /** How to read a permission's live status. Needed for permission cards: the card follows the
   *  signature through it, and `waitForSignature` holds on it. */
  readPermission?: ReadPermission<R>;
  /** How long `waitForSignature` holds before answering "pending" (default 45 000 ms — under claude.ai's
   *  60 s tool-call limit, like the storefront's `approvalHoldMs`). */
  holdMs?: number;
  /** After the model last heard "pending", how long it still counts as waiting in its own turn — the
   *  card stays quiet meanwhile (default 20 000 ms). */
  modelGraceMs?: number;
}
```

Make the interface generic — `export interface Cards<R extends PermissionStatus = PermissionStatus> {` — and add these members after `grant`:

```ts
  /** A tool result that asks the person to sign a permission on their phone: the card shows a QR code
   *  of `approveUrl` and follows the signature live. Requires `readPermission`. */
  permission(input: PermissionInput, options?: { note?: string }): CardResult;
  /** The model's wait for the signature, in its own turn: holds up to `holdMs` and answers what
   *  `readPermission` answered — `{ status: "unknown" }` for a grant this process never issued. */
  waitForSignature(grantId: string): Promise<R | UnknownPermission>;
```

Add after `GRANT_NOTE`:

```ts
const PERMISSION_NOTE =
  "The person sees a card with a QR code for approveUrl. In one short sentence, ask them to scan it with their phone and sign " +
  "(give them the link too). Then, without ending your turn, wait for the signature: call the tool that checks it, and again " +
  "while it says pending. When it says authorized, continue. Don't ask the person to confirm they signed.";

const NEEDS_READER = "createCards({ readPermission }) is required for permission cards: the card follows the signature through it.";
```

Replace `createCards` with:

```ts
/** Configure once per process. Reads the built page now, so a missing build fails at startup, not mid-chat. */
export function createCards<R extends PermissionStatus = PermissionStatus>(options: CardsOptions<R> = {}): Cards<R> {
  const page = loadCardsPage();
  const uris = cardUris(page.hash);
  const watch = options.readPermission
    ? createPermissionWatch({ read: options.readPermission, holdMs: options.holdMs ?? 45_000, modelGraceMs: options.modelGraceMs ?? 20_000 })
    : undefined;
  return {
    html: page.html,
    register(server) {
      registerCardResources(server, page.html, uris);
      if (watch) registerPermissionStatusTool(server, (grantId) => watch.cardStatus(grantId));
    },
    toolMeta: (status) => cardToolMeta(uris, status),
    grant: (view, options) => cardResult(view, options?.note ?? GRANT_NOTE),
    permission(input, options) {
      if (!watch) throw new Error(NEEDS_READER);
      if (typeof input.trustLevel !== "string" || input.trustLevel === "") {
        throw new Error('cards.permission(): trustLevel is required — say out loud what the purchase will be verified at (e.g. "presence-only-demo").');
      }
      watch.issued(input);
      const data: PermissionCardData = { kind: PERMISSION_KIND, ...input };
      return cardResult(data, options?.note ?? PERMISSION_NOTE, { [QR_META_KEY]: qrDataUrl(input.approveUrl) });
    },
    waitForSignature: (grantId) => (watch ? watch.waitForSignature(grantId) : Promise.reject(new Error(NEEDS_READER))),
  };
}
```

Replace the export block at the end with:

```ts
export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
export { PERMISSION_KIND, PERMISSION_STATUS_TOOL, QR_META_KEY } from "./contract.js";
export type { PermissionCardData, PermissionInput, PermissionStatusAnswer } from "./contract.js";
export type { PermissionStatus, ReadPermission, UnknownPermission } from "./permissions.js";
export type { CardsServer, CardToolMeta } from "./meta.js";
export type { CardResult } from "./results.js";
```

- [ ] **Step 4: Run, then root verification**

Run: `npx vitest run packages/credentagent-gate/src/cards/` — all PASS. `npm run build && npm test && npm run lint` — green.

- [ ] **Step 5: README and spec**

In `packages/credentagent-gate/README.md`, Cards section: replace the final paragraph's sentence "The permission card with a QR code, the offers card and the receipt card are next ([#256](…))." with "The offers and receipt cards are next ([#256](https://github.com/openmobilehub/credentagent/issues/256))." and insert before that paragraph:

````md
### A permission to sign on the phone

```js
const cards = createCards({
  // How to read a permission's live status — here, from the store that issued it. Answer { status, trustLevel? }
  // ("pending" until signed); anything else you return (the signed intent) comes back from waitForSignature.
  readPermission: ({ grantId, store }) => getJson(`${store.url}/agent/grants/${grantId}`),
});

server.registerTool("request-permission", { inputSchema, _meta: cards.toolMeta() }, async (args) => {
  const grant = await postJson(`${args.store}/agent/grants`, { /* … */ });
  return cards.permission({
    grantId: grant.grantId,
    store: { name: grant.store, url: args.store },
    approveUrl: grant.approveUrl, // becomes the QR code — it reaches the card in _meta, not the model
    products: grant.products,
    limits: { perPurchase: args.perSpend, total: args.budget },
    why: args.why,
    trustLevel: grant.trustLevel, // required: what the purchase will be verified at
  });
});

server.registerTool("check-permission", { inputSchema }, async ({ grantId }) => {
  const signed = await cards.waitForSignature(grantId); // holds up to 45 s
  return reply(signed.status === "authorized" ? "Signed. Call buy now." : `Not signed yet (${signed.status}). Call again.`);
});
```

The dependable path is the model waiting in its own turn (`waitForSignature`). `register()` also adds a
card-only tool, `credentagent-permission-status` — hidden from the model, it takes only a grant id — that
the card follows the signature through. The kit owns both waits, so it alone decides when the card may
tell the chat "signed": once per grant, and never while the model is still waiting (two "go ahead"s could
make it buy twice). It remembers permissions in memory, per process, for an hour after their last use.
````

In `specs/015-card-kit/spec.md`: in FR-7, after "the QR of `approveUrl` (an SVG data URL) rides in `_meta`", add "under the key `credentagent/qr` (generated with `uqr`, MIT, no dependencies)"; in FR-1, replace "one small dependency-free QR encoder" with "`uqr`, a dependency-free QR encoder"; in Increments, replace items 2 and 3 with:

```md
2. **Permission card** — FR-6, FR-7, in four pull requests (plan: `plan-increments-2-3.md`): 2a the
   permission watch (when the card may say "signed"); 2b the API (`permission()`, `waitForSignature()`,
   the QR, the card-only tool); 2c the card on the page; 2d its live status.
3. **Offers and receipt cards** — FR-8 (3a), FR-9 (3b).
```

- [ ] **Step 6: Commit; open draft PR 2b (controller)**

```bash
git add packages/credentagent-gate/src/cards/index.ts packages/credentagent-gate/src/cards/cards.test.ts packages/credentagent-gate/README.md specs/015-card-kit/spec.md
git commit -s -F - <<'EOF'
A server asks the person to sign on their phone with cards.permission(), and waits with waitForSignature()

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

PR title: "Card kit, step 5: cards.permission() and waitForSignature() — ask the person to sign on their phone".

---

## PR 2c — the permission card on the page (branch `feat/256-cards-permission-card`, base `feat/256-cards-permission-api`)

### Task 5: The demo's tokens, icons, and the honesty frame

**Files:**
- Modify: `packages/credentagent-gate/src/cards/ui/theme.css`
- Create: `packages/credentagent-gate/src/cards/ui/views/icons.tsx`, `views/frame.tsx`, `views/format.ts`, `views/cards.module.css`
- Test: `packages/credentagent-gate/src/cards/ui/views/frame.test.tsx`

**Interfaces:**
- Produces: `Icon({ name, className })` with names `scale | phone | check | x | link | store`; `CardFrame({ eyebrow?, trustLevel, children })` (honesty line always last); `HonestyLine({ trustLevel })`; `honestyText(trustLevel)`; `usd(n)`; `shortName(name)`; CSS module classes listed in Step 4.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/views/frame.test.tsx`:

```tsx
// The honesty frame (spec 015 FR-6): every card about a permission or a payment ends with a line built
// from its trust level. Bypass: drop <HonestyLine/> from CardFrame and these go red.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardFrame, honestyText } from "./frame";

describe("the honesty line", () => {
  it("for a presence-only demo says the credential is not issuer-verified and no money moves", () => {
    expect(honestyText("presence-only-demo")).toBe(
      "Demo: the signatures are real, but the payment credential is not issuer-verified yet (presence-only-demo). No real money moves.",
    );
  });

  it("for a level the kit does not know, shows the level and claims nothing more", () => {
    expect(honestyText("issuer-verified")).toBe("Trust level: issuer-verified.");
  });

  it("is always the frame's last line, after the card's body", () => {
    const html = renderToStaticMarkup(<CardFrame eyebrow="Permission request" trustLevel="presence-only-demo"><p>the body</p></CardFrame>);
    expect(html).toContain("the body");
    expect(html.indexOf("No real money moves")).toBeGreaterThan(html.indexOf("the body"));
    expect(html).toMatch(/data-trust-level="presence-only-demo"[^>]*>[^<]*No real money moves[^<]*<\/p><\/section>$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run packages/credentagent-gate/src/cards/ui/views/frame.test.tsx` → FAIL, `./frame` missing.

- [ ] **Step 3: Tokens** — in `packages/credentagent-gate/src/cards/ui/theme.css`, append:

```css
/* The kit's card tokens (ported from the AP2 demo). Host-first: Claude passes its MCP Apps variables and
   fonts; ChatGPT and the preview fall back to these. Light by default, dark from data-theme or the OS. */
:root {
  --fg: var(--color-text-primary, #1f2328); --fg-2: var(--color-text-secondary, #57606a);
  --line: var(--color-border-secondary, #d8dee4); --tint: var(--color-background-secondary, #f6f8fa);
  --ok: var(--color-text-success, #1a7f37); --ok-bg: var(--color-background-success, #dafbe1);
  --bad: var(--color-text-danger, #cf222e); --bad-bg: var(--color-background-danger, #ffebe9);
  --warn: var(--color-text-warning, #9a6700); --warn-bg: var(--color-background-warning, #fff8c5);
  --info: var(--color-text-info, #0969da);
  --sans: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --mono: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  --r: var(--border-radius-md, 10px);
}
:root[data-theme="dark"] {
  --fg: var(--color-text-primary, #e6edf3); --fg-2: var(--color-text-secondary, #9198a1);
  --line: var(--color-border-secondary, #3d444d); --tint: var(--color-background-secondary, #151b23);
  --ok: var(--color-text-success, #3fb950); --ok-bg: var(--color-background-success, #12261e);
  --bad: var(--color-text-danger, #f85149); --bad-bg: var(--color-background-danger, #25171c);
  --warn: var(--color-text-warning, #d29922); --warn-bg: var(--color-background-warning, #272115);
  --info: var(--color-text-info, #4493f8);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --fg: var(--color-text-primary, #e6edf3); --fg-2: var(--color-text-secondary, #9198a1);
    --line: var(--color-border-secondary, #3d444d); --tint: var(--color-background-secondary, #151b23);
    --ok: var(--color-text-success, #3fb950); --ok-bg: var(--color-background-success, #12261e);
    --bad: var(--color-text-danger, #f85149); --bad-bg: var(--color-background-danger, #25171c);
    --warn: var(--color-text-warning, #d29922); --warn-bg: var(--color-background-warning, #272115);
    --info: var(--color-text-info, #4493f8);
  }
}
```

- [ ] **Step 4: The shared pieces**

`packages/credentagent-gate/src/cards/ui/views/cards.module.css`:

```css
/* The kit's own cards (spec 015), ported from the AP2 demo's designs. Colors come from the page tokens
   (theme.css), which follow the host's MCP Apps style variables with light and dark fallbacks. */
.card { border: 1px solid var(--line); border-radius: var(--r); padding: 16px; display: grid; gap: 14px; color: var(--fg); font: 15px/1.5 var(--sans); margin: 2px; }
.card p, .card h1, .card ul, .card dl, .card dd { margin: 0; }
.card h1 { font-size: 18px; font-weight: 600; line-height: 1.35; }
.eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--fg-2); display: flex; align-items: center; gap: 6px; }
.sub { color: var(--fg-2); font-size: 14px; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 500; }
.ok { background: var(--ok-bg); color: var(--ok); }
.warn { background: var(--warn-bg); color: var(--warn); }
.bad { background: var(--bad-bg); color: var(--bad); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
@media (prefers-reduced-motion: no-preference) { .warn .dot { animation: pulse 1.4s ease-in-out infinite; } }
@keyframes pulse { 50% { opacity: .35; } }
.honesty { font-size: 12px; color: var(--fg-2); border-top: 1px solid var(--line); padding-top: 10px; }
.button { font: inherit; font-size: 14px; font-weight: 500; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: var(--r); padding: 8px 14px; min-height: 40px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.button:hover { background: var(--tint); }
.button:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
```

`packages/credentagent-gate/src/cards/ui/views/icons.tsx`:

```tsx
// The cards' line icons (from the AP2 demo's sprite), inline so the page stays one self-contained file.
import type { ReactNode } from "react";

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  scale: <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />,
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  link: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  store: <path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6" />,
};

export type IconName = "scale" | "phone" | "check" | "x" | "link" | "store";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
```

`packages/credentagent-gate/src/cards/ui/views/format.ts`:

```ts
/** "$21.00" — the cards show dollars with cents, as the AP2 demo did. */
export const usd = (dollars: number): string => `$${dollars.toFixed(2)}`;
/** "House Blend, 1 lb bag" → "House Blend": the short name the cards show. */
export const shortName = (name: string): string => name.split(",")[0];
```

`packages/credentagent-gate/src/cards/ui/views/frame.tsx`:

```tsx
// The honesty frame (spec 015 FR-6): every card about a permission or a payment renders inside it, and
// its last line says what the card can prove — built from the data's trust level, never omitted.
import type { ReactNode } from "react";
import styles from "./cards.module.css";

export function honestyText(trustLevel: string): string {
  return trustLevel === "presence-only-demo"
    ? "Demo: the signatures are real, but the payment credential is not issuer-verified yet (presence-only-demo). No real money moves."
    : `Trust level: ${trustLevel}.`;
}

export function HonestyLine({ trustLevel }: { trustLevel: string }) {
  return (
    <p className={styles.honesty} data-trust-level={trustLevel}>
      {honestyText(trustLevel)}
    </p>
  );
}

export function CardFrame({ eyebrow, trustLevel, children }: { eyebrow?: ReactNode; trustLevel: string; children: ReactNode }) {
  return (
    <section className={styles.card}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      {children}
      <HonestyLine trustLevel={trustLevel} />
    </section>
  );
}
```

- [ ] **Step 5: Run it to verify it passes; prove the bypass** — `npx vitest run packages/credentagent-gate/src/cards/ui/views/frame.test.tsx` → 3 PASS. Remove `<HonestyLine trustLevel={trustLevel} />` from `CardFrame`, rerun → "is always the frame's last line" FAILS; restore.

- [ ] **Step 6: Commit**

```bash
git add packages/credentagent-gate/src/cards/ui/theme.css packages/credentagent-gate/src/cards/ui/views
git commit -s -F - <<'EOF'
The card page gets the AP2 demo's look: its tokens, icons, and an honesty frame no card can drop

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 6: The permission card, its preview, and its place in the dispatch

**Files:**
- Create: `packages/credentagent-gate/src/cards/ui/views/PermissionCard.tsx`; Test: `views/permission-card.test.tsx`
- Modify: `views/cards.module.css` (append), `ui/CardView.tsx`, `ui/preview.ts`, `ui/card-view.test.tsx`

**Interfaces:**
- Consumes: Task 5's `CardFrame`, `Icon`, `usd`, `shortName`, styles; contract `PERMISSION_KIND`, `QR_META_KEY`, `PermissionCardData`; `qrDataUrl` (`../qr`).
- Produces: `type SignatureState = { kind: "waiting" } | { kind: "signed"; trustLevel?: string } | { kind: "not-signed"; status: string }`; `WAITING`; `PermissionCard({ data, qr, state, open })`; preview result type `PreviewResult = { structuredContent: object; _meta?: Record<string, unknown> }`; preview view `permission`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/views/permission-card.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionCard, WAITING, type SignatureState } from "./PermissionCard";
import { PERMISSION_KIND, type PermissionCardData } from "../../contract";

const data: PermissionCardData = {
  kind: PERMISSION_KIND,
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend ($21).",
  trustLevel: "presence-only-demo",
};
const qr = "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E";
const render = (state: SignatureState = WAITING, code: unknown = qr): string =>
  renderToStaticMarkup(<PermissionCard data={data} qr={code} state={state} open={async () => {}} />);

describe("PermissionCard", () => {
  it("asks the person to sign at one store, with the limits, the reason and the QR code", () => {
    const html = render();
    expect(html).toContain("Permission request");
    expect(html).toContain("Sign on your phone to let the agent buy at BeanBarn");
    expect(html).toContain("Why BeanBarn: lowest price for House Blend ($21).");
    expect(html).toContain("beanbarn.example");
    expect(html).toContain(">House Blend<");
    expect(html).toContain("up to $25.00");
    expect(html).toContain("up to $50.00");
    expect(html).toContain(`src="${qr}"`);
    expect(html).toContain('alt="QR code for the signing link at BeanBarn"');
    expect(html).toContain("Scan with your phone&#x27;s camera");
    expect(html).toContain("Open link");
    expect(html).toContain("Only this store, only these products, only up to these amounts.");
  });

  it("shows the live status: waiting, signed, or not signed", () => {
    expect(render()).toContain("Waiting for your signature");
    expect(render({ kind: "signed", trustLevel: "device-signed" })).toContain("Signed on your phone · device-signed");
    expect(render({ kind: "signed" })).toMatch(/Signed on your phone<\/span>/);
    expect(render({ kind: "not-signed", status: "denied" })).toContain("Not signed · denied");
  });

  it("shows a QR code only when it is an image data URL", () => {
    expect(render(WAITING, "https://evil.example/qr.png")).not.toContain("<img");
    expect(render(WAITING, undefined)).not.toContain("<img");
  });

  it("ends with the honesty line", () => {
    expect(render()).toMatch(/No real money moves\.<\/p><\/section>$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL, `./PermissionCard` missing.

- [ ] **Step 3: Implement** — append to `views/cards.module.css`:

```css
/* permission */
.split { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 520px) { .split { grid-template-columns: minmax(0, 1fr) 176px; align-items: start; } }
.stack { display: grid; gap: 12px; }
.why { border-left: 3px solid var(--info); padding: 2px 0 2px 10px; color: var(--fg-2); font-size: 14px; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; font-size: 14px; }
.facts dt { color: var(--fg-2); }
.facts dd { font-weight: 500; }
.qr { display: grid; gap: 8px; justify-items: center; text-align: center; font-size: 13px; color: var(--fg-2); }
.qr img { width: 168px; height: 168px; background: #fff; padding: 8px; border-radius: 8px; border: 1px solid var(--line); image-rendering: pixelated; }
.signed img { opacity: .25; }
```

`packages/credentagent-gate/src/cards/ui/views/PermissionCard.tsx`:

```tsx
// The permission card (spec 015 FR-7), ported from the AP2 demo: sign on your phone to let the agent buy
// at ONE store, within these limits. It only shows — the store enforces the limits, and the live status
// comes from the server.
import { useState } from "react";
import type { PermissionCardData } from "../../contract";
import { CardFrame } from "./frame";
import { Icon } from "./icons";
import { shortName, usd } from "./format";
import styles from "./cards.module.css";

export type SignatureState = { kind: "waiting" } | { kind: "signed"; trustLevel?: string } | { kind: "not-signed"; status: string };
export const WAITING: SignatureState = { kind: "waiting" };

export interface PermissionCardProps {
  data: PermissionCardData;
  /** The QR code of the signing link, from the result's `_meta` — shown only if it is an image data URL. */
  qr: unknown;
  state: SignatureState;
  open: (url: string) => Promise<void>;
}

export function PermissionCard({ data, qr, state, open }: PermissionCardProps) {
  const [openFailed, setOpenFailed] = useState(false);
  const { store, limits } = data;
  const qrSrc = typeof qr === "string" && qr.startsWith("data:image/") ? qr : null;
  const openLink = (): void => {
    setOpenFailed(false);
    open(data.approveUrl).catch(() => setOpenFailed(true));
  };
  return (
    <CardFrame
      eyebrow={
        <>
          <Icon name="phone" className={styles.icon} />
          Permission request
        </>
      }
      trustLevel={data.trustLevel}
    >
      <div className={styles.split}>
        <div className={styles.stack}>
          <h1>Sign on your phone to let the agent buy at {store.name}</h1>
          {data.why ? (
            <p className={styles.why}>
              Why {store.name}: {data.why}
            </p>
          ) : null}
          <dl className={styles.facts}>
            <dt>Store</dt>
            <dd>
              {store.name}
              {store.merchantId ? <div className={`${styles.mono} ${styles.sub}`}>{store.merchantId}</div> : null}
            </dd>
            <dt>Products</dt>
            <dd>{data.products.map(shortName).join(", ")}</dd>
            <dt>Per purchase</dt>
            <dd>up to {usd(limits.perPurchase)}</dd>
            <dt>In total</dt>
            <dd>up to {usd(limits.total)}</dd>
          </dl>
          <div>
            <StatusPill state={state} />
          </div>
        </div>
        <div className={`${styles.qr} ${state.kind === "signed" ? styles.signed : ""}`}>
          {qrSrc ? <img src={qrSrc} alt={`QR code for the signing link at ${store.name}`} /> : null}
          <span>Scan with your phone&apos;s camera</span>
          <button type="button" className={styles.button} onClick={openLink}>
            <Icon name="link" className={styles.icon} />
            Open link
          </button>
          {openFailed ? <span>Couldn&apos;t open the link — scan the code instead.</span> : null}
        </div>
      </div>
      <p className={styles.sub}>
        Only this store, only these products, only up to these amounts. The agent spends it with its own key, which the store never sees.
      </p>
    </CardFrame>
  );
}

function StatusPill({ state }: { state: SignatureState }) {
  if (state.kind === "signed") {
    return (
      <span role="status" className={`${styles.pill} ${styles.ok}`}>
        <Icon name="check" className={styles.icon} />
        Signed on your phone{state.trustLevel ? ` · ${state.trustLevel}` : ""}
      </span>
    );
  }
  if (state.kind === "not-signed") {
    return (
      <span role="status" className={`${styles.pill} ${styles.bad}`}>
        <Icon name="x" className={styles.icon} />
        Not signed · {state.status}
      </span>
    );
  }
  return (
    <span role="status" className={`${styles.pill} ${styles.warn}`}>
      <span className={styles.dot} />
      Waiting for your signature
    </span>
  );
}
```

- [ ] **Step 4: The preview and the dispatch**

In `ui/preview.ts`: import `{ PERMISSION_KIND, QR_META_KEY, type PermissionCardData } from "../contract"` and `{ qrDataUrl } from "../qr"`; add `export type PreviewResult = { structuredContent: object; _meta?: Record<string, unknown> };`; change `SAMPLES` to `Readonly<Record<string, PreviewResult>>`, wrapping each grant entry as `{ structuredContent: grant({...}) }`; add

```ts
const permission: PermissionCardData = {
  kind: PERMISSION_KIND,
  grantId: "grant_preview",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/grant_preview",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend ($21), and a 4.4 rating — only RoastWorks rates higher, at $5 more.",
  trustLevel: "presence-only-demo",
};
```

and the entry `permission: { structuredContent: permission, _meta: { [QR_META_KEY]: qrDataUrl(permission.approveUrl) } }` (first in the object, before the grants); `previewResult` returns `PreviewResult | null`: `view !== null && Object.hasOwn(SAMPLES, view) ? SAMPLES[view] : null`.

In `ui/CardView.tsx`: import `{ PERMISSION_KIND, QR_META_KEY, type PermissionCardData } from "../contract"` and `{ PermissionCard, WAITING } from "./views/PermissionCard"`; before the grant branch add:

```tsx
  if (card.data.kind === PERMISSION_KIND) {
    // The live status lands with the page's signature watch (next pull request); until then it shows waiting.
    return <PermissionCard data={card.data as unknown as PermissionCardData} qr={card.meta[QR_META_KEY]} state={WAITING} open={bridge.open} />;
  }
```

In `ui/card-view.test.tsx`: change the `render` helper's parameter type to `{ structuredContent: unknown; _meta?: Record<string, unknown> } | null`; replace the test "every preview sample is a card that carries the trust line" with:

```tsx
  it("every preview sample renders its card, with the honesty its kind requires", () => {
    for (const view of previewViews()) {
      const result = previewResult(view)!;
      const html = render(result);
      const kind = readCard(result)!.data.kind;
      if (kind === GRANT_VIEW_KIND) expect(html, view).toContain("limits enforced server-side");
      else if (kind === PERMISSION_KIND) expect(html, view).toContain("No real money moves");
      else throw new Error(`no honesty expectation for ${kind} (${view})`);
    }
  });

  it("renders a permission result as the permission card, with its QR code", () => {
    const html = render(previewResult("permission"));
    expect(html).toContain("Sign on your phone to let the agent buy at BeanBarn");
    expect(html).toContain('src="data:image/svg+xml');
  });
```

(import `GRANT_VIEW_KIND` from `./grants` and `PERMISSION_KIND` from `../contract`).

- [ ] **Step 5: Run, build, check in the browser, commit**

Run: `npx vitest run packages/credentagent-gate/src/cards/` — PASS; `npm run build && npm test && npm run lint` — green.
Browser (controller): `cards.html?view=permission`, light and dark and 375 px — matches the demo's permission card (screenshot reference: the demo's preview `?view=permission`).

```bash
git add packages/credentagent-gate/src/cards/ui
git commit -s -F - <<'EOF'
The permission card comes to the card page, looking as it did in the AP2 demo

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

PR (controller): "Card kit, step 6: the permission card — sign on your phone, with a QR code".

---

## PR 2d — the permission card's live status (branch `feat/256-cards-permission-live`, base `feat/256-cards-permission-card`)

### Task 7: The page follows the signature, once per grant

**Files:**
- Modify: `ui/card-store.ts`, `ui/card-store.test.ts`, `ui/bridge.ts`, `ui/hosts.ts`, `ui/hosts.test.ts`, `ui/card-view.test.tsx` (the fake bridge gains `tell`)
- Create: `ui/signature-watch.ts`; Test: `ui/signature-watch.test.ts`

**Interfaces:**
- Produces: `Bridge.tell(text: string): Promise<void>`; `createSignatureWatch(bridge, { sleep?, retryMs?, maxCalls? }): SignatureWatch` with `follow(grantId, storeName)`, `state(grantId)`, `subscribe(listener)`; `readCard(...).key` covers data AND meta.

- [ ] **Step 1: Write the failing tests**

Append to `ui/card-store.test.ts` inside `describe("createCardStore", …)`:

```ts
  it("a change only in the card-only extras (_meta — the QR code) replaces the card", () => {
    const store = createCardStore();
    store.show({ structuredContent: grant });
    expect(store.show({ structuredContent: grant, _meta: { qr: "data:image/svg+xml,x" } })).toBe(true);
    expect(store.current()?.meta).toEqual({ qr: "data:image/svg+xml,x" });
  });
```

`packages/credentagent-gate/src/cards/ui/signature-watch.test.ts`:

```ts
// The page's signature watch (spec 015 FR-7): one follow per grant however often the card redraws
// (ChatGPT redraws on every openai:set_globals — the AP2 demo's card restarted its polling each time),
// and the chat is told only when the server says so.
import { describe, it, expect, vi } from "vitest";
import { createSignatureWatch } from "./signature-watch";
import { PERMISSION_STATUS_TOOL } from "../contract";
import type { Bridge, Host } from "./bridge";

function fakeBridge(answers: unknown[], host: Host = "mcp") {
  const queue = [...answers];
  const bridge: Bridge = {
    host,
    call: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    open: async () => {},
    tell: vi.fn(async () => {}),
  };
  return bridge;
}
const options = { sleep: async () => {}, retryMs: 3_000, maxCalls: 3 };
const authorized = (announce: boolean, final: boolean) => ({ status: "authorized", trustLevel: "device-signed", announce, final });

describe("createSignatureWatch", () => {
  it("follows a grant through the card-only tool with only its grant id, until the answer is final", async () => {
    const bridge = fakeBridge([{ status: "pending", announce: false, final: false }, authorized(false, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1")).toEqual({ kind: "signed", trustLevel: "device-signed" }));
    expect(bridge.call).toHaveBeenCalledTimes(2);
    expect(bridge.call).toHaveBeenCalledWith(PERMISSION_STATUS_TOOL, { grantId: "g1" });
  });

  it("follows once per grant, however often the card redraws", async () => {
    const bridge = fakeBridge([{ status: "pending", announce: false, final: false }]);
    const watch = createSignatureWatch(bridge, options);
    for (let i = 0; i < 5; i++) watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(3); // 3 = maxCalls of ONE follow, not 15
  });

  it("tells the chat once when the server says announce, then never follows that grant again", async () => {
    const bridge = fakeBridge([authorized(true, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.tell).toHaveBeenCalledTimes(1));
    expect(bridge.tell).toHaveBeenCalledWith("I signed the permission for BeanBarn on my phone (g1). Please go ahead with the purchase.");
    watch.follow("g1", "BeanBarn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });

  it("a signed answer that is not final keeps asking, and says nothing", async () => {
    const bridge = fakeBridge([authorized(false, false), authorized(false, true)]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalledTimes(2));
    expect(bridge.tell).not.toHaveBeenCalled();
  });

  it("a refusal ends the follow and shows it", async () => {
    const bridge = fakeBridge([{ status: "denied", announce: false, final: true }]);
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1")).toEqual({ kind: "not-signed", status: "denied" }));
  });

  it("in the preview, with no server behind it, it stops quietly", async () => {
    const bridge = fakeBridge([null], "preview");
    const watch = createSignatureWatch(bridge, options);
    watch.follow("g1", "BeanBarn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).toHaveBeenCalledTimes(1);
    expect(watch.state("g1")).toEqual({ kind: "waiting" });
  });

  it("a failed call is retried after retryMs", async () => {
    const sleep = vi.fn(async () => {});
    const bridge = fakeBridge([new Error("offline"), authorized(false, true)]);
    const watch = createSignatureWatch(bridge, { ...options, sleep });
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(watch.state("g1").kind).toBe("signed"));
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("tells subscribers when a state changes", async () => {
    const watch = createSignatureWatch(fakeBridge([authorized(false, true)]), options);
    const listener = vi.fn();
    watch.subscribe(listener);
    watch.follow("g1", "BeanBarn");
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });
});
```

In `ui/hosts.test.ts`, give the fake `openai` object a `sendFollowUpMessage: vi.fn(async () => {})` and add:

```ts
  it("in ChatGPT, tell posts the follow-up message (a fallback: it did not post in real ChatGPT)", async () => {
    // build the fake window as the other tests in this file do, then:
    const bridge = await connectHost(store, win as unknown as Window);
    await bridge.tell("I signed the permission");
    expect(openai.sendFollowUpMessage).toHaveBeenCalledWith({ prompt: "I signed the permission" });
  });
```

(adapt the local names to the file's existing fake-window helper). In `ui/card-view.test.tsx`, the fake bridge object gains `tell: async () => {}`.

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run packages/credentagent-gate/src/cards/ui/` → the new tests FAIL.

- [ ] **Step 3: Implement**

`ui/card-store.ts`, in `readCard`: `key: JSON.stringify([data, meta])`, and update the header comment's last sentence to "…replaces it only when the result — its data or its card-only extras — actually changed."

`ui/bridge.ts`, add to `Bridge`:

```ts
  /** Post a message to the chat as the person — MCP Apps' `ui/message`; in ChatGPT, the follow-up
   *  message, a fallback only: it did not post in real ChatGPT. Never throws. */
  tell(text: string): Promise<void>;
```

`ui/hosts.ts`: add `sendFollowUpMessage?: (options: { prompt: string }) => Promise<void>;` to `OpenAiGlobals`; add to each bridge —
MCP: `tell: async (text) => { try { await app.sendMessage({ role: "user", content: [{ type: "text", text }] }); } catch { /* a host that cannot post leaves the card's "Signed" as the signal */ } },`
ChatGPT: `tell: async (text) => { try { await openai.sendFollowUpMessage?.({ prompt: text }); } catch { /* same */ } },`
Preview: `tell: async () => {},`.

`packages/credentagent-gate/src/cards/ui/signature-watch.ts`:

```ts
// The permission card's live status on the page (spec 015 FR-7). It follows each grant's signature
// through the card-only status tool, OUTSIDE React: a host may redraw the card at any time (ChatGPT does,
// on every `openai:set_globals`), and the AP2 demo's card flickered back to "Waiting" and restarted its
// polling when this state lived in the DOM. One follow per grant, however often the card redraws; the
// chat is told only when the server says so.
import { PERMISSION_STATUS_TOOL, type PermissionStatusAnswer } from "../contract";
import type { Bridge } from "./bridge";
import { WAITING, type SignatureState } from "./views/PermissionCard";

export interface SignatureWatch {
  /** Start following a grant's signature — once per grant, however often the card redraws. */
  follow(grantId: string, storeName: string): void;
  state(grantId: string): SignatureState;
  subscribe(listener: () => void): () => void;
}

const isAnswer = (value: unknown): value is PermissionStatusAnswer =>
  value !== null && typeof value === "object" && typeof (value as { status?: unknown }).status === "string";

export function createSignatureWatch(
  bridge: Bridge,
  options: { sleep?: (ms: number) => Promise<void>; retryMs?: number; maxCalls?: number } = {},
): SignatureWatch {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryMs = options.retryMs ?? 3_000;
  const maxCalls = options.maxCalls ?? 60;
  const states = new Map<string, SignatureState>();
  const following = new Set<string>(); // a follow in flight — one per grant
  const finished = new Set<string>(); // a final answer reached — a redraw never starts another
  const listeners = new Set<() => void>();
  const set = (grantId: string, state: SignatureState): void => {
    states.set(grantId, state);
    for (const listener of listeners) listener();
  };

  async function run(grantId: string, storeName: string): Promise<void> {
    for (let call = 0; call < maxCalls; call++) {
      let answer: unknown;
      try {
        answer = await bridge.call(PERMISSION_STATUS_TOOL, { grantId });
      } catch {
        answer = null;
      }
      if (!isAnswer(answer)) {
        if (bridge.host === "preview") return; // no server behind the preview
        await sleep(retryMs);
        continue;
      }
      if (answer.status === "authorized") {
        if (states.get(grantId)?.kind !== "signed") set(grantId, { kind: "signed", ...(answer.trustLevel ? { trustLevel: answer.trustLevel } : {}) });
        if (answer.announce) await bridge.tell(`I signed the permission for ${storeName} on my phone (${grantId}). Please go ahead with the purchase.`);
        if (answer.final) {
          finished.add(grantId);
          return;
        }
        continue; // signed, but the model may still be waiting for it in its turn — ask again
      }
      if (answer.status !== "pending") {
        set(grantId, { kind: "not-signed", status: answer.status });
        finished.add(grantId);
        return;
      }
    }
  }

  return {
    follow(grantId, storeName) {
      if (following.has(grantId) || finished.has(grantId)) return;
      following.add(grantId);
      void run(grantId, storeName).finally(() => following.delete(grantId));
    },
    state: (grantId) => states.get(grantId) ?? WAITING,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run, prove the once-per-grant guard, commit**

Run the ui tests — PASS. Remove `following.has(grantId) || ` from `follow`, rerun: "follows once per grant" FAILS; restore. Root `npm run build && npm test && npm run lint` — green.

```bash
git add packages/credentagent-gate/src/cards/ui
git commit -s -F - <<'EOF'
The card page follows a permission's signature once per grant, and tells the chat only when the server says so

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 8: The permission card goes live

**Files:**
- Create: `ui/views/LivePermissionCard.tsx`
- Modify: `ui/CardView.tsx` (prop `watch`), `ui/main.tsx`, `ui/preview.ts` (`permission-signed`, `previewCall`), `ui/hosts.ts` (preview `call`), `ui/card-view.test.tsx`

**Interfaces:**
- Consumes: Task 7's `SignatureWatch`, `createSignatureWatch`.
- Produces: `LivePermissionCard({ data, qr, watch, open })`; `CardViewProps.watch: SignatureWatch`; `previewCall(view: string | null, tool: string): unknown`.

- [ ] **Step 1: Write the failing test** — in `ui/card-view.test.tsx`, the `render` helper passes `watch={createSignatureWatch(bridge)}` (import from `./signature-watch`), and add:

```tsx
  it("the preview's signed permission answers its own status tool", () => {
    expect(previewCall("permission-signed", PERMISSION_STATUS_TOOL)).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
    expect(previewCall("permission", PERMISSION_STATUS_TOOL)).toBeNull();
  });
```

(import `previewCall` from `./preview`, `PERMISSION_STATUS_TOOL` from `../contract`).

- [ ] **Step 2: Run to verify it fails** — FAIL: `previewCall` missing; `CardView` has no `watch` prop yet (TS is not checked by vitest — the failure is the missing export).

- [ ] **Step 3: Implement**

`packages/credentagent-gate/src/cards/ui/views/LivePermissionCard.tsx`:

```tsx
// The permission card with its live status: it starts the page's follow of the signature (once per
// grant — a redraw never starts another) and re-renders from the watch, which lives outside React.
import { useEffect, useSyncExternalStore } from "react";
import type { PermissionCardData } from "../../contract";
import type { SignatureWatch } from "../signature-watch";
import { PermissionCard } from "./PermissionCard";

export function LivePermissionCard({ data, qr, watch, open }: { data: PermissionCardData; qr: unknown; watch: SignatureWatch; open: (url: string) => Promise<void> }) {
  useEffect(() => watch.follow(data.grantId, data.store.name), [watch, data.grantId, data.store.name]);
  const read = () => watch.state(data.grantId);
  const state = useSyncExternalStore(watch.subscribe, read, read);
  return <PermissionCard data={data} qr={qr} state={state} open={open} />;
}
```

`ui/CardView.tsx`: add `watch: SignatureWatch;` to `CardViewProps` (import type from `./signature-watch`), destructure it, and replace the permission branch with
`return <LivePermissionCard data={card.data as unknown as PermissionCardData} qr={card.meta[QR_META_KEY]} watch={watch} open={bridge.open} />;` (drop the `PermissionCard`/`WAITING` import and the "next pull request" comment).

`ui/main.tsx`: import `createSignatureWatch` and `type SignatureWatch`; `Cards` takes `{ bridge, watch }` and passes `watch={watch}` to `CardView`; in the `.then`, `const watch = createSignatureWatch(bridge);` and render `<Cards bridge={bridge} watch={watch} />`.

`ui/preview.ts`: import `PERMISSION_STATUS_TOOL`; add the sample `"permission-signed": { structuredContent: { ...permission, grantId: "grant_preview_signed" }, _meta: { [QR_META_KEY]: qrDataUrl(permission.approveUrl) } }` right after `permission`, and:

```ts
/** What a preview card's tool call answers — only the signed permission's status tool, so its card shows "Signed". */
export function previewCall(view: string | null, tool: string): unknown {
  return view === "permission-signed" && tool === PERMISSION_STATUS_TOOL ? { status: "authorized", trustLevel: "device-signed", announce: false, final: true } : null;
}
```

`ui/hosts.ts` `connectPreview`: `const view = params.get("view");` then `store.show(previewResult(view));` and `call: async (name) => previewCall(view, name),`.

- [ ] **Step 4: Run, build, browser, commit**

`npx vitest run packages/credentagent-gate/src/cards/` — PASS; root build/test/lint — green. Browser (controller): `?view=permission` stays "Waiting for your signature" (pulsing dot); `?view=permission-signed` turns to "Signed on your phone · device-signed" and dims the QR; light/dark; 375 px.

```bash
git add packages/credentagent-gate/src/cards/ui
git commit -s -F - <<'EOF'
The permission card goes live: "Waiting for your signature" turns to "Signed on your phone"

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

PR (controller): "Card kit, step 7: the permission card's live status". README: in the Cards section's permission subsection add one sentence: "When the server says so, the card posts \"I signed the permission…\" to the chat — MCP Apps' `ui/message`; ChatGPT's follow-up message is wired as a fallback only, because it did not post in real ChatGPT."

---

## PR 3a — the offers card (branch `feat/256-cards-offers`, base `feat/256-cards-permission-live`)

### Task 9: `cards.offers()` — compare stores, say plainly who sells it

**Files:**
- Modify: `src/cards/contract.ts` (append), `src/cards/index.ts`, `src/cards/cards.test.ts`
- Create: `src/cards/offers.ts`; Test: `src/cards/offers.test.ts`

**Interfaces:**
- Produces: `OFFERS_KIND`; types `Offer`, `StoreOffers`, `OffersInput`, `OffersSummary`, `OffersCardData`; `offersCard(input): { data: OffersCardData; note: string }`; `Cards.offers(input, options?): CardResult`.

- [ ] **Step 1: Append to `contract.ts`**

```ts
/** The stores' offers side by side (spec 015 FR-8). */
export const OFFERS_KIND = "credentagent.offers";

export interface Offer {
  id: string;
  name: string;
  /** In dollars. */
  price: number;
  rating?: number;
}

/** One store's catalog as the agent read it — or the error that stopped it. */
export type StoreOffers = { store: string; url: string; products: Offer[] } | { url: string; error: string };

/** What a server passes to `cards.offers()`. */
export interface OffersInput {
  stores: StoreOffers[];
  /** The product the person named — an id, or words from its name. */
  product?: string;
  /** The most the person will pay for one, in dollars. */
  maxPrice?: number;
}

/** What the card says plainly when the person named a product. */
export interface OffersSummary {
  product: string;
  /** The stores that sell it. */
  sellers: string[];
  maxPrice?: number;
  /** With a limit: the stores that sell it within it. */
  within?: string[];
  /** With a limit: the cheapest offer. */
  cheapest?: { store: string; price: number };
}

export interface OffersCardData {
  kind: typeof OFFERS_KIND;
  stores: StoreOffers[];
  summary?: OffersSummary;
}
```

- [ ] **Step 2: Write the failing test**

`packages/credentagent-gate/src/cards/offers.test.ts`:

```ts
// The offers card's summary (spec 015 FR-8): the AP2 demo learned that a table alone makes the person
// work out "only one store sells this" or "nothing fits my limit" — so the kit says it, and tells the
// model what to do about it.
import { describe, it, expect } from "vitest";
import { offersCard } from "./offers.js";
import type { StoreOffers } from "./contract.js";

const catalog = (house: number, espresso: number, rating = 4.2) => [
  { id: "house-blend", name: "House Blend, 1 lb bag", price: house, rating },
  { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: espresso, rating },
];
const stores: StoreOffers[] = [
  { store: "Acme Coffee Co", url: "https://acme.example", products: catalog(24, 19, 4.1) },
  { store: "BeanBarn", url: "https://beanbarn.example", products: catalog(21, 22, 4.4) },
  { store: "RoastWorks", url: "https://roastworks.example", products: [...catalog(26, 18, 4.6), { id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
];

describe("offersCard", () => {
  it("without a product: the whole catalogs, no summary, and the model is told not to re-list them", () => {
    const { data, note } = offersCard({ stores });
    expect(data).toEqual({ kind: "credentagent.offers", stores });
    expect(note).toBe("The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.");
  });

  it("a named product narrows every catalog; a store that does not sell it keeps its column, empty", () => {
    const { data } = offersCard({ stores, product: "cold brew" });
    expect(data.stores.map((s) => ("products" in s ? s.products.map((p) => p.id) : s.error))).toEqual([[], [], ["cold-brew"]]);
    expect(data.summary).toEqual({ product: "cold brew", sellers: ["RoastWorks"] });
  });

  it("matches a product id as well as words from its name", () => {
    expect(offersCard({ stores, product: "espresso-beans" }).data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
    expect(offersCard({ stores, product: "House BLEND" }).data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
  });

  it("only one seller: nothing to compare", () => {
    expect(offersCard({ stores, product: "cold brew" }).note).toBe("Only RoastWorks sells it — no comparison to make. Say so in a sentence, then request the permission there.");
  });

  it("no seller: say so, and don't ask for a permission", () => {
    const { data, note } = offersCard({ stores, product: "matcha" });
    expect(data.summary).toEqual({ product: "matcha", sellers: [] });
    expect(note).toBe('No store sells "matcha". Say so; don\'t request a permission.');
  });

  it("with a limit: which stores fit it", () => {
    expect(offersCard({ stores, product: "espresso", maxPrice: 19 }).data.summary).toEqual({
      product: "espresso",
      sellers: ["Acme Coffee Co", "BeanBarn", "RoastWorks"],
      maxPrice: 19,
      within: ["Acme Coffee Co", "RoastWorks"],
      cheapest: { store: "RoastWorks", price: 18 },
    });
  });

  it("nothing within the limit: the cheapest, and no permission, no purchase", () => {
    const { data, note } = offersCard({ stores, product: "espresso", maxPrice: 15 });
    expect(data.summary?.within).toEqual([]);
    expect(note).toBe(
      "No offer is within the person's maximum of $15.00: the cheapest is $18.00 at RoastWorks. Don't request a permission and don't buy. " +
        "Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone.",
    );
  });

  it("a store that could not be read stays in the data and is no seller", () => {
    const { data } = offersCard({ stores: [...stores, { url: "https://down.example", error: "fetch failed" }], product: "house" });
    expect(data.stores.at(-1)).toEqual({ url: "https://down.example", error: "fetch failed" });
    expect(data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails** — FAIL, `./offers.js` missing.

- [ ] **Step 4: Implement**

`packages/credentagent-gate/src/cards/offers.ts`:

```ts
// The offers card (spec 015 FR-8): the stores' catalogs side by side, narrowed to the product the person
// named, with the plain summary the AP2 demo learned the person needs — "only one store sells it", "none
// is within your limit" — derived here, once, together with the matching note for the model.
import { OFFERS_KIND, type Offer, type OffersCardData, type OffersInput, type OffersSummary, type StoreOffers } from "./contract.js";

const usd = (dollars: number): string => `$${dollars.toFixed(2)}`;

export function offersCard({ stores, product, maxPrice }: OffersInput): { data: OffersCardData; note: string } {
  const wanted = product?.trim().toLowerCase();
  const matches = (p: Offer): boolean => p.id.toLowerCase() === wanted || p.name.toLowerCase().includes(wanted ?? "");
  const narrowed: StoreOffers[] = wanted ? stores.map((s) => ("products" in s ? { ...s, products: s.products.filter(matches) } : s)) : stores;
  const sellers = narrowed.flatMap((s) => ("products" in s && s.products.length > 0 ? [s.store] : []));
  const offers = narrowed.flatMap((s) => ("products" in s ? s.products.map((p) => ({ store: s.store, price: p.price })) : []));
  const cheapest = offers.reduce<{ store: string; price: number } | undefined>((a, b) => (a === undefined || b.price < a.price ? b : a), undefined);
  const within = maxPrice === undefined ? undefined : [...new Set(offers.filter((o) => o.price <= maxPrice).map((o) => o.store))];
  const summary: OffersSummary | undefined =
    wanted && product !== undefined
      ? { product, sellers, ...(maxPrice !== undefined ? { maxPrice, within, ...(cheapest ? { cheapest } : {}) } : {}) }
      : undefined;
  return { data: { kind: OFFERS_KIND, stores: narrowed, ...(summary ? { summary } : {}) }, note: noteFor(summary) };
}

function noteFor(summary: OffersSummary | undefined): string {
  if (summary && summary.sellers.length === 0) return `No store sells "${summary.product}". Say so; don't request a permission.`;
  if (summary?.within?.length === 0 && summary.cheapest && summary.maxPrice !== undefined) {
    return (
      `No offer is within the person's maximum of ${usd(summary.maxPrice)}: the cheapest is ${usd(summary.cheapest.price)} at ${summary.cheapest.store}. ` +
      "Don't request a permission and don't buy. Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone."
    );
  }
  if (summary && summary.sellers.length === 1) return `Only ${summary.sellers[0]} sells it — no comparison to make. Say so in a sentence, then request the permission there.`;
  return "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.";
}
```

In `index.ts`: import `offersCard` from `./offers.js` and `type OffersInput` from `./contract.js`; add to `Cards`:

```ts
  /** A tool result that shows the stores' offers side by side — narrowed to `product` and checked against
   *  `maxPrice` when given, with the summary ("only one store sells it", "none is within your limit") and
   *  the matching note for the model derived for you. */
  offers(input: OffersInput, options?: { note?: string }): CardResult;
```

implement `offers(input, options) { const card = offersCard(input); return cardResult(card.data, options?.note ?? card.note); },` and export `OFFERS_KIND` plus the types `Offer, OffersCardData, OffersInput, OffersSummary, StoreOffers`. Add to `cards.test.ts`:

```ts
describe("cards.offers", () => {
  it("is a card result with the derived note, which a note of your own replaces", () => {
    const stores = [{ store: "RoastWorks", url: "https://roastworks.example", products: [{ id: "cold-brew", name: "Cold Brew", price: 14 }] }];
    const result = createCards().offers({ stores, product: "cold brew" });
    expect(result.structuredContent).toMatchObject({ kind: OFFERS_KIND, summary: { sellers: ["RoastWorks"] } });
    expect(result.content[0].text.startsWith("Only RoastWorks sells it")).toBe(true);
    expect(createCards().offers({ stores }, { note: "Mine." }).content[0].text.startsWith("Mine.\n\n")).toBe(true);
  });
});
```

- [ ] **Step 5: Run, root verification, commit**

```bash
git add packages/credentagent-gate/src/cards
git commit -s -F - <<'EOF'
cards.offers() compares the stores and says plainly who sells it, and what fits the person's limit

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 10: The offers card on the page

**Files:**
- Create: `ui/views/OffersCard.tsx`; Test: `ui/views/offers-card.test.tsx`
- Modify: `ui/views/cards.module.css` (append), `ui/CardView.tsx`, `ui/preview.ts`, `ui/card-view.test.tsx`, `packages/credentagent-gate/README.md`

**Interfaces:**
- Consumes: Task 9's contract types and `offersCard` (the preview derives its samples with it).
- Produces: `OffersCard({ data })`; preview views `offers`, `only-one`, `over-limit`.

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/views/offers-card.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OffersCard } from "./OffersCard";
import { previewResult } from "../preview";
import type { OffersCardData } from "../../contract";

const render = (view: string): string => renderToStaticMarkup(<OffersCard data={previewResult(view)!.structuredContent as OffersCardData} />);

describe("OffersCard", () => {
  it("shows every store's offers side by side, with the lowest price and the top rating tagged", () => {
    const html = render("offers");
    expect(html).toContain("Compared 3 stores");
    expect(html).toContain("Offers, read live from each store");
    for (const store of ["Acme Coffee Co", "BeanBarn", "RoastWorks"]) expect(html).toContain(store);
    expect(html).toContain("$21.00");
    expect(html).toContain("Lowest price");
    expect(html).toContain("Top rated");
    expect(html).toContain("The agent picks one store, then asks you to sign a permission for it on your phone.");
  });

  it("only one seller: says there is nothing to compare, and tags nothing", () => {
    const html = render("only-one");
    expect(html).toContain("Only RoastWorks sells it, so there is nothing to compare.");
    expect(html).not.toContain("Lowest price");
    expect(html).not.toContain("Top rated");
  });

  it("over the limit: says what the cheapest costs, tags every offer, and asks for nothing", () => {
    const html = render("over-limit");
    expect(html).toContain("None is within your $15.00 limit. The cheapest is $18.00 at RoastWorks.");
    expect(html).toContain("Over your $15.00");
    expect(html).toContain("Nothing within your limit, so nothing to sign. Buying it would need a higher limit, signed on your phone.");
  });

  it("renders a store's words as text, never as markup", () => {
    const data: OffersCardData = { kind: "credentagent.offers", stores: [{ store: "<b>Evil</b>", url: "https://e.example", products: [{ id: "x", name: "<img src=x>", price: 1 }] }] };
    const html = renderToStaticMarkup(<OffersCard data={data} />);
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain("<img src=x>");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, `./OffersCard` missing.

- [ ] **Step 3: Implement** — append to `views/cards.module.css`:

```css
/* offers */
.offers { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
.offers th, .offers td { padding: 8px 6px; text-align: left; border-top: 1px solid var(--line); vertical-align: top; }
.offers thead th { border-top: 0; font-size: 13px; font-weight: 600; }
.offers tbody th { font-weight: 500; }
.price { font-weight: 600; font-variant-numeric: tabular-nums; }
.rate { color: var(--fg-2); font-size: 13px; }
.tag { display: inline-block; margin-top: 3px; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; }
.tagLow { background: var(--ok-bg); color: var(--ok); }
.tagTop { background: var(--tint); color: var(--info); border: 1px solid var(--line); }
.tagOver { background: var(--bad-bg); color: var(--bad); }
.limit { border-left: 3px solid var(--bad); padding: 2px 0 2px 10px; }
```

`packages/credentagent-gate/src/cards/ui/views/OffersCard.tsx`:

```tsx
// The offers card (spec 015 FR-8), ported from the AP2 demo: each store's offers side by side, read live,
// with the plain summary the server derived. It makes no trust claim — nothing is signed or paid here —
// so it has no honesty line.
import type { Offer, OffersCardData, OffersSummary, StoreOffers } from "../../contract";
import { Icon } from "./icons";
import { shortName, usd } from "./format";
import styles from "./cards.module.css";

type ReadStore = Extract<StoreOffers, { products: Offer[] }>;

export function OffersCard({ data }: { data: OffersCardData }) {
  const { summary } = data;
  const stores = data.stores.filter((s): s is ReadStore => "products" in s);
  const ids = [...new Set(stores.flatMap((s) => s.products.map((p) => p.id)))];
  const over = summary?.within !== undefined && summary.within.length === 0 && summary.sellers.length > 0;
  const said = summarySentence(summary, stores.length, over);
  const footer =
    ids.length === 0
      ? "Nothing to buy, so nothing to sign."
      : over
        ? "Nothing within your limit, so nothing to sign. Buying it would need a higher limit, signed on your phone."
        : "The agent picks one store, then asks you to sign a permission for it on your phone.";
  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>
        <Icon name="scale" className={styles.icon} />
        Compared {stores.length} stores
      </p>
      <h1>Offers, read live from each store</h1>
      {said ? <p className={over ? styles.limit : undefined}>{said}</p> : null}
      {ids.length > 0 ? (
        <table className={styles.offers}>
          <thead>
            <tr>
              <th>
                <span className={styles.sub}>Product</span>
              </th>
              {stores.map((s) => (
                <th key={s.url} scope="col">
                  {s.store}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <OfferRow key={id} id={id} stores={stores} maxPrice={summary?.maxPrice} />
            ))}
          </tbody>
        </table>
      ) : null}
      <p className={styles.sub}>{footer}</p>
    </section>
  );
}

function OfferRow({ id, stores, maxPrice }: { id: string; stores: ReadStore[]; maxPrice?: number }) {
  const cells = stores.map((s) => s.products.find((p) => p.id === id));
  const sold = cells.filter((p): p is Offer => p !== undefined);
  const low = Math.min(...sold.map((p) => p.price));
  const top = Math.max(...sold.map((p) => p.rating ?? -Infinity));
  const compared = sold.length > 1; // "lowest" and "top rated" mean nothing with a single seller
  return (
    <tr>
      <th scope="row">{shortName(sold[0].name)}</th>
      {cells.map((p, i) => (
        <td key={stores[i].url}>
          {p ? (
            <div>
              <div className={styles.price}>{usd(p.price)}</div>
              {p.rating !== undefined ? <div className={styles.rate}>{p.rating.toFixed(1)} ★</div> : null}
              {compared && p.price === low ? <span className={`${styles.tag} ${styles.tagLow}`}>Lowest price</span> : null}
              {compared && p.rating !== undefined && p.rating === top ? <span className={`${styles.tag} ${styles.tagTop}`}>Top rated</span> : null}
              {maxPrice !== undefined && p.price > maxPrice ? <span className={`${styles.tag} ${styles.tagOver}`}>Over your {usd(maxPrice)}</span> : null}
            </div>
          ) : (
            "—"
          )}
        </td>
      ))}
    </tr>
  );
}

/** When the person named a product, say plainly who sells it — the table alone makes them work it out. */
function summarySentence(summary: OffersSummary | undefined, storeCount: number, over: boolean): string | null {
  if (!summary) return null;
  const { sellers } = summary;
  if (sellers.length === 0) return `No store sells “${summary.product}”.`;
  if (over && summary.cheapest && summary.maxPrice !== undefined) {
    return `None is within your ${usd(summary.maxPrice)} limit. The cheapest is ${usd(summary.cheapest.price)} at ${summary.cheapest.store}.`;
  }
  if (summary.within && summary.maxPrice !== undefined) {
    return `${summary.within.length} of ${sellers.length} ${sellers.length === 1 ? "store sells" : "stores sell"} it within your ${usd(summary.maxPrice)} limit.`;
  }
  if (sellers.length === 1) return `Only ${sellers[0]} sells it, so there is nothing to compare.`;
  return `${sellers.length} of ${storeCount} stores sell it.`;
}
```

`ui/preview.ts`: import `offersCard` from `../offers` and add, using the demo's preview catalogs:

```ts
const coffee = (house: [number, number], espresso: [number, number], tea: [number, number]) => [
  { id: "house-blend", name: "House Blend, 1 lb bag", price: house[0], rating: house[1] },
  { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: espresso[0], rating: espresso[1] },
  { id: "green-tea", name: "Green Tea, 50 bags", price: tea[0], rating: tea[1] },
];
const threeStores = [
  { store: "Acme Coffee Co", url: "https://acme.example", products: coffee([24, 4.1], [19, 4.0], [9, 3.8]) },
  { store: "BeanBarn", url: "https://beanbarn.example", products: coffee([21, 4.4], [22, 4.2], [8, 4.5]) },
  { store: "RoastWorks", url: "https://roastworks.example", products: [...coffee([26, 4.6], [18, 4.7], [11, 4.0]), { id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
];
```

and the entries `offers: { structuredContent: offersCard({ stores: threeStores }).data }`, `"only-one": { structuredContent: offersCard({ stores: threeStores, product: "cold brew" }).data }`, `"over-limit": { structuredContent: offersCard({ stores: threeStores, product: "espresso", maxPrice: 15 }).data }` — first in `SAMPLES`, before `permission`.

`ui/CardView.tsx`: dispatch `OFFERS_KIND` → `<OffersCard data={card.data as unknown as OffersCardData} />`. `ui/card-view.test.tsx`: in the per-kind honesty test add `else if (kind === OFFERS_KIND) expect(html, view).toContain("Offers, read live from each store"); // no trust claim to make`.

README (Cards section): add a short subsection "Offers side by side" with `return cards.offers({ stores, product, maxPrice });` and one sentence on the derived summary and note; update the closing sentence to "The receipt card is next".

- [ ] **Step 4: Run, build, browser, commit**

Tests PASS; root green. Browser (controller): `?view=offers`, `only-one`, `over-limit`, light/dark/375 px — match the demo's offers card (the user's screenshot: "Compared 3 stores", tags under prices).

```bash
git add packages/credentagent-gate/src/cards packages/credentagent-gate/README.md
git commit -s -F - <<'EOF'
The offers card comes to the card page, looking as it did in the AP2 demo

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

PR (controller): "Card kit, step 8: the offers card — the stores side by side".

---

## PR 3b — the receipt card (branch `feat/256-cards-receipt`, base `feat/256-cards-offers`)

### Task 11: `cards.receipt()` — the store's answer, paid or refused

**Files:**
- Modify: `src/cards/contract.ts` (append), `src/cards/index.ts`, `src/cards/cards.test.ts`, `specs/015-card-kit/spec.md` (FR-9)

**Interfaces:**
- Produces: `RECEIPT_KIND`; types `PaidOrder`, `ReceiptInput`, `ReceiptCardData`; `Cards.receipt(answer, options?): CardResult`.

- [ ] **Step 1: Append to `contract.ts`**

```ts
/** The store's answer to a purchase (spec 015 FR-9). */
export const RECEIPT_KIND = "credentagent.receipt";

export interface PaidOrder {
  id: string;
  store: string;
  /** In `currency`'s major unit (dollars). */
  total: number;
  currency: string;
  /** "1 × House Blend, 1 lb bag" */
  items: string[];
  /** What the store checked before it accepted the order, one sentence each. */
  checks: string[];
}

/** What a server passes to `cards.receipt()`: the store's answer, as-is. `trustLevel` — what the
 *  purchase was verified at — is required on both answers. */
export type ReceiptInput =
  | { ok: true; order: PaidOrder; receiptUrl?: string; trustLevel: string }
  | { ok: false; store?: string; code?: string; reason: string; trustLevel: string };

export type ReceiptCardData = ReceiptInput & { kind: typeof RECEIPT_KIND };
```

- [ ] **Step 2: Write the failing test** — append to `cards.test.ts` (import `RECEIPT_KIND`, `type ReceiptInput`):

```ts
describe("cards.receipt", () => {
  const paid: ReceiptInput = {
    ok: true,
    order: { id: "ord_1", store: "BeanBarn", total: 21, currency: "USD", items: ["1 × House Blend, 1 lb bag"], checks: ["The permission's wallet signature verifies"] },
    receiptUrl: "https://beanbarn.example/agent/orders/ord_1",
    trustLevel: "presence-only-demo",
  };
  const refused: ReceiptInput = { ok: false, store: "Acme Coffee Co", code: "constraint", reason: "This permission was signed for another store", trustLevel: "presence-only-demo" };

  it("shows the store's answer as-is, paid or refused, and asks the model for one sentence", () => {
    for (const answer of [paid, refused]) {
      const result = createCards().receipt(answer);
      expect(result.structuredContent).toEqual({ kind: RECEIPT_KIND, ...answer });
      expect(result.content[0].text.startsWith("The person sees the store's answer in a card. Summarize it in one sentence.")).toBe(true);
    }
  });

  it("needs a trust level on both answers, said out loud", () => {
    for (const answer of [paid, refused]) {
      expect(() => createCards().receipt({ ...answer, trustLevel: undefined } as unknown as ReceiptInput)).toThrow(/trustLevel is required/);
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails; implement** — in `index.ts` add to `Cards`:

```ts
  /** A tool result that shows the store's answer to a purchase: what was paid and what the store
   *  checked, or why it refused (nothing was charged). */
  receipt(answer: ReceiptInput, options?: { note?: string }): CardResult;
```

and implement:

```ts
    receipt(answer, options) {
      if (typeof answer.trustLevel !== "string" || answer.trustLevel === "") {
        throw new Error('cards.receipt(): trustLevel is required — say out loud what the purchase was verified at (e.g. "presence-only-demo").');
      }
      const data: ReceiptCardData = { kind: RECEIPT_KIND, ...answer };
      return cardResult(data, options?.note ?? RECEIPT_NOTE);
    },
```

with `const RECEIPT_NOTE = "The person sees the store's answer in a card. Summarize it in one sentence.";`; export `RECEIPT_KIND` and the types `PaidOrder, ReceiptCardData, ReceiptInput`. In the spec's FR-9, replace the input shape with: "`{ ok: true, order: { id, store, total, currency, items, checks }, receiptUrl?, trustLevel }` or `{ ok: false, store?, code?, reason, trustLevel }` — `trustLevel` required on both".

- [ ] **Step 4: Run, root verification, commit**

```bash
git add packages/credentagent-gate/src/cards specs/015-card-kit/spec.md
git commit -s -F - <<'EOF'
cards.receipt() shows the store's answer to a purchase — paid with what it checked, or refused

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

### Task 12: The receipt card on the page

**Files:**
- Create: `ui/views/ReceiptCard.tsx`; Test: `ui/views/receipt-card.test.tsx`
- Modify: `ui/views/cards.module.css` (append), `ui/CardView.tsx`, `ui/preview.ts`, `ui/card-view.test.tsx`, `packages/credentagent-gate/README.md`

- [ ] **Step 1: Write the failing test**

`packages/credentagent-gate/src/cards/ui/views/receipt-card.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptCard } from "./ReceiptCard";
import { previewResult } from "../preview";
import type { ReceiptCardData } from "../../contract";

const render = (view: string): string =>
  renderToStaticMarkup(<ReceiptCard data={previewResult(view)!.structuredContent as ReceiptCardData} open={async () => {}} />);

describe("ReceiptCard", () => {
  it("paid: the total, the items, what the store checked, and the receipt link", () => {
    const html = render("receipt");
    expect(html).toContain("Paid $21.00 at BeanBarn");
    expect(html).toContain("Verified by the store before it accepted the order");
    expect(html).toContain("1 × House Blend, 1 lb bag");
    expect(html).toContain("What BeanBarn checked");
    expect(html).toContain("The permission&#x27;s wallet signature verifies");
    expect(html).toContain("Open receipt");
    expect(html).toMatch(/No real money moves\.<\/p><\/section>$/);
  });

  it("refused: who refused, why, and that nothing was charged", () => {
    const html = render("refused");
    expect(html).toContain("Acme Coffee Co refused this purchase");
    expect(html).toContain("Nothing was charged.");
    expect(html).toContain("This permission was signed for another store");
    expect(html).toContain("constraint");
    expect(html).toMatch(/No real money moves\.<\/p><\/section>$/);
  });

  it("no receipt link, no button", () => {
    const data = { ...(previewResult("receipt")!.structuredContent as ReceiptCardData) };
    delete (data as { receiptUrl?: string }).receiptUrl;
    expect(renderToStaticMarkup(<ReceiptCard data={data} open={async () => {}} />)).not.toContain("Open receipt");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, `./ReceiptCard` missing.

- [ ] **Step 3: Implement** — append to `views/cards.module.css`:

```css
/* receipt */
.hero { display: flex; gap: 12px; align-items: flex-start; }
.badge { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.heroOk .badge { background: var(--ok-bg); color: var(--ok); }
.heroBad .badge { background: var(--bad-bg); color: var(--bad); }
.badge .icon { width: 22px; height: 22px; }
.lines { display: grid; gap: 4px; }
.checks { list-style: none; padding: 0; display: grid; gap: 4px; font-size: 14px; }
.checks li { display: flex; gap: 8px; align-items: flex-start; }
.checks .icon { width: 16px; height: 16px; margin-top: 3px; color: var(--ok); }
.row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.total { font-weight: 600; font-size: 16px; border-top: 1px solid var(--line); padding-top: 8px; }
```

`packages/credentagent-gate/src/cards/ui/views/ReceiptCard.tsx`:

```tsx
// The receipt card (spec 015 FR-9), ported from the AP2 demo: the store's answer to a purchase. Paid —
// the total, the items, and every check the store ran before it accepted the order. Refused — who, why,
// and that nothing was charged. Both end with the honesty line.
import { useState } from "react";
import type { ReceiptCardData } from "../../contract";
import { CardFrame } from "./frame";
import { Icon } from "./icons";
import styles from "./cards.module.css";

const money = (amount: number, currency: string): string => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

export function ReceiptCard({ data, open }: { data: ReceiptCardData; open: (url: string) => Promise<void> }) {
  const [openFailed, setOpenFailed] = useState(false);
  if (!data.ok) {
    return (
      <CardFrame trustLevel={data.trustLevel}>
        <div className={`${styles.hero} ${styles.heroBad}`}>
          <div className={styles.badge}>
            <Icon name="x" className={styles.icon} />
          </div>
          <div>
            <h1>{data.store ?? "The store"} refused this purchase</h1>
            <p className={styles.sub}>Nothing was charged.</p>
          </div>
        </div>
        <p>{data.reason}</p>
        {data.code ? <p className={`${styles.mono} ${styles.sub}`}>{data.code}</p> : null}
      </CardFrame>
    );
  }
  const { order, receiptUrl } = data;
  return (
    <CardFrame trustLevel={data.trustLevel}>
      <div className={`${styles.hero} ${styles.heroOk}`}>
        <div className={styles.badge}>
          <Icon name="check" className={styles.icon} />
        </div>
        <div>
          <h1>
            Paid {money(order.total, order.currency)} at {order.store}
          </h1>
          <p className={styles.sub}>Verified by the store before it accepted the order</p>
        </div>
      </div>
      <div className={styles.lines}>
        {order.items.map((item, i) => (
          <div key={i} className={styles.row}>
            <span>{item}</span>
          </div>
        ))}
        <div className={`${styles.row} ${styles.total}`}>
          <span>Total</span>
          <span>{money(order.total, order.currency)}</span>
        </div>
      </div>
      <div className={styles.lines}>
        <p className={styles.eyebrow}>
          <Icon name="store" className={styles.icon} />
          What {order.store} checked
        </p>
        <ul className={styles.checks}>
          {order.checks.map((check, i) => (
            <li key={i}>
              <Icon name="check" className={styles.icon} />
              <span>{check}</span>
            </li>
          ))}
        </ul>
      </div>
      {receiptUrl ? (
        <div>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setOpenFailed(false);
              open(receiptUrl).catch(() => setOpenFailed(true));
            }}
          >
            <Icon name="link" className={styles.icon} />
            Open receipt
          </button>
          {openFailed ? <p className={styles.sub}>Couldn&apos;t open the receipt.</p> : null}
        </div>
      ) : null}
    </CardFrame>
  );
}
```

`ui/preview.ts`: import `RECEIPT_KIND`; add (after `permission-signed`):

```ts
  receipt: {
    structuredContent: {
      kind: RECEIPT_KIND,
      ok: true,
      order: {
        id: "ord_preview",
        store: "BeanBarn",
        total: 21,
        currency: "USD",
        items: ["1 × House Blend, 1 lb bag"],
        checks: [
          "The permission's wallet signature verifies",
          "The agent signed with the key that permission names",
          "The cart is the one we quoted and signed",
          "The permission allows this store",
          "Within the signed limits: $21.00 of $50.00, max $25.00 a purchase",
          "Our catalog prices it at $21.00",
          "Fresh purchase code, addressed to us (no replay)",
        ],
      },
      receiptUrl: "https://beanbarn.example/agent/orders/ord_preview",
      trustLevel: "presence-only-demo",
    },
  },
  refused: {
    structuredContent: { kind: RECEIPT_KIND, ok: false, store: "Acme Coffee Co", code: "constraint", reason: "This permission was signed for another store", trustLevel: "presence-only-demo" },
  },
```

`ui/CardView.tsx`: dispatch `RECEIPT_KIND` → `<ReceiptCard data={card.data as unknown as ReceiptCardData} open={bridge.open} />`. `ui/card-view.test.tsx`: in the per-kind honesty test, `else if (kind === RECEIPT_KIND) expect(html, view).toContain("No real money moves");`.

README (Cards section): add "The store's answer" subsection with `return cards.receipt(await purchase(args)); // { ok: true, order, receiptUrl?, trustLevel } or { ok: false, reason, trustLevel }`; replace the "next" sentence with: "Preview them all at `/cards` (no `view` lists every sample)."

- [ ] **Step 4: Run, build, browser, commit**

Tests PASS; root green. Browser (controller): `?view=receipt`, `?view=refused`, light/dark/375 px — match the demo's receipt (the user's screenshot "Paid $21.00 at BeanBarn").

```bash
git add packages/credentagent-gate/src/cards packages/credentagent-gate/README.md
git commit -s -F - <<'EOF'
The receipt card comes to the card page — paid with what the store checked, or refused

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

PR (controller): "Card kit, step 9: the receipt card — paid, or refused".

---

## Self-review (done)

- **Spec coverage:** FR-6 (honesty frame) → Task 5, every card test; FR-7 → Tasks 1, 3, 4 (server), 6–8 (page); FR-8 → Tasks 9–10; FR-9 → Tasks 11–12. The demo lessons: redraw guard (store key with `_meta`, Task 7), one follow per grant (Task 7), announce once and never while the model waits (Task 1), QR in `_meta` (Task 4), card-only tool (Task 3), `sendFollowUpMessage` as fallback (Task 7, README), text-only rendering (Task 10 test), preview of every view (Tasks 6, 8, 10, 12).
- **Placeholders:** `<model>` in commit trailers is the implementing model's name (Global Constraints); otherwise none.
- **Type consistency:** `PermissionStatusAnswer` (contract) is what `cardStatus` returns, the tool answers, and the page's watch reads; `SignatureState`/`WAITING` (Task 6) are used by Tasks 7–8; `PreviewResult` (Task 6) is extended by Tasks 8, 10, 12; `Cards<R>` gains `permission`, `waitForSignature` (Task 4), `offers` (Task 9), `receipt` (Task 11).
