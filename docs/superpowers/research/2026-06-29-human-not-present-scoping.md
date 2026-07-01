# Human-Not-Present (HNP) — scoping research & proposal

> **Status: RESEARCH + PROPOSAL to feed a brainstorming session — NOT an approved design, NOT an implementation.**
> Date: **2026-06-29**. This document synthesizes five research dimensions (semantics, machinery map, security/honesty, prior art, candidate approaches) into one place so you can run a fast decision-making brainstorm on waking. **The design is decided *with* you in that session**, not here. Everything below is framed as options + recommendations. No code is proposed for merge. File/line references to the **Attesto library** (`github.com/openmobilehub/attesto`, package paths `packages/attesto-gate/src/…`) come from the dimension-B read of a fresh clone; references to `specs/…` and `docs/…` are in **this demo repo** and were spot-verified to exist (`specs/004-cart-mandate/spec.md`, `docs/superpowers/research/2026-06-28-cart-mandate-design.md`, `docs/diagrams/delegated-a2a-purchase.html`). HNP itself is **greenfield** — there is no prior HNP code or written design.

---

## 1. The idea & why now

Attesto today operates one model: **human present (HP)**. At the instant a consequential action completes, a live human performs a fresh ceremony — a WebAuthn passkey tap or an OpenID4VP/mdoc presentation — bound to *this* origin with nonce/replay protection. Payment emits an `ap2.PaymentMandate`; the cart (per spec 004) gets an `ap2.CartMandate`. Both are `trust_level: "presence-only-demo"`: real wire crypto, no issuer trust anchor yet.

**Human-not-present (HNP)** is the counterpart the project has already named and deferred. It lets an agent complete a consequential action *later*, when the human is **not** live in the loop, under consent the user **pre-authorized within explicit bounds** (a spending envelope / scope / time window), revocable and auditable. This is the AP2 **Intent Mandate** — the top leg of the Intent → Cart → Payment chain — and it is **literally the v0.2 line that 004's spec lists as out-of-scope-next**: *"A user/agent-signed Cart Mandate (the true AP2 user-authorization semantic) and `trust_level: \"issuer-verified\"`"* (`specs/004-cart-mandate/spec.md` lines 132-135). The `cart-mandate` memory recorded the same decision verbatim: *"Cart Mandate yes; Intent Mandate NOT human-present… its value is human-NOT-present delegation; teach it later as a separate HNP scenario."* **HNP is that deferred scenario.** It is continuity, not a pivot — and it completes the AP2 narrative for the GDC / Multipaz co-presentation.

It matters now because Attesto's reframed thesis is **"gate any consequential agent action — sign what you see; spend / deploy / delete / send,"** not commerce. HNP is the pre-authorized half of that thesis: an agent acting *for* you, within bounds, while you are away. The honest catch — the reason this is a research doc and not a build ticket — is that removing the live human makes the demo-vs-real gap **more** dangerous to blur than it is for the age gate, and a v0.1 HNP grant signed with today's primitive proves far less than it appears to. Getting the framing and the fencing right is the whole job of the brainstorm.

---

## 2. What "human not present" means

### Define it on the moment of completion, not the moment of intent

- **Human present (HP)** — *today.* At completion, a live human performs a fresh ceremony that is (a) **contemporaneous** (could only have been produced *now*), (b) **bound to this exact action** (this `orderId`, this amount, this origin), (c) **nonce/replay-protected** (server issued a one-shot challenge). HP proves: *"a human is here, now, and approves THIS exact thing."* In code this is `buildPasskeyMandate(...)` with `ceremonyTimestamp = now` and Gates 2-4 re-deriving the live assertion (`ceremony/mandate.ts`).

- **Human not present (HNP)** — *the feature.* At completion, **no live ceremony happens.** The agent presents a **previously captured authorization artifact** — a pre-signed delegation (the AP2 Intent Mandate) the human created earlier, within explicit bounds. The proof is **not contemporaneous**; it is a stored grant the agent replays. HNP can at most prove: *"a human, at some earlier time, pre-approved a CLASS of actions within bounds, and this action falls inside those bounds."*

**The entire risk surface is the gap between "THIS exact thing" (HP) and "a class within bounds" (HNP).** Every design decision below narrows that gap. Two clarifications worth putting in front of the room:

- HNP is a property of the **completion** moment, not the **grant** moment. The delegation *itself* can — and for honesty, must — be created under a strong live ceremony. "Strong-grant HNP" (user-key-signed delegation made under a live tap) ≠ "weak-grant HNP" (a checkbox). Same runtime, very different trust.
- There is a valuable **hybrid**: HNP-with-async-step-up — the agent acts unattended for in-bounds actions but triggers an out-of-band push ("approve on your phone") when a bound is exceeded, collapsing back to HP for the risky tail. Decide explicitly whether that counts as HP, HNP, or a third labelled mode.

### The AP2 mandate chain: Intent → Cart → Payment

AP2 models authorization as a chain of three mandates, each narrowing the one above and chaining back to it. Mapped onto what Attesto has:

| Mandate | What it captures | Who signs (HP) | Who signs (HNP) | Attesto today |
| :-- | :-- | :-- | :-- | :-- |
| **Intent** | The user's *delegated authority*: "my agent MAY do X within these bounds." | Often skipped (user signs the cart directly) | **User** signs ahead of time (wallet/device key) | **Absent** — deliberately deferred (the HNP scenario) |
| **Cart** | The *specific* action the agent assembled: exact lines, prices, merchant, total. | **User** signs (saw & approved the exact cart) | **Agent** assembles & signs; validity = "is this cart inside the Intent Mandate's bounds?" | **Server-HMAC integrity envelope** (`presence-only-demo`) — neither the HP user-signed nor the HNP agent-signed variant yet (004 FR-008) |
| **Payment** | Artifact handed to the network/issuer; in real AP2 it **carries a presence signal** the network uses for risk/liability. | **User** authorizes | **User** pre-authorized via Intent; Payment flags "agent-initiated, human-not-present" | **`ap2.PaymentMandate`** built (`ceremony/mandate.ts`), bound to amount+payee+webauthn assertion — **but models no presence field** |

