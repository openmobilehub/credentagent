# Architecture & DX principles

> **North star:** a library that is **friendly to a beginner in the first five minutes** and **not
> in the way of an expert on day thirty** — Stripe-grade developer experience, applied to a consent
> gate. Two properties above all: **user-friendly** (easy to reach a correct result) and
> **extensible** (grow it without forking it).
>
> **How to use this doc.** It is a **binding review rubric**, not prose to admire — `CLAUDE.md` elevates it
> to a required review lens at the same tier as the security invariants: a PR that regresses a principle is a
> **request-changes**, and the automated PR review checks it. When we design or review, we grade work against
> these principles. It is also a **living doc** — the maintainer edits it to encode taste; Claude mirrors its
> essence into memory so it persists across sessions. Where the codebase already embodies a principle, it's
> cited (learn from ourselves); where it doesn't yet, it's in **Open gaps** at the end (the rubric with teeth).

## The exemplars (what we steal from)

| Library | The one thing to steal |
| :-- | :-- |
| **Stripe** | *Progressive disclosure* + relentless **consistency** across resources; typed, actionable errors; `metadata`/`expand` escape hatches; idempotency keys; test-mode parity; the quickstart is sacred. |
| **Zod** | **Parse, don't validate** — types carry proof. The **two doors**: `.parse()` (throw) vs `.safeParse()` (result). Composable, inference-first (`z.infer`). |
| **React** | **Composition over configuration**; declarative; small primitives + escape hatches (`ref`, effects); predictable constraints (Rules of Hooks). |
| **Prisma / tRPC** | **Types are the contract** — generated/inferred end-to-end; you can't call it wrong. |
| **Express / Koa** | **Middleware pipeline** — a composable, orderable seam; the app is what you compose, not what you configure. |
| **date-fns** | **Small pure functions, tree-shakeable, immutable** — import only what you use; no hidden state. |
| **Playwright** | **Design out whole classes of error** (auto-waiting); errors that teach; first-class observability (trace viewer). |
| **Next / Vercel** | **Zero-config default, escape hatch for everything** — convention over configuration, but never magic you can't see through. |

## The principles

### 1. Simple by default, powerful by disclosure
Minimal required surface; power is opt-in and layered, never a wall. A beginner copies three lines;
an expert reaches for the option they need exactly when they need it.
- **Exemplar:** `stripe.charges.create({ amount, currency, source })` works; 30 optional fields wait quietly.
- **Here:** success bars are stated as contracts — **≤3 added lines** to accept a gate, the storefront
  **ships it built-in** (`delegation: true` → tools appear), a **15-minute quickstart**, and
  `mount(app)` **zero-arg compose** (reads seams off `app.locals`). Keep those sacred.
- **Push further:** every new option must have a sensible default; adding a feature must not add a
  required argument to an existing call.

### 2. Consistency is the feature
Same shapes, same verbs, same patterns everywhere. Learn one rail, know them all. Predictability *is*
learnability — surprise is the tax.
- **Exemplar:** every Stripe resource has `create / retrieve / update / list / del`. One mental model.
- **Here:** each ceremony rail mirrors the same layout (`dcql`/`request`/`verify`/`page`/`routes`);
  a new rail **mirrors** it, never bolts onto an existing one. The typed-refusal vocabulary is shared
  across surfaces.
- **Push further:** one way to do a thing. (See Open gap: `resolveOrder` is called seven ways; error
  handling has two inconsistent "doors".)

### 3. Parse, don't validate — make illegal states unrepresentable
Validate once at the boundary and return a *typed* value that carries the proof; downstream code
receives a thing that *cannot* be malformed. Types replace defensive checks.
- **Exemplar:** Zod `schema.parse(input)` → a typed, guaranteed value.
- **Here:** honesty lives in the **types** (`trust_level`, `presence`), not comments; `verifyCartMandate`
  returns a `CartMandateVerdict` (`{ ok:true, mandate }` — a *verified* mandate you can trust — or
  `{ ok:false, reason }`).
- **Push further:** prefer discriminated unions over optional-bags; a function that returns a "verified
  X" type should be the *only* way to obtain one.

### 4. Errors are typed, actionable data — not thrown strings
Every failure is a value you can program against: a stable `code`/`reason`, a human message, and —
ideally — how to fix it. Pick **one door** and hold it: result-returning *or* throwing, consistently.
- **Exemplar:** Stripe errors carry `type`, `code`, `param`, `message`, doc link. Zod's two doors are
  *deliberate and symmetric* (`parse` throws, `safeParse` returns).
- **Here:** typed refusals are a genuine strength — `CartMandateRefusal` (`malformed|signature|order-id|expired`),
  `CompletionResult.reason` (`gates|cart-mandate|reprice|reconcile|age`), the `verification_required`
  envelope with an `approve_url` the agent can act on. A slow buyer sees `expired`, not `tampered`.
- **Push further:** every refusal should be *actionable* (what unblocks it), and the codebase should
  choose one error door. (Open gap: `verifyCartMandate` returns a verdict but `verifyChallenge` throws.)

