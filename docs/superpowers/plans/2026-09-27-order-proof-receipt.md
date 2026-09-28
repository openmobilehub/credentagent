# Order Proof Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each successful proof with its order, serve it at `GET /credentagent/orders/:id/proof`, and show it (with an "Inspect ›" link when available) in the storefront widget and the website demo receipt.

**Architecture:** A `ProofEntry` is appended to the order's `VerificationRecord.proofs` by the credential rail; payment rails hand theirs to `completeOrder` via `CompletionInput.proof`; `completeOrder` copies both into `CompletedRecord.proofs` before it clears verification. A new ceremony route reads completed orders through an optional `completedOrders` seam. Surfaces read `order.proofs` from the records they already fetch.

**Tech Stack:** TypeScript (ESM), Express-shaped structural routes, vitest + supertest, React (storefront widget, `renderToStaticMarkup` tests), vanilla JS + `node --test` (website).

**Spec:** `docs/superpowers/specs/2026-09-27-order-proof-receipt-design.md`

Paths below are relative to the library repo root unless marked **(website)**. Branch: `feat/order-proof-receipt` (stacked on `feat/inspect-presentation`, PR #223).

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/credentagent-gate/src/ceremony/proofs.ts` (new) | `ProofEntry` type, `upsertProof`, `withoutPresentations` |
| `packages/credentagent-gate/src/ceremony/proof-route.ts` (new) | `registerProofRoute` — `GET /credentagent/orders/:id/proof` |
| `packages/credentagent-gate/src/ceremony/proofs.test.ts` (new) | unit + end-to-end tests for all of the above |
| `packages/credentagent-gate/src/types.ts` | `VerificationRecord.proofs` |
| `packages/credentagent-gate/src/ceremony/types.ts` | `CompletionInput.proof` |
| `packages/credentagent-gate/src/ceremony/completion.ts` | `CompletedRecord.proofs`; copy proofs on both write paths |
| `packages/credentagent-gate/src/ceremony/credential-gate/routes.ts` | record the credential proof |
| `packages/credentagent-gate/src/ceremony/dc-payment/routes.ts`, `passkey/routes.ts` | pass the payment proof |
| `packages/credentagent-gate/src/ceremony/mount.ts` | `completedOrders` seam; register the route |
| `packages/credentagent-gate/src/orders.ts`, `orders-serve.ts` | carry `proofs`; strip bytes from the webhook |
| `packages/credentagent-gate/src/index.ts` | export `ProofEntry` type |
| `packages/credentagent-storefront/src/server.ts` | `CompletedOrderRecord.proofs`; publish `completedOrders` seam |
| `packages/credentagent-storefront/src/ui/ProofRows.tsx` (new) + test | widget proof rows |
| `packages/credentagent-storefront/src/ui/app.tsx` | render `ProofRows` in the confirmation card |
| `examples/quickstart/server.mjs`, `.github/workflows/deploy-dev.yml` | env switch for the dev store |
| `packages/credentagent-gate/README.md` | document the receipt |
| **(website)** `index.html`, `tests/demo.test.mjs` | receipt proof rows |

---

### Task 1: `ProofEntry` + helpers

**Files:** Create `packages/credentagent-gate/src/ceremony/proofs.ts`; Test `packages/credentagent-gate/src/ceremony/proofs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// proofs.test.ts
import { describe, it, expect } from "vitest";
import { upsertProof, withoutPresentations, type ProofEntry } from "./proofs.js";

const entry = (gate: string, extra: Partial<ProofEntry> = {}): ProofEntry => ({
  gate, rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "2026-09-27T00:00:00.000Z", ...extra,
});

describe("proof helpers", () => {
  it("upsertProof appends, and re-proving a gate replaces its entry", () => {
    const a = upsertProof(undefined, entry("Age 21+"));
    const b = upsertProof(a, entry("Membership"));
    const c = upsertProof(b, entry("Age 21+", { rail: "instant-demo" }));
    expect(c.map((p) => [p.gate, p.rail])).toEqual([["Membership", "credential"], ["Age 21+", "instant-demo"]]);
  });

  it("withoutPresentations drops the credential bytes and keeps everything else", () => {
    const p = entry("Age 21+", { presentation: { format: "mso_mdoc", deviceResponse: "RAW", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#RAW" } });
    expect(withoutPresentations([p])).toEqual([entry("Age 21+")]);
    expect(withoutPresentations(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2:** Run `npx vitest run packages/credentagent-gate/src/ceremony/proofs.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// proofs.ts — what the gate proved for an order, kept WITH the order (per order id, never
// process-global — invariant 4) so it survives completion and can be shown afterwards.
// Each entry states its OWN trust_level; nothing here upgrades trust.
import type { TrustLevel } from "../types.js";
import type { InspectablePresentation } from "./inspect.js";

export type ProofRail = "credential" | "dc-payment" | "passkey" | "instant-demo";

export interface ProofEntry {
  /** Buyer-facing label, e.g. "Age 21+", "Membership", "Pay (USD)". One entry per gate. */
  gate: string;
  /** How it was proven — "instant-demo" means no wallet was involved. */
  rail: ProofRail;
  trust_level: TrustLevel;
  /** What the gate checked, as the rail reported it. */
  checks: { gate: string; pass: boolean; detail: string }[];
  presentedAt: string;
  /** The wallet's DeviceResponse + inspector link — only with `inspectPresentations` on. */
  presentation?: InspectablePresentation;
}

/** Add `entry`, replacing an earlier proof of the SAME gate (re-proving never piles up). */
export function upsertProof(proofs: readonly ProofEntry[] | undefined, entry: ProofEntry): ProofEntry[] {
  return [...(proofs ?? []).filter((p) => p.gate !== entry.gate), entry];
}

/** The proofs without credential bytes — for payloads that leave the store (webhooks). */
export function withoutPresentations(proofs: readonly ProofEntry[] | undefined): ProofEntry[] | undefined {
  return proofs?.map(({ presentation: _drop, ...rest }) => rest);
}
```

- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git add packages/credentagent-gate/src/ceremony/proofs.ts packages/credentagent-gate/src/ceremony/proofs.test.ts && git commit -s -m "feat(gate): ProofEntry + helpers"`

---

### Task 2: carry proofs through `completeOrder`

**Files:** Modify `src/types.ts` (VerificationRecord), `src/ceremony/types.ts` (CompletionInput), `src/ceremony/completion.ts`; Test `proofs.test.ts`

- [ ] **Step 1: Failing test** (append to `proofs.test.ts`)

```ts
import { completeOrder, type CompletedRecord } from "./completion.js";
import { MemoryVerificationStore } from "../store.js";
import type { CeremonyCatalog } from "./types.js";

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 10, currency: "USD", quantity: it.quantity, lineTotal: 10 * it.quantity }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

describe("completeOrder keeps the proofs", () => {
  it("copies the order's credential proofs + the payment proof into the completed record, then clears verification", async () => {
    const verificationStore = new MemoryVerificationStore();
    await verificationStore.write("O1", { proofs: [entry("Membership")] });
    const records = new Map<string, CompletedRecord>();
    const order = catalog.createOrder([{ productId: "mug", quantity: 1 }], "O1");
    const out = await completeOrder(
      { order, mandateId: "m1", amount: 10, currency: "USD", method: "dc-payment", gates: [], proof: entry("Pay (USD)", { rail: "dc-payment" }) },
      { catalog, verificationStore, records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } },
    );
    expect(out.completed).toBe(true);
    expect(records.get("O1")?.proofs?.map((p) => p.gate)).toEqual(["Membership", "Pay (USD)"]);
    expect(await verificationStore.read("O1")).toBeUndefined();
  });

  it("writes no proofs field when nothing was proven", async () => {
    const records = new Map<string, CompletedRecord>();
    const order = catalog.createOrder([{ productId: "mug", quantity: 1 }], "O2");
    await completeOrder({ order, mandateId: "m", amount: 10, currency: "USD", method: "passkey", gates: [] },
      { catalog, verificationStore: new MemoryVerificationStore(), records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } });
    expect(records.get("O2")).not.toHaveProperty("proofs");
  });
});
```

- [ ] **Step 2:** Run → FAIL (type error / `proofs` undefined).

- [ ] **Step 3: Implement**

`src/types.ts`, in `VerificationRecord` after `verifiedGates`:
```ts
  /** What was proven for THIS order so far (credential rail) — copied onto the completed
   *  record by `completeOrder`, so the proof outlives this record (order proof receipt). */
  proofs?: import("./ceremony/proofs.js").ProofEntry[];
```

`src/ceremony/types.ts`, in `CompletionInput` after `trustLevel`:
```ts
  /** The payment rail's own proof (order proof receipt) — appended after the order's
   *  credential proofs on the completed record. Absent ⇒ only those are kept. */
  proof?: import("./proofs.js").ProofEntry;
```

`src/ceremony/completion.ts`: add to `CompletedRecord` after `trustLevel`:
```ts
  /** What was proven for this order (credential proofs, then the payment's) — each with its
   *  own trust_level. Absent on records written before the proof receipt. */
  proofs?: ProofEntry[];
```
import `import type { ProofEntry } from "./proofs.js";` and, right after `const verification = await ctx.verificationStore.read(input.order.id);` (line ~201):
```ts
  // The order proof receipt: every proof made for this order, kept on the completed record
  // (the verification record is cleared below). Payment's own proof goes last.
  const proofs = [...((verification as { proofs?: ProofEntry[] } | undefined)?.proofs ?? []), ...(input.proof ? [input.proof] : [])];
  const proofField = proofs.length ? { proofs } : {};
```
Then add `...proofField,` to BOTH `ctx.records.write({...})` calls (the delegated-draw one and the final one).

- [ ] **Step 4:** Run the file → PASS; run `npx vitest run packages/credentagent-gate/src/ceremony/completion.test.ts` → still PASS.
- [ ] **Step 5:** Commit `feat(gate): completeOrder keeps the order's proofs` (with `-s`).

---

### Task 3: the credential rail records its proof

**Files:** Modify `src/ceremony/credential-gate/routes.ts`; Test `proofs.test.ts`

- [ ] **Step 1: Failing test** — an express harness served on ONE port (so origin-bound gates agree across requests):

```ts
import express from "express";
import http from "node:http";
import request from "supertest";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";
import { mountCeremony } from "./mount.js";
import { INSPECTOR_URL } from "./inspect.js";

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
function ageDeviceResponse(): string {
  const isi = enc.encode({ digestID: 0, random: Buffer.alloc(16), elementIdentifier: "age_over_21", elementValue: true });
  return Buffer.from(enc.encode({ version: "1.0", documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: { "org.iso.18013.5.1": [new Tag(isi, 24)] } } }], status: 0 })).toString("base64url");
}
const ageCatalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 124, currency: "USD", quantity: it.quantity, lineTotal: 124 * it.quantity, minimumAge: 21 }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

function storeHarness(inspectPresentations: boolean) {
  const verificationStore = new MemoryVerificationStore();
  const records = new Map<string, CompletedRecord>();
  const orders = new Map([["W1", ageCatalog.createOrder([{ productId: "whiskey", quantity: 1 }], "W1")], ["W2", ageCatalog.createOrder([{ productId: "whiskey", quantity: 1 }], "W2")]]);
  const app = express();
  mountCeremony(app as never, {
    verificationStore, catalog: ageCatalog, signingKey: "stable-test-secret", inspectPresentations,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    completion: (input) => completeOrder(input, { catalog: ageCatalog, verificationStore, records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } }),
    completedOrders: { read: (id) => records.get(id) },
  });
  const server = http.createServer(app);
  return { server, verificationStore, records };
}

async function proveAge(server: http.Server, order: string) {
  const rd = (await request(server).get(`/credentagent/credential/request?order=${order}&cred=age`)).body;
  const signed = rd.requests.find((r: { protocol: string }) => r.protocol === "openid4vp-v1-signed");
  const jwk = (jose.decodeJwt(signed.data.request) as { client_metadata: { jwks: { keys: jose.JWK[] } } }).client_metadata.jwks.keys[0];
  const dr = ageDeviceResponse();
  const response = await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: { mdl: [dr] } })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" }).encrypt(await jose.importJWK(jwk, "ECDH-ES"));
  await request(server).post("/credentagent/credential/verify").send({ order, cred: "age", readerContextToken: rd.readerContextToken, result: { protocol: "openid4vp-v1-signed", data: { response } } });
  return dr;
}

describe("the credential rail records its proof on the order", () => {
  it("a wallet proof is kept with its presentation when inspectPresentations is on — and only on THAT order", async () => {
    const h = storeHarness(true);
    const dr = await proveAge(h.server, "W1");
    const [p] = (await h.verificationStore.read("W1"))!.proofs!;
    expect(p).toMatchObject({ gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", presentation: { deviceResponse: dr, inspectUrl: `${INSPECTOR_URL}#${dr}` } });
    expect(await h.verificationStore.read("W2")).toBeUndefined(); // invariant 4: no cross-order bleed
  });

  it("without the flag the proof is kept but carries no credential bytes", async () => {
    const h = storeHarness(false);
    await proveAge(h.server, "W1");
    expect((await h.verificationStore.read("W1"))!.proofs![0]).not.toHaveProperty("presentation");
  });

  it("the instant demo is recorded as instant-demo, never as a wallet proof", async () => {
    const h = storeHarness(true);
    await request(h.server).post("/credentagent/credential/verify").send({ order: "W1", cred: "age", claims: { age_over_21: true } });
    const [p] = (await h.verificationStore.read("W1"))!.proofs!;
    expect(p.rail).toBe("instant-demo");
    expect(p).not.toHaveProperty("presentation");
  });
});
```

(`storeHarness` passes `completedOrders`, which Task 5 adds to `CeremonySeams`; until then add `// @ts-expect-error — added in Task 5` above that line, and remove it in Task 5.)

- [ ] **Step 2:** Run → FAIL (`proofs` undefined).

- [ ] **Step 3: Implement** in `credential-gate/routes.ts`:
  - import `import { upsertProof, type ProofEntry } from "../proofs.js";` and add `presentationForInspection` to the `../inspect.js` import.
  - change `recordVerified(ctx, orderId, kind, membershipNumber)` → add a `proof: ProofEntry` param and write `proofs: upsertProof(prev.proofs, proof)` into both branches' records; same for `recordVerifiedGate(ctx, orderId, credId, proof)`.
  - in the verify handler, before `if (out.verified)`:
```ts
      // The order proof receipt (spec 2026-09-27): what this gate proved, kept with the order.
      const proof: ProofEntry = {
        gate: credential ? credential.ui.label : kind === "age" ? `Age ${minimumAge}+` : "Membership",
        rail: result && typeof result === "object" ? "credential" : "instant-demo",
        trust_level: out.trust_level,
        checks: out.gates,
        presentedAt: new Date().toISOString(),
        ...(ctx.inspectPresentations && out.deviceResponse ? { presentation: presentationForInspection(out.deviceResponse) } : {}),
      };
```
    and pass `proof` to `recordVerifiedGate` / `recordVerified`.

- [ ] **Step 4:** Run → PASS; run `npx vitest run packages/credentagent-gate/src/ceremony/credential-gate` → PASS.
- [ ] **Step 5:** Commit `feat(gate): the credential rail records its proof on the order`.

---

### Task 4: payment rails pass their proof

**Files:** Modify `src/ceremony/dc-payment/routes.ts`, `src/ceremony/passkey/routes.ts`; Test `proofs.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe("payment rails add their proof", () => {
  it("age wallet proof + instant-demo payment → the completed record lists both, in order", async () => {
    const h = storeHarness(true);
    await proveAge(h.server, "W1");
    const pay = await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" } });
    expect(pay.body.completed).toBe(true);
    const proofs = h.records.get("W1")!.proofs!;
    expect(proofs.map((p) => [p.gate, p.rail])).toEqual([["Age 21+", "credential"], ["Pay (USD)", "instant-demo"]]);
    expect(proofs[1]).not.toHaveProperty("presentation");
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement**
  - `dc-payment/routes.ts`: track `const real = !!(result && typeof result === "object")` (hoist `result` above the `try`), and add to the `CompletionInput`:
```ts
      proof: {
        gate: `Pay (${mandate.payment.currency})`,
        rail: real ? "dc-payment" : "instant-demo",
        trust_level: mandate.trust_level,
        checks: gates,
        presentedAt: new Date().toISOString(),
        ...(presentation.presentation ? { presentation: presentation.presentation } : {}),
      },
```
    (move the existing `const presentation = …` line above the `input` object).
  - `passkey/routes.ts`: add to the `ctx.completion({...})` call:
```ts
        proof: { gate: `Pay (${mandate.payment.currency})`, rail: "passkey", trust_level: "presence-only-demo", checks: gates.map((g) => ({ gate: g.gate, pass: g.pass, detail: g.detail })), presentedAt: new Date().toISOString() },
```

- [ ] **Step 4:** Run the file + `npx vitest run packages/credentagent-gate/src/ceremony` → PASS.
- [ ] **Step 5:** Commit `feat(gate): payment rails add their proof to the order`.

---

### Task 5: `GET /credentagent/orders/:id/proof` + the `completedOrders` seam

**Files:** Create `src/ceremony/proof-route.ts`; Modify `src/ceremony/mount.ts`; Test `proofs.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe("GET /credentagent/orders/:id/proof", () => {
  it("returns a completed order's proofs", async () => {
    const h = storeHarness(true);
    await proveAge(h.server, "W1");
    await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" } });
    const res = await request(h.server).get("/credentagent/orders/W1/proof");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.proofs.map((p: ProofEntry) => p.gate)).toEqual(["Age 21+", "Pay (USD)"]);
  });

  it("returns the proofs so far for an order that hasn't completed", async () => {
    const h = storeHarness(false);
    await proveAge(h.server, "W1");
    const res = await request(h.server).get("/credentagent/orders/W1/proof");
    expect(res.body).toMatchObject({ orderId: "W1", status: "pending", proofs: [{ gate: "Age 21+" }] });
  });

  it("404s an order it has never seen", async () => {
    const res = await request(storeHarness(false).server).get("/credentagent/orders/NOPE/proof");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2:** Run → FAIL (404 for all).

- [ ] **Step 3: Implement**

`proof-route.ts`:
```ts
// GET /credentagent/orders/:id/proof — the order proof receipt: what the gate proved for an
// order (spec 2026-09-27). Completed orders answer from the completed record (via the optional
// `completedOrders` seam); unfinished ones from the per-order verification record. Readable by
// anyone with the order id, like the store's order-status. Credential bytes appear only when the
// store set `inspectPresentations` — they were never stored otherwise.
import type { CeremonyApp, CeremonyContext, RailRegistrar } from "./mount.js";
import type { ProofEntry } from "./proofs.js";

interface ProofRequest { params: Record<string, string> }
interface ProofResponse { status(code: number): ProofResponse; json(body: unknown): unknown }

export const registerProofRoute: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  const get = app.get?.bind(app) as ((path: string, h: (req: ProofRequest, res: ProofResponse) => Promise<void>) => unknown) | undefined;
  if (!get) return;
  get("/credentagent/orders/:id/proof", async (req, res) => {
    const orderId = req.params.id ?? "";
    const done = ctx.completedOrders ? await ctx.completedOrders.read(orderId) : undefined;
    if (done) { res.json({ orderId, status: "completed", proofs: done.proofs ?? [] }); return; }
    const pending = (await ctx.verificationStore.read(orderId))?.proofs as ProofEntry[] | undefined;
    if (pending?.length) { res.json({ orderId, status: "pending", proofs: pending }); return; }
    res.status(404).json({ error: "order not found" });
  });
};
```

`mount.ts`:
  - `CeremonySeams` + `CeremonyContext` gain
```ts
  /** Read-only view of completed orders, for the order proof receipt route. Absent ⇒ the
   *  route answers only for unfinished orders (from the verification record). */
  completedOrders?: { read(orderId: string): { proofs?: import("./proofs.js").ProofEntry[] } | null | undefined | Promise<{ proofs?: import("./proofs.js").ProofEntry[] } | null | undefined> };
```
  - resolve `const completedOrders = options.completedOrders ?? locals.completedOrders;` and add `...(completedOrders ? { completedOrders } : {})` to `ctx`.
  - import `registerProofRoute` and append it to `RAILS`.
  - Remove the `@ts-expect-error` added in Task 3.

- [ ] **Step 4:** Run the file + full gate suite → PASS.
- [ ] **Step 5:** Commit `feat(gate): GET /credentagent/orders/:id/proof`.

---

### Task 6: wire the seam in both hosts; keep bytes out of webhooks

**Files:** Modify `src/orders.ts`, `src/orders-serve.ts`, `src/client.ts` (none if not needed), `src/index.ts`, `packages/credentagent-storefront/src/server.ts`; Test `packages/credentagent-gate/src/orders-serve.test.ts` (append) and `proofs.test.ts`

- [ ] **Step 1: Failing tests**

In `orders-serve.test.ts` (reuse that file's existing harness that completes an order with an instant-demo payment and captures delivered webhooks — find its helper at the top of the file), append:
```ts
it("the completed order keeps its proofs, and the order.settled webhook never carries credential bytes", async () => {
  // Arrange with the file's harness, completing an order via the instant-demo dc-payment path.
  // Assert: (await credentagent.orders.retrieve(id)).proofs has a "Pay (USD)" entry with rail "instant-demo",
  // and every delivered webhook payload's data.object.proofs entries have no `presentation` key.
});
```
Write it concretely against that harness's actual helper names (read the top ~60 lines of `orders-serve.test.ts` first).

In `proofs.test.ts`:
```ts
import { withoutPresentations as strip } from "./proofs.js";
it("strip keeps the receipt usable (gate, rail, trust_level, checks)", () => {
  const p = entry("Age 21+", { presentation: { format: "mso_mdoc", deviceResponse: "X", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#X" } });
  expect(Object.keys(strip([p])![0]).sort()).toEqual(["checks", "gate", "presentedAt", "rail", "trust_level"]);
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement**
  - `orders.ts`: `CompletedOrder` gains `proofs?: import("./ceremony/proofs.js").ProofEntry[];`. In `_complete`, deliver `this.deps.deliverWebhook?.("order.settled", { ...record, ...(record.proofs ? { proofs: withoutPresentations(record.proofs) } : {}) });` (import `withoutPresentations`). Comment: the webhook goes to another service — never the credential bytes.
  - `orders-serve.ts`: in `records.write`, add `...(record.proofs?.length ? { proofs: record.proofs } : {}),`; in `records.read` pass `proofs` through too. Pass `completedOrders: { read: async (id) => (await deps.completed.read(id)) ?? undefined }` into `mountCeremony`.
  - `index.ts`: `export type { ProofEntry, ProofRail } from "./ceremony/proofs.js";`
  - storefront `server.ts`: `CompletedOrderRecord` gains `proofs?: import("@openmobilehub/credentagent-gate").ProofEntry[];` (or a structural copy if the storefront avoids the type import — match how it imports other gate types at the top of the file). In `app.locals.credentagent = { … }` add `completedOrders: { read: (id: string) => orderStore.read(id) },`.

- [ ] **Step 4:** `npm run build && npm test` (root) → PASS.
- [ ] **Step 5:** Commit `feat: proofs reach orders.retrieve + the storefront; webhooks never carry credential bytes`.

---

### Task 7: widget proof rows

**Files:** Create `packages/credentagent-storefront/src/ui/ProofRows.tsx`, `packages/credentagent-storefront/src/ui/proof-rows.test.tsx`; Modify `ui/app.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofRows, type WidgetProof } from "./ProofRows";

const url = "https://tools.multipaz.org/mdocDeviceResponse#o2d2";
const proofs: WidgetProof[] = [
  { gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", presentation: { inspectUrl: url } },
  { gate: "Pay (USD)", rail: "instant-demo", trust_level: "presence-only-demo" },
];

describe("ProofRows", () => {
  it("lists each proof with its trust level and links only a wallet proof to the inspector", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={proofs} />);
    expect(html).toContain("Age 21+");
    expect(html).toContain("presence-only-demo");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("Inspect");
    expect(html).toContain("instant demo");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("never links a non-Multipaz URL", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={[{ ...proofs[0], presentation: { inspectUrl: "javascript:alert(1)" } }]} />);
    expect(html).not.toContain("<a ");
  });

  it("renders nothing without proofs", () => {
    expect(renderToStaticMarkup(<ProofRows proofs={undefined} />)).toBe("");
  });
});
```

- [ ] **Step 2:** `npx vitest run packages/credentagent-storefront/src/ui/proof-rows.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `ProofRows.tsx`:
```tsx
// The confirmed order's proofs — one row per gate, e.g. "✓ Age 21+ · presence-only-demo ·
// Inspect ↗". The link (Multipaz Tools, decoded in the browser) shows only for a wallet proof
// the store kept bytes for; an instant-demo proof says so and never links.
import styles from "./app.module.css";

const INSPECTOR = "https://tools.multipaz.org/mdocDeviceResponse#";

export interface WidgetProof {
  gate: string;
  rail: string;
  trust_level: string;
  presentation?: { inspectUrl?: string };
}

export function ProofRows({ proofs, openLink }: { proofs?: WidgetProof[]; openLink?: (url: string) => unknown }) {
  if (!proofs?.length) return null;
  return (
    <>
      {proofs.map((p) => {
        const url = p.presentation?.inspectUrl;
        const linkable = typeof url === "string" && url.startsWith(INSPECTOR);
        return (
          <div className={styles.confirmRow} key={p.gate}>
            <dt>{p.gate}</dt>
            <dd>
              ✓ {p.rail === "instant-demo" ? "instant demo" : p.trust_level}
              {linkable && (
                <>
                  {" · "}
                  <a
                    href={url}
                    onClick={(e) => {
                      // Sandboxed iframe: route through the host bridge like the checkout link.
                      e.preventDefault();
                      if (openLink) void openLink(url!);
                      else window.open(url, "_blank", "noopener");
                    }}
                  >
                    Inspect ↗
                  </a>
                </>
              )}
            </dd>
          </div>
        );
      })}
    </>
  );
}
```
In `app.tsx`: add `proofs?: WidgetProof[];` to the `CompletedOrder` type, import `ProofRows`, and render `<ProofRows proofs={confirmedOrder.proofs} openLink={openLink} />` inside `<dl className={styles.confirmFields}>` right after the Payment row.

- [ ] **Step 4:** Run the test + `npm run build` (vite bundles the widget) → PASS.
- [ ] **Step 5:** Commit `feat(storefront): the confirmed-order card lists the order's proofs`.

---

### Task 8: dev-store switch + docs, then verify and open the PR

**Files:** Modify `examples/quickstart/server.mjs`, `.github/workflows/deploy-dev.yml`, `packages/credentagent-gate/README.md`

- [ ] **Step 1:** `examples/quickstart/server.mjs` — change the constructor to:
```js
const credentagent = new CredentAgent({
  walletOrigin, catalog: grantCatalog, ...(readerIdentity ? { readerIdentity } : {}),
  // Demo/dev only: expose the wallet's credential for inspection (never with real IDs).
  inspectPresentations: process.env.CREDENTAGENT_INSPECT_PRESENTATIONS === "1",
});
```
- [ ] **Step 2:** `.github/workflows/deploy-dev.yml` — append ` --env CREDENTAGENT_INSPECT_PRESENTATIONS=1` to the `vercel deploy` line (next to `--env CREDENTAGENT_BUILD=…`).
- [ ] **Step 3:** README — under "Inspecting what the wallet sent", add a subsection **"The order's proof receipt"**: `GET /credentagent/orders/:id/proof` example response; the proofs also ride on `orders.retrieve()`, `get-order-status`, and the storefront widget; webhooks never carry the bytes; readable by anyone with the order id; instant-demo proofs are labelled.
- [ ] **Step 4:** `npm run build && npm run lint && npm test` (root) → all green. Smoke the quickstart: `npm --prefix examples/quickstart run smoke` if it runs against the workspace build; otherwise note it.
- [ ] **Step 5:** Commit `docs + dev store: order proof receipt`, push `feat/order-proof-receipt`, open a PR with base `feat/inspect-presentation` (stacked), description per `.github/pull_request_template.md`.

---

### Task 9 (website): receipt proof rows

**Files (website):** Modify `index.html` (`doneSummary`, ~line 1416), `tests/demo.test.mjs`

- [ ] **Step 1: Failing test** (append to `tests/demo.test.mjs`)

```js
test('doneSummary lists the order’s proofs and links a wallet proof to the inspector', () => {
  const url = 'https://tools.multipaz.org/mdocDeviceResponse#o2d2';
  const order = { orderId: 'O', amount: 124, currency: 'USD', method: 'dc-payment', proofs: [
    { gate: 'Age 21+', rail: 'credential', trust_level: 'presence-only-demo', presentation: { inspectUrl: url } },
    { gate: 'Membership', rail: 'instant-demo', trust_level: 'presence-only-demo' },
    { gate: 'Pay (USD)', rail: 'dc-payment', trust_level: 'presence-only-demo' },
  ] };
  const rows = plain(D.doneSummary(order, { gated: true, ageLabel: 'Age 21+', total: 124 })).rows;
  assert.deepEqual(rows.find((r) => r.k === 'Age 21+'), { k: 'Age 21+', v: '✓ proven · inspect', href: url });
  assert.deepEqual(rows.find((r) => r.k === 'Membership'), { k: 'Membership', v: '✓ instant demo' });
  assert.equal(rows.filter((r) => r.k === 'Pay (USD)').length, 0); // payment stays in "Paid with"
  // A non-Multipaz link is never rendered.
  const bad = plain(D.doneSummary({ proofs: [{ gate: 'Age 21+', rail: 'credential', presentation: { inspectUrl: 'javascript:x' } }] }, {})).rows;
  assert.deepEqual(bad.find((r) => r.k === 'Age 21+'), { k: 'Age 21+', v: '✓ proven' });
});
```
- [ ] **Step 2:** `node --test "tests/*.test.mjs"` → FAIL.
- [ ] **Step 3: Implement** in `doneSummary`, replace `if (checkout.gated) rows.push({ k: checkout.ageLabel || 'Age', v: '✓ proven' });` with:
```js
    // The order's proof receipt (library 2026-09-27): one row per credential proof, linking a
    // wallet proof to Multipaz Tools when the store kept it. Payment proofs stay in "Paid with".
    var INSPECT = 'https://tools.multipaz.org/mdocDeviceResponse#';
    var proofs = Array.isArray(order.proofs) ? order.proofs.filter(function (p) { return p && p.rail !== 'dc-payment' && p.rail !== 'passkey' && !/^Pay\b/.test(p.gate); }) : [];
    if (proofs.length) {
      proofs.forEach(function (p) {
        var url = p.presentation && typeof p.presentation.inspectUrl === 'string' && p.presentation.inspectUrl.indexOf(INSPECT) === 0 ? p.presentation.inspectUrl : null;
        var row = { k: String(p.gate), v: p.rail === 'instant-demo' ? '✓ instant demo' : url ? '✓ proven · inspect' : '✓ proven' };
        if (url) row.href = url;
        rows.push(row);
      });
    } else if (checkout.gated) rows.push({ k: checkout.ageLabel || 'Age', v: '✓ proven' });
```
- [ ] **Step 4:** `node --test "tests/*.test.mjs"` → PASS; self-contained grep → 0.
- [ ] **Step 5:** Commit (`-s`), push a branch, open a website PR noting it goes live when the library PR merges (the demo uses `/marketplace-dev`).