**How the chain works in HNP, concretely:** the user signs an Intent Mandate ("buy concert tickets when they drop, ≤ $400, from ticketmaster.com, before Friday"). Later, tickets drop. The agent — no live human — assembles a Cart Mandate (the actual seats + price), signs it with the *agent's* key, binds it to the Intent Mandate id. The server verifies the chain Payment ← Cart(agent-signed) ← Intent(user-signed) ← user credential, **then** checks the cart falls inside the bounds, **then** re-prices from the catalog. No step trusts a claimed total.

### What "bounds" actually are

The Intent Mandate's bounds are the only thing between "pre-authorized" and "blank cheque." Most decompose onto fields Attesto already has:

| Bound | Meaning | Maps onto today |
| :-- | :-- | :-- |
| **Scope of action** | Which tool/effect class is delegated | `Credential.effect` kind (`gate`/`discount`/`authorize`) + which tool |
| **Spending cap** | Max amount; currency | Reuse Gate 1 amount-binding — but compare cap to the **re-priced** total |
| **Per-action vs cumulative** | Single-action max vs running total | Per-action = stateless. **Cumulative needs a delegation-scoped ledger** (new state) |
| **Time window** | `validFrom` / `validUntil`; expiry | Mirror `issuedAt`/`expiresAt` + `cartMandateTtl` (004 FR-006) |
| **Counterparty / merchant** | Allowed payees / origins | `payeeId` = `origin.rpID` — extend to a payee allowlist |
| **Item / category** | "groceries only," "no age-restricted" | `OrderLine.category` / `minimumAge` — already available to `.when()` predicates |
| **Velocity / frequency** | N actions per window | Needs the same ledger as cumulative caps |
| **Step-up triggers** | Bounds that, when exceeded, force a fall-back to live HP | New; the async-step-up hybrid |