### 5. Extend by composition and escape hatches — never by forking
The core stays closed to modification but open to extension. Users add capability through defined
seams, not by editing the library.
- **Exemplar:** Stripe `metadata` (attach anything) + `expand` (pull related data); Express middleware.
- **Here:** `defineCredential({ id, request, verify, effect, appliesTo?, ui })` lets a host gate *any*
  credential without touching the gate; effects (`gate()`/`discount()`/`authorize()`) compose.
- **Push further:** when a user has to fork to do X, X wants to become an injected seam or a `defineX`.

### 6. Depend on ports, not implementations (hexagonal core)
The core imports interfaces, not frameworks. Everything concrete is injected and swappable; the
package can be tested and reasoned about without a web server, a DB, or a clock.
- **Exemplar:** the ports-and-adapters pattern; date-fns taking values, not globals.
- **Here:** the gate never imports Express — it talks to structural ports (`orderStore`, `catalog`,
  `completion`, `CeremonyApp`); stores are injectable (`MemoryVerificationStore` default; a shared store
  for multi-instance). `mount()` **fails fast** on a missing required seam (never silently degrades).
- **Push further:** any new `Date.now()`, `process.env`, or hard import in the core is a smell — inject it.

### 7. One choke point for each critical concern
Security- and correctness-critical logic lives in exactly one place it *cannot* drift. Duplication of a
critical path is a latent inconsistency bug.
- **Exemplar:** a single auth middleware; one settlement path.
- **Here:** the shared `completeOrder` seam — *every* rail records through it (re-price, reconcile,
  age gate, idempotency, settle). "No second completion path" is the best decision in the codebase.
- **Push further:** the same rule should govern *order resolution* and *mandate transport* (Open gaps).

### 8. Idempotency and safe retries are first-class
Networks retry. A correct library makes the retry a no-op, not a double-charge.
- **Exemplar:** Stripe idempotency keys.
- **Here:** `completeOrder` is idempotent, keyed by order id — a replayed verify echoes the record and
  settles nothing twice.
- **Push further:** any new state-changing seam states its idempotency contract explicitly.

### 9. Additive change and honest versioning
Grow by adding, not breaking. Reserve room for the future in the shape today; deprecate loudly, never
silently.
- **Exemplar:** Stripe's pinned API versions — no silent breaking changes, ever.
- **Here:** the cart mandate's `alg: "HS256"` **reserves room** for an ES256 / key-bound variant without
  changing the contract; the cart mandate itself shipped **additively** (default off).
- **Push further:** new fields optional with safe defaults; a breaking change needs a version and a
  migration note.

### 10. Tell the truth about state (honesty & observability)
The system never claims more than it can prove. Labels are accurate; test paths mirror real ones; the
developer can see what happened.
- **Exemplar:** Stripe test mode = production parity with fake money; Playwright's trace viewer.
- **Here:** `trust_level: "presence-only-demo"` is a *type-level* honesty fence — the wire crypto is
  real, the issuer trust anchor is not, and the code says so. "Real flow, fake money" is the settlement
  fence. This is a genuinely novel application of the Stripe test-mode idea to *trust*.
- **Push further:** every new capability declares its honesty label; never let copy or types imply a
  trust rung we haven't built.

### 11. Convention over configuration — but no magic you can't see through
Sensible defaults so the common case is zero-config; explicit overrides for the rest; and never hidden
global state or inferred behavior the developer can't predict.
- **Exemplar:** Next.js conventions; Drizzle's "no magic" stance.
- **Here:** `mount()` never *infers* "serverless" — an ephemeral signing key is allowed **only** when
  the host opts in explicitly (`allowEphemeralKey`). State is keyed per order/session, never
  process-global (invariant 4).
- **Push further:** if behavior changes based on something the developer didn't set, make it settable
  and documented.

### 12. The example IS the DX test — write it first, fix the API not the example
The quickstart/example is not decoration; it is the **acceptance test for the API's ergonomics**. Write it
BEFORE (or alongside) the API, from the *caller's* point of view. If the example needs a block of plumbing —
wiring stores, assembling a context, calling a low-level primitive by hand — the **API** has failed its DX
contract. Fix the API. Never dress up the example.
- **Exemplar:** Stripe's docs are the spec; `stripe.charges.create({...})` is two lines because the client
  absorbs the ceremony. The quickstart is sacred.
