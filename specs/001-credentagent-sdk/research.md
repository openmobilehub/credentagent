# Phase 0 — Research & Decisions: Attesto SDK v0.1

The spec (`spec.md`) and the resolved §8 decisions already settle most choices. This records the design
decisions the implementation rests on. No open `NEEDS CLARIFICATION` remain (the one spec `[clarify]` —
v0.1 custom-credential scope — is resolved here as decision 6).

## 1. Credential builders — chained, typed

**Decision**: Built-ins are factory objects exposing chainable, typed methods: `age.over(21)`,
`membership.discount(10)`, `payment.in("usd")`, each returning a `Credential` carrying an `effect`. A
`.when((order) => boolean)` method on any credential attaches a conditional predicate.

**Rationale**: Mirrors Zod's "chaining is the spec" and Stripe's typed params — autocomplete teaches the
API, and an age gate that sets a currency is a compile error (Principle I). The threshold/percent/currency
live on the builder, not in a separate options bag.

**Alternatives rejected**: stringly-typed `require("age", {min:21})` (no compile-time safety, shadows
CommonJS `require`); a separate `deps` object of callbacks (the rejected v0-overnight shape).

## 2. `requirements()` is the code→data boundary

**Decision**: `attesto.requirements(order, policy)` runs each credential's `.when()`/`appliesTo` predicate
and `effect`, drops gates that don't apply, orders them (payment last), and returns a **flat plain-data
manifest**: `Array<{ credential, required, effect, label, minAge?, discountPct? }>`. No functions, no
`verify`, no `dcql` closures in the output.

**Rationale**: `structuredContent` is serialized to the agent + widget (Principle VI). The resolver is the
single place policy code becomes wire data; a contract test asserts `JSON.stringify(manifest)` round-trips.

**Alternatives rejected**: returning the policy objects (carry functions → not serializable); building the
manifest in the tool handler (duplicates resolution, leaks the payment-last invariant to the caller).

## 3. `mount(app)` owns the ceremony + the store

**Decision**: `attesto.mount(app)` mounts the `/credential-gate/*` routes (page → `/request` → `/verify`)
and instantiates the per-order verification store (default in-memory; pluggable). For v0.1 this **wraps the
demo's existing `payment-gate/credential-gate` + `verificationStore.ts`** rather than reimplementing the
OpenID4VP/mdoc ceremony.

**Rationale**: Keeps the real, tested, fail-closed verifier (`verify.ts` — explicit positive claim, nonce
binding) intact (Security invariant) and avoids re-deriving crypto. `walletOrigin + order.id` derives the
per-order approve link.

**Alternatives rejected**: reimplementing the ceremony in the package (risk to the one genuinely-real
asset); requiring the developer to pass `isAgeUnverified`/`approveUrl` callbacks (Principle I violation).

## 4. Backward-compatibility with the overnight package

**Decision**: KEPT verbatim — `buildVerificationRequired`, `isVerificationRequired`, `ageDcql`,
`TrustLevel`, `VerificationRequired` (the Mode-B/roadmap primitive). REDEFINED — `Step` becomes
`{ credential: Credential (object); required }` (was string-based); the legacy shape is removed, not
aliased. REMOVED — `requireCredential`/`optionalCredential` (string-based) → replaced by
`required(c)`/`optional(c)` (type-incompatible, so a clean break since the package is 0.x). `gated()`
becomes a thin deprecated shim for one minor version.

**Rationale**: The envelope's `verification_required` **wire shape** must not break (Principle VI). That
assertion lives in a dedicated **envelope test** (`packages/attesto-gate/src/envelope.test.ts`) — separate
from the new consolidated-tool test (`checkout-gate.test.ts`), which asserts the **`requires` manifest**.
The two shapes (envelope vs manifest) are different and tested independently.

## 5. Demo consumes the package via workspaces (already wired)

**Decision**: `server.ts`'s checkout tool builds the order (`createOrderForCheckout`) and calls
`attesto.requirements(order, policy)`; `app.ts` calls `attesto.mount(app)`. The npm-workspaces build
(`build:packages` → typecheck → ui → server) already resolves the package and is Vercel-safe (verified
earlier). No build-pipeline change.

**Rationale**: Brownfield constraint — the live deploy stays green; `npm run build` + the in-memory MCP
bypass test are the gates.

## 6. v0.1 custom-credential scope (resolves the spec `[clarify]`)

**Decision**: Ship the three built-ins + `defineCredential` + the generic resolver, with **one worked
custom example: a `prescription` gate** (`effect: gate()`, `appliesTo` Rx lines) proving the extension
point. `gate()` and `authorize()` effects are fully enforced; **arbitrary `discount()` percentages stay
bounded** by the engine's discount reconciliation (currently 0-or-10%, `mandate.ts` Gate 1) — generalizing
that is roadmap (Security invariant: discounts reconcile with amount binding).

**Rationale**: Delivers the "gate any credential" promise (Principle V) without writing a check the payment
engine can't cash (Security invariant 3 / Principle VII prefer-simplicity).

## 7. Effects as tagged data

**Decision**: `gate()`, `discount({percent})`, `authorize()` return small tagged objects the resolver
interprets (`{ kind: "gate" }` etc.), not handlers. `onProven` escape hatch deferred to roadmap.

**Rationale**: Keeps effects serializable-describable in the manifest and lets the resolver enforce
payment-last + amount-binding centrally (Principle IV).