The clean framing: **an Intent Mandate is a pre-signed, scoped `required()` satisfaction.** Today a live ceremony writes the per-order `VerificationRecord`; under HNP the *delegation* writes it — but only after a **bounds-check gate** passes, re-derived server-side exactly like Gates 1-4 (never trust the agent's "I'm within bounds" claim).

---

## 3. How HNP maps onto the existing machinery

### The one fact that decides everything: there is exactly one completion seam

Every payment rail funnels through a single function, `completeOrder(input, ctx)` (`ceremony/completion.ts`):

- `ceremony/passkey/routes.ts` → `ctx.completion({…})`
- `ceremony/dc-payment/routes.ts` → `ctx.completion(input)`
- instant-demo path → same `ctx.completion` (004 FR-008)

`completeOrder` does **not** re-verify any live presentation. It runs deterministic, re-derived checks: all gates passed → idempotency (`records.read`) → optional Cart Mandate verify → catalog **re-price** (invariant 2) → Cart↔Payment **reconcile** (invariant 3) → **age gate** (invariant 1/5) → settle → write record + `verificationStore.clear`. "Liveness" lives entirely **upstream** of this seam, in the rail verify handlers, and reaches `completeOrder` as just two kinds of input:

1. **Per-order verification state** in the `VerificationStore` (`ageVerified: true`, `loyalty.applied`), written by `recordVerified` (`ceremony/credential-gate/routes.ts`) after a verified presentation.
2. **Gate outcomes + a payment binding** (`input.gates`, `input.amount`, `input.currency`) each rail projects from its verified `mandate.payment`.

**This is the crux for HNP:** a Human-Not-Present path is simply a *new producer of those same two inputs*, derived from a verified pre-signed grant instead of a live ceremony. Attach there and invariant 1 ("enforce on EVERY completion path") holds **automatically**, because there is only one path.

### Recommended attach point

Mirror the existing rail structure (CLAUDE.md: "a new gate should mirror the `dc-payment`/`passkey` structure"). Add a new **`ceremony/intent/`** module whose **verify path consumes a pre-signed grant rather than a live presentation**, and which:

- verifies the grant (signature/HMAC), then checks the order falls *within* the grant's pre-declared scope + window + budget + not-revoked;
- on success, writes the **same** per-order `VerificationStore` record via the existing `recordVerified` shape (so `completeOrder`'s age/loyalty re-derivation is unchanged and invariant-4 per-order scoping is preserved);
- projects `input.gates` + `input.amount`/`input.currency` into the **same** `ctx.completion(...)` call.

Net effect: `completeOrder` barely changes; the new code is *grant verification*, sitting exactly where `verifyPasskeyAssertion` / `verifyCredentialPresentation` / `verifyDcPresentation` sit today.

### Seams that ALREADY enable HNP (reuse, don't invent)

| Seam | Where | Why it enables HNP |
| :-- | :-- | :-- |
| `signingKey` (sealed HMAC) | `ceremony/mount.ts` `CeremonyContext.signingKey`; same primitive as `challengeToken.ts` / `cartMandate.ts` | A grant can be HMAC-sealed/verified with the same `sign()`/`timingSafeEqual` pattern, already injected on every rail |
| single `completeOrder` seam | `ceremony/completion.ts` | One seam = invariant 1 satisfied for free. `CompletionInput` already carries optional `cartMandate` — an additive `intentMandate?` mirrors it exactly |
| Per-order injected stores | `VerificationStore`, `CompletedOrderStore` | Invariant 4 (per-order keying) is structural; a grant writing `ageVerified`/`loyalty.applied` reuses `recordVerified` verbatim |
| reserved `alg` field | `cartMandate.ts` `alg: "HS256"` (004 FR-005, "future ES256 / user-agent-signed variant") | The typed seam between server-issued integrity and user-signed authorization; `canonical()`/`sign()`/`verifyCartMandate()` are the copy template |
| `reconcileCartPayment` | `ceremony/reconciliation.ts` | Already proves `cart.total === rederivedTotal === payment.amount`; extend to assert `rederivedTotal <= grant.maxAmount` |
| `verification_required` envelope + `gated()` | `ceremony/envelope.ts`, `gated.ts` | Mode-B already models "agent drives a consent handshake, then resumes by polling" (`resume: {tool, poll}`, per-order `approve_url`, versioned `attesto.verification/v1` wire). HNP is its natural completion |
| Honesty axes in the types | `enforcedAt`, `trust_level` | The type system already carries *where* and *how-honestly* a gate runs; HNP needs a new honest *position* on these axes, not a new mechanism |
| In-repo ES256 signing | `dc-payment/request.ts`, `credential-gate/request.ts` (`jose`, ES256, x5c) | The crypto for a user/agent-signed variant already exists — HNP wires existing crypto to a new payload, it does not introduce new crypto |

### What is MISSING (present these as missing — they are the new design surface)

1. **No Intent/authorization mandate TYPE.** We have `ap2.PaymentMandate` and `ap2.CartMandate`. AP2's chain is Intent → Cart → Payment; the Intent Mandate **does not exist**. Need `ceremony/intentMandate.ts`: `{ type: "ap2.IntentMandate", id (per-grant, long-lived — NOT cart_<orderId>), subject (holder/agent), scope (item/category/merchant allowlist), maxAmount, currency, window {notBefore, expiresAt}, maxUses?, alg, trust_level, presence, signature }`.
2. **No `subject`/holder binding on the cart side.** `CartMandate` has **no** `subject` field (confirmed by grep) — it binds order id + total, not *who* authorized. HNP must bind a grant to a holder/agent identity and the completion must check the acting agent matches. That field + check is absent.
3. **No verify path that accepts a pre-signed grant.** Every rail verify requires a **fresh** wallet response bound to a **fresh** nonce. There is no `verifyIntentGrant(grant, order, ctx)` (signature → scope-contains → window → not-revoked → budget → write per-order record). **This is the core new code.**
4. **Binding is "equals," HNP needs "contains."** `cartMandate.ts` binds with `m.orderId !== expectedOrderId` (equality) + nonce binding. A grant is signed **before the order exists**, so it can't equality-bind to an order id. HNP needs the inverse: at spend time, assert the order falls **within** the grant's pre-declared scope. That "contains" predicate doesn't exist anywhere.
5. **No revocation state / store.** Grep: **NONE.** `completeOrder` has idempotency but no revocation. Need a new injected `RevocationStore` seam + a check before completion. Requires a stable per-grant id.
6. **No multi-use budget ledger across orders.** `completeOrder`'s idempotency is per-order-id only; it has **no concept** of "this grant has spent $80 of its $100 envelope across 3 orders." Need a per-grant spend ledger (cumulative amount + use count), checked-and-incremented **atomically** — genuinely new state with concurrency/race concerns the per-order model never had.
7. **The honesty axis has no value for "authorized earlier, not present now."** `trust_level` is `presence-only-demo | issuer-verified` — **both assume a live human in the moment.** HNP removes the live human; conflating it with `presence-only-demo` would be dishonest.

---

## 4. Security & honesty under HNP

### Threat model (what removing the human exposes)

| Threat | Protected today by (HP) | How HNP breaks it | Bounding control |
| :-- | :-- | :-- | :-- |
| **Stolen / leaked grant (bearer risk)** | WebAuthn assertion is device-bound + UV; non-transferable | A pre-signed grant in agent memory / logs / transit is a **bearer instrument** — whoever holds it spends it | Holder-bind the grant to an agent key + **proof-of-possession per draw**; short TTL; per-action cap bounds blast radius; revocation |
| **Over-broad scope** | Human sees the exact cart + amount in the ceremony | Human authorized a *class*, not a specific cart — "buy groceries" → "buy a TV" | Explicit **scope manifest**: merchant/payee + category + item allowlists; gate re-derives & matches (extend `.when()` predicates) |
| **Replay across orders** | Fresh nonce + order-id binding + idempotent completion | A reusable grant is *meant* to present many times — "single-use" no longer protects | Fresh nonce + order-id per draw; **per-grant ledger** of spent order-ids + cumulative amount |
| **Amount drift** | Human re-confirms the live amount; mandate binds an *exact* total | Cart was $40 at grant time, catalog says $52 at draw — **nobody re-confirms** | Re-derive from catalog (inv. 2) **and** enforce re-derived ≤ grant **ceiling + tolerance**; above → refuse or step up to live |
| **Expired-but-honored** | Expiry on challenge token + mandate | HNP grants are **long-lived by design** → big theft/replay surface | Hard server-side expiry on every path; conservative TTL; refuse with a reason distinct from tamper |
| **Missing revocation** | Nothing to revoke — ceremony over in seconds | A standing capability the user must be able to **kill** now exists | **Revocation list keyed by grant id**, checked server-side every draw, **fail-closed**; user surface to list + revoke; per-subject kill-switch |
| **Confused deputy** | The human is the final check on the agent | The agent *is* the deputy — a prompt-injected/buggy agent can spend **within scope but against intent** | Tightest scope + caps + allowlist + full audit. **Honest limit: HNP cannot stop a faithful-looking in-scope draw — only bound and audit it.** Reserve high-consequence actions for live presence |
| **Loss of real-time verification (meta)** | Human consciously consents to THIS action NOW | The grant proves *past* consent to a *described class*, never *present* consent to *this instance* | Fundamental property, not fully controllable — bound hard, make revocable + auditable, reserve for low-consequence/bounded actions, step up above thresholds, **never equate a grant to a live ceremony** |

### The 6 invariants, stress-tested under HNP

1. **Enforce server-side on every path.** HNP adds **two** new mandatory checks (bounds-check + revocation-check) that must run in `place-order`, every `/verify` handler, and the MCP tool — inside the same shared `completeOrder` seam. New ordered checks before recording: grant signature valid → not expired → not revoked → order within scope → per-action cap ok → cumulative + this draw ≤ envelope → order-id not already drawn. Any failure refuses, records nothing.
2. **Never trust the order token — re-derive amount. (STRESSED HARDEST.)** Under HNP, catalog re-derivation is the **only** amount check and there is **no human to catch drift.** The 004 cart mandate signs an *exact* total; an HNP grant cannot (the cart isn't known at issuance) — so it must bind a **ceiling**, enforced as `repriced.total ≤ grant.cap` on top of the existing exact-match refusal. The grant must never carry a trusted amount the gate skips re-deriving.
3. **Discounts reconcile with amount binding across all paths.** The draw amount = re-derived post-discount total, and must be ≤ remaining envelope **and** equal the bound payment amount on passkey, dc-payment, and instant paths. A grant must **never claim a discount that lowers the cap-check without the verification backing it.**
4. **Scope state per session/order — never process-global.** HNP introduces a **new long-lived state object** — the grant + its ledger — keyed by **grant id** (and bound to subject/agent), never process-global; a shared ledger = cross-user spend bleed. Because many orders draw on one grant, the cap decrement needs **atomic reservation / optimistic concurrency** — a double-spend race the per-order model never had.
5. **Require explicit positive claims.** The grant must **carry or reference** the explicit positive claim (`age_over_21 === true`), re-checked `=== true` at draw time — never "a grant exists ⇒ age satisfied," and an 18+ grant must not satisfy a 21+ draw. **New wrinkle:** a captured-once proof can **go stale** — fine for age (it doesn't decrease) but not for revocable credentials (membership lapsed, instrument expired). The grant must bound how stale a referenced claim may be and fail-closed if it outlives the claim's validity.
6. **Origin/RP-ID + nonce/replay — now over a long-lived grant. (DEEPEST TENSION.)** A pre-signed delegation is *reusable by nature*, so the one-nonce-per-ceremony model (`challengeToken.ts`) does not transfer. Replay protection moves from "this presentation ↔ this nonce" to **"this grant ↔ this agent key ↔ this draw nonce":** (a) bind the grant to its issuing origin/RP-ID (the dc-payment `expectedPayee` re-derivation is the model), (b) holder-bind to an agent key with a **fresh challenge the agent signs per draw**, (c) a fresh nonce + order-id per draw recorded in the ledger. **Hard truth:** without a live user ceremony, replay protection guards the *agent's* re-use, not the *user's* intent — a compromised agent holding grant + key can draw freely up to the caps.

### Honesty — the crux (what a v0.1 HNP grant REALLY guarantees)

The existing single honesty enum **conflates two things HNP forces apart:**

- **`trust_level: "presence-only-demo"`** today means *real wire crypto + a live, device-bound, nonce-bound human ceremony*, but **no issuer trust anchor.** The weakness is *only* "we don't verify the issuer signed the credential."
- **A v0.1 HNP grant signed with the server's HMAC** guarantees **only "this server issued this grant."** It does **not** prove the user authorized it, not which user, not that the agent is the legitimate holder, and there is **no human at execution at all.** That is **strictly weaker** than `presence-only-demo` — so labeling it `presence-only-demo` would be an **over-claim.** It is *doubly demo*: presence-removed **and** trust-anchor-absent.

**The honest fix is a two-axis trust model** — HNP separates *when consent happened* from *how strongly the authorization is bound*:

- **Presence axis:** `live` (a ceremony at execution) vs `pre-authorized` / `delegated` (consent captured earlier).
- **Authorization-integrity axis (today's `trust_level`):** `server-issued` (HMAC — "the server says so") vs `user-signed` (real AP2 authorization) vs `issuer-verified` (real trust anchor on the credential).

A v0.1 HNP grant sits in the **weakest cell** (`pre-authorized × server-issued`). It must be named honestly and **demo-fenced**: never settles real value, never shown as a real safety control.

**What must NEVER be oversold:** never present a server-HMAC grant as "the user authorized this purchase" (it proves *issuance*, not *authorization*); never present a pre-authorized grant as equivalent to a live ceremony; never let the HNP path settle real value while in the weakest cell.

**Where the issuer-verified / real-control line is:** an HNP grant becomes a *real* safety control only when **all three** hold at once — (1) it is **user/agent-signed** (the v0.2 line), (2) the underlying credential is **issuer-verified** (the v0.3 trust-anchor work), and (3) each draw is a **real proof-of-possession** (KB-JWT / device-signed) over a fresh challenge. **v0.1 has none of the three.**

---

## 5. Prior art & alignment

**Thesis:** HNP is not a new direction to invent — it is the explicitly named, already-deferred v0.2 line of the Cart Mandate work. Several load-bearing decisions are already made and should be treated as *settled inputs*, not reopened:

- **004 names HNP in three places.** Spec "Out of Scope (v0.2+)" lists *"A user/agent-signed Cart Mandate … and `trust_level: issuer-verified`."* The design research (`2026-06-28-cart-mandate-design.md`, decision D4) says *"the user/agent-signed Cart Mandate is the v0.2 line — fence it honestly; do not present the HMAC as user authorization."* And `mandate.ts` comments already say *"Real KB-JWT / key-bound signing is deferred (v0.2)"* / *"Production replaces with AP2-conformant key-bound signing."* The trajectory is documented.
- **The data model already reserves the upgrade path** — the `alg` field (FR-005, "admits a future ES256 / user-agent-signed variant additively"). The repo already does real ES256 elsewhere. HNP populates the reserved `alg`, it doesn't reopen the signature-primitive debate.
- **The single `completeOrder` seam is already invariant-shaped** — re-prices (inv. 2), gates discounts on per-order state (inv. 3), enforces age on completion (inv. 1), keyed by order id (inv. 4). An "is-this-within-the-envelope?" check belongs there as one more re-derived gate, with a new typed `CompletionResult.reason` (`envelope-exceeded` / `envelope-revoked` / `envelope-expired`) mirroring how 004 added `reason: "cart-mandate"`.
- **There is already an async, agent-driven consent primitive** — `verification_required` + `gated()` (Mode B). Today it routes to a *live* ceremony at `approve_url`; HNP is its natural completion (human pre-proves once; the agent resumes later without a fresh ceremony). **Caveat:** `gated.ts` is marked "Will be removed after v0.2" — HNP is a reason to **keep and promote** it, which must be resolved explicitly so HNP isn't built on a primitive slated for deletion. Also disambiguate "verification_required **envelope**" from "spending **envelope**" — different concepts, overlapping word.
- **The delegated-A2A diagram is already the house position.** `docs/diagrams/delegated-a2a-purchase.html` sketches it end-to-end: **Phase 1** (human present, once — sign INTENT Mandate via DC API / caBLE, store keyed by watchId) → **Phase 2** (human NOT present — cron wakes, load Intent by id, `cart ⊆ Intent policy gate`, settle). The footnote *"Human signs once: the Intent Mandate (merchants · scope · caps · expiry)"* is effectively the spec for the recommended candidate.

**External analogies, each with an in-repo anchor:**

| External pattern | In-repo anchor |
| :-- | :-- |
| **AP2 Intent Mandate** (user pre-authorizes an agent within constraints — the canonical HNP case) | Repo emits `ap2.PaymentMandate`, adds `ap2.CartMandate`; HNP = the missing first leg |
| **OAuth-style scoped, short-lived, revocable delegated grants** | `challengeToken.ts` is already a sealed-HMAC, expiry-bound, single-use-in-window grant; an envelope is the same primitive with richer claims + a longer-but-bounded TTL |
| **VC holder / key-binding (KB-JWT)** | `mandate.ts` already names KB-JWT / key-bound signing as the deferred v0.2 step; OpenID4VP rails already do ES256 |
| **Spending-envelope / allowance controls** (per-tx cap, merchant allowlist, category, velocity, window, revocation) | Maps onto Principle IV's `.when((order) => boolean)` predicates + server-side re-derivation; enforced at `completeOrder` |

**Constitution friction (specific, resolvable):** Principle II ("Context 1 / the MCP tool handler … MUST NOT perform a credential ceremony") and Principle III (consolidated single-session checkout) **bend** under HNP, whose whole point is a Context-1 completion with no phone in the loop. The defensible resolution: *the ceremony still does not happen in Context 1 — it happened earlier, when the human set up the envelope; Context 1 verifies a pre-existing delegation, not a live ceremony.* The governance rules expect this to be **written down** — either a narrow MINOR amendment or a separately-named "unattended mode" (Decision 13).

**Real tension to surface:** HNP needs server-side per-envelope spend + revocation state (invariant 4), which **fights 004's stateless Cart Mandate ambition** (US3 / `statelessOrders`, FR-007). You cannot have a revocable, spend-tracked envelope **and** a fully stateless transport simultaneously.

---

## 6. Candidate approaches

Every HNP design reduces to **one change**: replace the live presentation in a rail's verify path with a pre-signed delegation, while routing through the **unchanged** `completeOrder` seam so re-pricing, age re-enforcement, and idempotency still apply with no human in the loop. Three shapes:

### Candidate A — Intent Mandate (offline-verified pre-signed delegation)

While present, the user completes ONE live ceremony that signs an `ap2.IntentMandate` (`subject`, `scope{ payee/category/product allowlist }`, `envelope{ perTxMax, cumulativeMax, currency, spent }`, captured `claims{ age_over_21: true }`, `expiresAt`, `alg`, `signature`, `trust_level`, `presence`), stored keyed by an intent id (the watchId). Later, with no human, `redeemIntent(intentId, proposedCart)` resolves the gate from the mandate's *carried/captured* claims instead of a fresh presentation. Binds **caps, not a cart** (the cart is unknown at delegation). Revocation = flag + ledger keyed per intent id.
**Effort/risk:** Medium. Reuses HMAC + `alg` seam + verificationStore + completion seam; new surface = the type, a delegate flow, a redeem path, a revocation + ledger store. **Highest *semantic* risk** — easiest to over-claim ("the user signed it"); ledger atomicity is a real serverless concern.

### Candidate B — Delegated holder-bound credential (OpenID4VP delegation)

The user issues the agent a **scoped credential bound to the agent's key.** At execution the agent produces a **fresh, device-signed** OpenID4VP presentation flowing through the *nearly unchanged* `verifyCredentialPresentation` / `verifyDcPresentation` path. Invariant 6 is satisfied **really** at redeem time (fresh nonce + deviceAuth, not a snapshot); revocation is issuer status-list (the *correct* model). The honesty gap shrinks to today's issuer-trust gap.
**Effort/risk:** HIGH. No issuer, no agent-key holder-binding, no status list in the repo today (roadmap v0.3 *Research*). Most standards-faithful, most work, leans hardest on the unbuilt roadmap. **This is the destination for a *real* control.**

### Candidate C — Pre-authorized grant token (extend the CartMandate `alg` / `challengeToken` seam)

The lightest: a **server-issued, capped, expiring, same-origin** grant. The first live purchase (or an explicit "authorize up to $X here" ceremony) mints `HMAC{ subject, payee = this origin, envelope, captured claims, jti, expiry }`; the agent redeems it later through a new path that verifies the HMAC, checks caps/expiry/revocation, re-prices, completes. Narrower than A (single merchant, no A2A fan-out) but the **most honest about what it is** — it never pretends the user signed anything; reuses the 004 CartMandate fence verbatim.
**Effort/risk:** LOW–MEDIUM, smallest, lowest over-claim risk. Limitation: doesn't show the cross-merchant A2A story — acceptable for a first slice.

### Comparison

| | A — Intent Mandate | B — Delegated credential | C — Grant token |
|---|---|---|---|
| Verify-without-human via | carried/captured claims | fresh agent-signed presentation | HMAC bearer grant |
| Replay protection at redeem | snapshot + jti ledger | **real** (fresh nonce/deviceAuth) | jti ledger |
| Revocation | server flag + ledger | **issuer status-list** + ledger | jti set + ledger |
| New infra | mandate type + ledger | **issuer + holder-binding + status list** | almost none |
| Honest v0.1 trust | `delegated-demo` / presence-only | `delegated` / presence-only (mock issuance) | server-grant / presence-only |
| Path to real control | user-key sign (v0.2) + issuer-verified (v0.3) | issuer-verified (v0.3) | user-key sign (v0.2) |
| Effort / over-claim risk | Med / **High** | **High** / Med | **Low** / Low |

### RECOMMENDED first increment — the smallest honest end-to-end slice

**Build the Intent Mandate (A's narrative + AP2 shape), implemented for v0.1 with C's mechanism, scoped to this single origin.** Concretely, an "intent rail":

1. **Delegate (human present, once):** at the end of one live ceremony, mint `ap2.IntentMandate` (HMAC via the `alg` seam) carrying `subject` (verified credentialID), `scope.payee = this origin`, a product/category allowlist, `envelope{ perTxMax, cumulativeMax, currency, spent: 0 }`, captured `claims{ age_over_21: true }`, `expiresAt`, `presence: "delegated-demo"`, `trust_level: "presence-only-demo"`. Store keyed by intent id.
2. **Redeem (human NOT present):** `redeemIntent(intentId, proposedCart)` → verify HMAC + expiry + not-revoked → re-price `proposedCart` from the catalog (inv. 2) → assert `cart ⊆ scope` AND `repriced.total ≤ min(perTxMax, cumulativeMax − spent)` → re-enforce age from the *captured* claim, **refusing if the intent outlives the claim's validity** (inv. 5, fail-closed on staleness) → derive a Payment Mandate (`amount = repriced.total`, inv. 3) → route through the **unchanged** `completeOrder` seam → on success atomically `spent += repriced.total` (inv. 4).
3. **Bypass tests that make it a control:** over-envelope refused; revoked refused; expired refused; cart-outside-scope refused; tampered-HMAC refused; replay past the cumulative cap refused; age-restricted cart with no captured age claim refused; plus an honesty test asserting `trust_level` stays `presence-only-demo`, `presence` is `delegated-demo`, and no surface labels it "user-signed." Each must fail with its control removed.

**Why this slice:** it runs entirely on the existing single-server demo (no issuer, no merchant discovery), reuses four primitives that already exist (HMAC, `alg` seam, verificationStore, `completeOrder`), upholds all six invariants, and **completes the AP2 chain** (Intent → Cart → Payment) — a strong, honest GDC narrative. **Candidate A-with-user-key-signing is the v0.2 bridge** (the `alg` swap HMAC → KB-JWT/ES256); **Candidate B is the v0.3 destination for a real control** (fresh device-signed delegated presentation + issuer-verified).

---

## 7. Open decisions for your brainstorming session

The menu below merges and dedupes the open questions from all five dimensions. Decisions are grouped; within each, **bold = the recommended option.** The single most-agreed item is **Decision 2 (the presence axis)** — four of five dimensions independently landed there.

### Group A — Semantics & honesty (decide these first)

**1. Do we model the Intent Mandate at all in v0.x, and do we use the `ap2.IntentMandate` name?**
- (a) **Model it now** as a typed artifact + a deterministic bounds-check gate (mirroring `PaymentMandate` + Gates 1-4), **using the `ap2.IntentMandate` type** for AP2 alignment, with honesty carried in the trust fields (not the type name) and fenced hard as demo.
- (b) Stay HP-only; keep HNP as a written research scenario.
- (c) Model only the data shape (no runtime) to complete the AP2 narrative for GDC.
- (d) Type it but call it "pre-authorization grant" until it's user-key-signed.
- **→ Recommend (a):** it's the natural top-of-chain you deliberately deferred, completes the AP2 story for GDC, and the loud fencing keeps it honest. The type name is AP2-correct; the honesty lives in the trust fields.

**2. [STRONG CONSENSUS] How do we represent the removal of the live human honestly in the type system?**
- (a) Reuse `trust_level: "presence-only-demo"` — **reject** (an over-claim; HNP has no live ceremony).
- (b) Add a single new `trust_level` value (e.g. `delegated-server-issued-demo`).
- (c) **Add a separate, orthogonal `presence` axis** — `presence: "live" | "delegated-demo" | "delegated"` — and keep `trust_level` for crypto/issuer trust.
- **→ Recommend (c):** presence ("was the human there") and issuer-trust ("is the claim real") are independent honesty questions; collapsing them hides one. A *real* HNP control is `presence: "delegated"` **and** `trust_level: "issuer-verified"`; v0.1 ships `delegated-demo` + `presence-only-demo`. This is also worth doing for the `PaymentMandate`, which models no presence field at all today.

**3. What signs the v0.1 grant?**
- (a) **Server-HMAC** (lift the 004 primitive) — proves *issuance only*; cheap but doubly-demo.
- (b) Agent-key-signed Cart Mandate bound to the Intent Mandate (partial honesty).
- (c) Full user-key-signed Intent Mandate (the v0.2 issuer-verified line).
- **→ Recommend (a) now, with the type shaped so (c) drops in via the reserved `alg` axis** — identical discipline to 004 FR-005. Label it relentlessly as "the server issued this grant," never "the user authorized it," and never settle real value. The user/agent-signed + issuer-verified + per-draw-PoP combination is the line where it becomes a real control; v0.1 is explicitly below it.

**4. Which effect kinds get delegation?**
- (a) **`authorize`-effect + custom ACTION gates only** (payment, unlock, submit, deploy); **explicitly EXCLUDE attribute gates** (age, membership).
- (b) authorize + attribute gates via cached presentations.
- (c) authorize + attribute gates via long-lived held VCs (needs issuer-trust layer).
- **→ Recommend (a):** "Delegate ACTIONS, not IDENTITY." Pre-authorizing "being 21" is a category error, and caching an age/membership presentation violates invariant 6 (freshness/replay). This is both safer and a cleaner story.

### Group B — Bounds, caps & binding

**5. Single-use grant vs reusable spending envelope for the first increment?**
- (a) **Single-use only** — one grant authorizes one order (essentially a pre-authorized Cart Mandate); no ledger, no double-spend race, simplest to make honest.
- (b) Reusable envelope (many draws up to caps) — needs the per-grant ledger + atomic reservation + mature revocation.
- (c) Both behind a flag, single-use as the safe default.
- **→ Recommend (a) first:** it delivers the HNP narrative with the smallest threat surface and is a clean one-level lift of the 004 cart mandate. Treat the reusable envelope as the explicit, separately-reviewed next step.

**6. Per-action vs cumulative/velocity caps — and the ledger atomicity requirement?**
- (a) **Per-action only** (stateless, stateless-transport friendly).
- (b) Cumulative + velocity from the start (needs a per-grant ledger).
- (c) **Per-action default + cumulative/velocity as an opt-in** needing a per-grant ledger keyed per grant id.
- **→ Recommend (a) → (c):** ship per-action first; add cumulative/velocity opt-in. **A cumulative cap is only a real cap if the decrement is atomic** — require Redis/Upstash compare-and-set for it to be a real control, allow in-memory only for the local single-instance demo behind an explicit fence (the existing `allowEphemeralKey` pattern). A non-atomic cumulative cap must not be sold as one.

**7. How does a grant bind to an order it predates, and survive price drift?**
- (a) Equality binding like CartMandate — **impossible** (the order doesn't exist at grant time).
- (b) **Scope-CONTAINS predicate at spend time** (amount ≤ ceiling, currency match, item/merchant allowlist, within window) **+ ceiling + tolerance + a hard "presence-required" step-up threshold** (above $X, age-restricted goods, or a merchant not on the allowlist forces the flow back to a live ceremony).
- (c) Single-use grants only, to dodge the budget problem entirely.
- **→ Recommend (b):** keep invariant-2 re-derivation as-is, add the cap/tolerance check, and define the step-up threshold. This bounds drift AND confused-deputy blast radius in one rule.

### Group C — State, attachment & enforcement

**8. Where do per-envelope spend + revocation state live, given 004's stateless ambition?**
- (a) Server-side ledger + revocation list keyed by grant id, re-derived at `completeOrder` (accepts a Redis/store dependency).
- (b) Fully stateless — signed bounds only; rely on per-order idempotency + short TTLs; accept NO cross-order cap or revocation.
- (c) **Hybrid** — the signed Intent Mandate travels statelessly, but `completeOrder` MUST consult a server-side per-grant spend ledger + fail-closed revocation check before recording, never trusting any "remaining balance" carried in the presented mandate (invariant 2 applied to envelopes).
- **→ Recommend (c):** be explicit in the room that **this means HNP cannot be fully stateless** — revocation and velocity limits inherently require server state, in direct tension with 004's `statelessOrders`. Use **two new injected seams** (`RevocationStore` + `GrantLedgerStore`) keyed by a stable per-grant id, mirroring `CompletedOrderStore`'s shape so they inject with zero glue.

**9. Revocation mechanism & UX?**
- (a) **Synchronous server-side revocation flag keyed per grant id, checked before every redemption, fail-CLOSED** (store unreachable ⇒ refuse) **+ a user-facing "active grants" surface** (the audit trail) **+ a per-subject kill-switch.** Expiry is the passive backstop.
- (b) Best-effort check, fail-open — **reject** (a revoked grant would still spend).
- (c) Expiry-only — **reject** (long-lived grants are the whole point); issuer status-list arrives with Candidate B at v0.3.
- **→ Recommend (a):** revocation is non-negotiable the moment a standing capability exists. Auditability becomes load-bearing because the audit trail replaces the human-in-the-loop moment — extend `CompletedRecord` with `delegationId` so every unattended completion links back to the grant that authorized it.

**10. Where does the HNP path physically attach in code?**
- (a) **A new `ceremony/intent/` rail** (mirror `dc-payment`): verify the grant, write the SAME per-order `VerificationStore` record via the `recordVerified` shape, project into the SAME `ctx.completion` — `completeOrder` unchanged; add only an optional `intentMandate?` field on `CompletionInput` (additive, mirrors `cartMandate`).
- (b) An authorization branch directly inside `completeOrder`.
- (c) Both: a thin rail + a small `completeOrder` branch.
- **→ Recommend (a):** keeps `completeOrder`'s age/loyalty re-derivation and invariant-4 per-order scoping untouched; the new code is grant verification, sitting exactly where the live-presentation verifiers sit today.

### Group D — Scope, ceremony & governance

**11. Scope model for the first increment, and where the live delegation ceremony happens?**
- (a) **Single-origin** (this server's payee) **+ a product/category allowlist within it**; the live delegation ceremony is **a dedicated `delegate` flow that reuses an existing rail** (passkey/DC-API) to produce the signature, emitting an `enforcedAt: "intent"` manifest entry.
- (b) Multi-merchant payee allowlist with agent fan-out/discovery (the A2A diagram's story).
- (c) Piggyback the existing checkout ceremony — the first purchase also mints the Intent Mandate.
- **→ Recommend (a):** single-origin demonstrates HNP end-to-end with zero new merchant-discovery/A2A surface and matches the existing this-origin payee re-derivation in `runDcGates`. A dedicated delegate flow keeps delegation explicit and auditable rather than a side effect of a normal purchase. Multi-merchant is the v0.2+ story.

**12. Is async step-up (agent acts in-bounds, pushes for live approval on a breached bound) HP, HNP, or a third mode?**
- (a) Classify as HP (ends in a live tap for the risky tail).
- (b) Classify as HNP (the baseline path is unattended).
- (c) **Treat as a distinct labelled third mode (hybrid).**
- **→ Recommend (c):** it's the most defensible real-world pattern (unattended in-bounds, live step-up for the tail); conflating it with either pure mode hides exactly the presence distinction the honesty axis exists to make explicit.

**13. Governance: amend the Constitution, and promote the Mode-B primitive?**
- (a) **A narrow MINOR amendment** to Principles II/III stating Context 1 performs NO ceremony — it *verifies a pre-existing user/agent-signed delegation created in an earlier, separate ceremony* — and that unattended completion is gated by an explicit envelope + a non-presence-only trust level for any real claim. **And promote/keep the `verification_required` / `gated()` Mode-B primitive** as the agent-driven HNP handshake (reusing the versioned `attesto.verification/v1` wire), resolving its "remove after v0.2" note.
- (b) Define a new fourth execution context / "unattended mode" the constitution names separately; build a fresh HNP envelope and let `gated()` be removed.
- (c) Defer both behind a demo-only flag until the mechanics are proven.
- **→ Recommend (a):** it preserves the spirit of "the agent must not perform the ceremony" while making the new path legitimate and auditable rather than smuggled in, and avoids building HNP on a primitive slated for deletion. Disambiguate "verification_required envelope" vs "spending envelope" naming while you're there.

---

## 8. Suggested scope / out-of-scope for a first HNP increment

**In scope (the smallest honest end-to-end slice):**
- A typed `ap2.IntentMandate` (server-HMAC via the reserved `alg` seam), scoped to **this single origin** + a product/category allowlist.
- A dedicated **delegate** flow (reusing an existing live rail to sign) and a **redeem** path that verifies the grant, re-prices from the catalog, checks scope-contains + per-action cap + window + not-revoked, re-enforces the captured age claim (fail-closed on staleness), and routes through the **unchanged** `completeOrder` seam.
- A new **orthogonal `presence` axis** (`live | delegated-demo | delegated`) alongside `trust_level`; v0.1 ships `delegated-demo` + `presence-only-demo`.
- **Per-action caps** (stateless); a **fail-closed revocation flag** keyed per grant id checked on every draw; an **audit record** (`delegationId` on `CompletedRecord`) doubling as the "active grants" surface.
- **Bypass tests** that make each control load-bearing (over-cap / revoked / expired / out-of-scope / tampered / replay / missing-claim / honesty-label).

**Out of scope for the first increment (name them explicitly):**
- **Attribute-gate delegation** (age / membership) — excluded by design ("delegate actions, not identity").
- **Cumulative / velocity caps** and the atomic per-grant ledger — opt-in next step (needs Redis CAS to be a real control).
- **Multi-merchant / A2A fan-out** and merchant discovery — the v0.2+ diagram story.
- **User/agent-key signing (ES256 / KB-JWT)** — the v0.2 bridge; **issuer-verified credentials + per-draw PoP** — the v0.3 destination (Candidate B).
- **Sub-delegation (agent → sub-agent)** — forbid by default; if ever allowed, narrowing-only.
- **Real settlement** of any HNP draw — demo-fenced; never settles real value while in the weakest trust cell.

---

## 9. Honest caveats — what is real vs demo-fenced

**Real in a v0.1 HNP slice:** the wire crypto (HMAC seal/verify, constant-time compare); catalog re-pricing (invariant 2); scope-contains, cap, window, and revocation checks; the audit trail; the bounded blast radius of a per-action cap. These properties — bound amount, scoped items/merchant, time window, revocable, auditable — are genuinely valuable and worth demoing.

**Demo-fenced / NOT real in v0.1:**
- The grant is **server-HMAC-signed**, so it proves only *"the server issued this grant"* — **not** that the user authorized it, **not** which user. It is *doubly demo*: presence-removed **and** trust-anchor-absent — and must be fenced **harder** than the live rails, because removing the human makes the demo-vs-real gap more dangerous to blur.
- A captured credential claim (`age_over_21`) is a **snapshot** taken at delegation; even with a real signature it can go stale before redemption. The grant must respect the underlying credential's own validity and fail-closed.
- HNP **cannot prevent a faithful-looking, in-scope draw** by a prompt-injected or buggy agent — it can only *bound and audit* it. High-consequence actions should be reserved for live presence or async step-up.

**The issuer-verified / real-control line (state it on every surface):** an HNP grant becomes a *real* safety control only when **all three** hold at once — (1) the Intent Mandate is **user/agent-key-signed** (the v0.2 line 004 already names), (2) the underlying credential is **issuer-verified** (the v0.3 trust-anchor work dc-payment and credential-gate already await), and (3) each draw is a **real proof-of-possession** (KB-JWT / device-signed) over a fresh challenge. **v0.1 has none of the three.** Until they land, an HNP grant must carry `presence: "delegated-demo"` + `trust_level: "presence-only-demo"`, never settle real value, and never be described as a safety control — exactly the discipline 004 applies to the server-HMAC Cart Mandate, lifted one level up the AP2 chain.