- **Here (a worked ugly → elegant):** the 005 delegated-draw example first exposed the raw seams — the caller
  hand-built a catalog, three stores, and a 7-field `completeOrder` call (~60 lines of plumbing before the
  point). That ugliness was the **signal** that the flow lacked a Stripe-grade surface. The fix was *not* a
  nicer example — it was `DelegatedGate`, a configure-once facade over the seams:

  ```js
  // BEFORE — the example must assemble the machine (the API leaked its seams)
  const catalog = { createOrder(items, id) { /* …build lines + total… */ } };
  const gate = { catalog, revocation: new MemoryRevocationStore(),
                 verificationStore: /* stub */, records: /* Map wiring */ };
  const { privateKey, delegate } = await generateDelegate();
  const mandate = await sealIntent({ /* 10 fields */ });
  const draw    = await signDraw({ /* 7 fields */ }, privateKey);
  await completeOrder({ order, mandateId, amount, currency, method, gates: [], draw: { intent, draw } }, gate);

  // AFTER — the ceremony lives in the library; the example is the story
  const gate  = new DelegatedGate({ catalog: { coffee: 18, wine: { price: 20, minAge: 21 } } });
  const grant = await gate.preApprove({ merchant: "blue-bottle", perOrder: 30, total: 100 });
  await grant.spend({ paymentId: "c1", item: "coffee" });   // → { ok, amount, remaining, reason }
  await grant.revoke();
  ```

  The example dropped ~104 → ~36 lines, and the ease moved *into the package* (tested), not into example
  scaffolding. **The example got shorter because the API got better** — the whole point.
- **Push further:** a public API ships with an example, and the example is reviewed *as part of the API*. If a
  reviewer must read plumbing before the intent, request changes on the API, not the example. And names in the
  example must state the important thing they do (`spend`, not `show`).

## The review checklist (the teeth)

For any new API or change, ask:

- [ ] **The example is the test.** Written first, from the caller's side — does it read top-to-bottom with NO
      plumbing block before the point? If it needs wiring, fix the API. (→ P12)

- [ ] **Five-minute test.** Can a newcomer reach a correct result by copying a short snippet? Did we add
      a *required* argument to an existing call? (→ P1)
- [ ] **Consistency.** Does it match the shape/verbs/naming of its siblings, or invent a new pattern? (→ P2)
- [ ] **Return a proof, not a maybe.** Does it hand back a typed value that can't be malformed, or an
      optional bag the caller must re-check? (→ P3)
- [ ] **One error door.** Typed, actionable refusal — and does it match how neighbors signal failure
      (throw vs. result)? (→ P4)
- [ ] **Extend without forking.** Is the extension point a seam/`defineX`, or would a user have to edit
      the core? (→ P5)
- [ ] **Ports, not imports.** Any framework import, `Date.now()`, or env read in the core? (→ P6)
- [ ] **One choke point.** Is a critical path defined once, or duplicated across call sites? (→ P7)
- [ ] **Idempotent + additive.** Safe to retry? Backward-compatible with a safe default? (→ P8, P9)
- [ ] **Honest.** Does the type/label claim exactly what we can prove — no more? (→ P10)
- [ ] **No hidden magic.** Would the developer be surprised by any inferred behavior? (→ P11)

## Open gaps against these principles (current, honest)

These are live tensions found while working in the code — the rubric applied to ourselves. Updated
2026-07-04 after the `statelessOrders` work (PR #32) closed some and confirmed others.

1. **The cart mandate is threaded by hand through ~10 hops** (P2/P7 — the biggest open gap, and it
   *grew*). Getting `statelessOrders` correct meant adding the cart to `resolveOrder` (×7 rail call
   sites), each rail's verify-POST body, each rail page's client JS, the storefront `/checkout` page,
   `place-order`, `homeRequires`, the gate `returnUrl` (×3), the passkey device-toggle, and the ungated
   place-order — and each missed hop was a silent 404 (found reactively, one bug at a time). This is the
   textbook symptom of a **missing single choke point**: order resolution + link-building want to be one
   place that carries the transport, not N inlined sites. **Highest-value refactor on this list.**
2. ~~**The mandate transport contract was undesigned**~~ — now designed + documented (`?cart` base64url
   on GET, `cartMandate`/`cart` in the verify body; `docs/reference/api.md`). Lesson stands: it should
   have been pinned in the spec *before* implementation, not discovered mid-build.
3. ~~**The approve link doesn't auto-carry the mandate**~~ — **done** in the storefront (PR #32): the
   `checkout` tool embeds the mandate in the link and `homeRequires` propagates it to every approve URL,
   so the client threads it transparently. (A *bare gate* consumer still wires it — the storefront is
   the ergonomic default.)
4. **`statelessOrders` needed a stable key, and originally didn't demand one** (P6/P11 — caught by the
   automated review, fixed in PR #32). It now fails fast without a `signingKey`/`allowEphemeralKey`. The
   lesson: a mode whose whole point is multi-instance must *fail fast* on the config that breaks
   multi-instance, never silently self-generate an instance-local secret.
5. **Two inconsistent error doors** (P4, still open). `verifyCartMandate` returns a verdict;
   `verifyChallenge` throws. Pick one convention for "verify" functions and hold it.
6. **`completeOrder` does seven things in sequence** (P7 readability, still open). Cohesive and correct,
   but it wants to read as a named pipeline of steps (`checkGates → idempotency → verifyCart → reprice →
   reconcile → ageGate → settle → record`) so the shape is legible and each step is independently testable.

---

_Living doc — edit to encode maintainer taste. Last principle pass: 2026-07-04._
