# Architecture

How Attesto is put together, for contributors. Attesto is **the consent layer for AI
agents**: an AI agent must prove a verifiable credential from the user's phone wallet
before a consequential action — a payment, an age gate, an access grant — completes.
**Identity leads; payments is one application** of the same gate.

This repo is two npm packages:

| Package | What it is | Public surface |
| :-- | :-- | :-- |
| [`@openmobilehub/attesto-gate`](../../packages/attesto-gate) | The Gate — the policy DSL, the `requirements()` resolver, and the `mount()` ceremony that serves the `/attesto/*` verification rails. | `new Attesto()`, `attesto.requirements(order, policy)`, `attesto.mount(app)` |
| [`@openmobilehub/attesto-storefront`](../../packages/attesto-storefront) | The agentic storefront core — a runnable MCP shopping server (cart → priced cart → order, nine tools, a widget, a checkout page), catalog-injected. | `createStorefront()` |

The reference DEMO that runs both packages on every surface (Claude, ChatGPT, Goose,
Claude Code) lives in the separate
[mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo) repo —
linked, not duplicated here.

> **Honest status — read this first.** Trust is **presence-only** today
> (`trust_level: "presence-only-demo"`). The *wire* crypto is real — WebAuthn on the
> passkey rail; OpenID4VP JWE / ECDH-ES decrypt with nonce binding, HPKE, and an ISO
> 18013-5 mdoc parse on the credential and payment rails. What is **not** yet in place is
> an **issuer / device-signature trust anchor**, and the AP2-shaped mandate is dev-signed
> (an integrity hash, not key-bound). A self-crafted mdoc would pass. **Never present a
> presence-only gate as a real safety control.** Issuer-verified trust (`trust_level:
> "issuer-verified"`) is the v0.2 line.

---

## How the two packages compose: publish-seams → read-seams → zero glue

The packages stay decoupled. `attesto-gate` never imports `express`, a catalog, or any
store — it operates over **structural** types. `attesto-storefront` is the *only* side that
imports `attesto-gate`, and the pure pricing core (`attesto-storefront`'s `.` entry point)
doesn't even do that. They meet at exactly one place: `app.locals.attesto`.

```ts
const store = createStorefront();   // stands up the MCP server; PUBLISHES seams on store.app.locals.attesto
const attesto = new Attesto();
attesto.mount(store.app);           // READS those seams off app.locals.attesto and wires /attesto/* — zero args
store.gate((order) =>               // resolved on every checkout call (payment settles LAST)
  attesto.requirements(order, [
    required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),
    required(payment.in("usd")),
  ]),
);
const { url } = await store.listen(3005);
```

The "zero glue" is literal. `createStorefront()` pre-binds the ceremony seams over *its
own* stores + catalog and assigns them to `app.locals.attesto`
([`packages/attesto-storefront/src/server.ts`](../../packages/attesto-storefront/src/server.ts), `createStorefront`):

```ts
app.locals.attesto = {
  orderStore: ceremonyOrderStore,      // resolve a created order by id
  verificationStore,                   // per-order age/loyalty state (shared with completion)
  catalog: ceremonyCatalog,            // server-side re-pricing — the amount source of truth
  completion,                          // completeOrder bound over THIS server's stores
  ...(opts.signingKey ? { signingKey: opts.signingKey } : {}),
  allowEphemeralKey: opts.allowEphemeralKey ?? !opts.signingKey,
};
```

Then `new Attesto().mount(store.app)`, called with **no** ceremony argument, takes the
"zero-arg compose" path
([`packages/attesto-gate/src/client.ts`](../../packages/attesto-gate/src/client.ts), `Attesto.mount`): it sees
`orderStore`, `catalog`, and `completion` already on `app.locals.attesto`, hands them to
`mountCeremony`, and — because the host already supplied its own `verificationStore` — uses
*that* store so the rails write the exact per-order state the host's `completion` seam reads
back (Security invariant 4). `Attesto` injects its own per-order store *only* when the host
didn't supply one.

The relationship is intentionally one-directional and optional: `attesto-gate` is a pairing
the storefront *can* mount, not a dependency the pricing core carries.

---

## The `mount()` injected-seam contract

`mountCeremony(app, options)` is the heart of the Gate side
([`packages/attesto-gate/src/ceremony/mount.ts`](../../packages/attesto-gate/src/ceremony/mount.ts)). It reads the
seams the host provides — from `options` **or** from `app.locals.attesto`, options winning —
**fails fast** when a load-bearing one is missing (never silently degrades), resolves a
`CeremonyContext`, re-exposes the resolved seams back onto `app.locals.attesto` (so a re-mount
is idempotent and the storefront's own routes resolve verification *through* Attesto), and
registers each rail's routes.

### `CeremonySeams` — what the host injects

| Seam | Required? | Role |
| :-- | :-- | :-- |
| `verificationStore` | yes | Per-order verification state (age proven / loyalty applied). **Never process-global** — keyed by order id (invariant 4). |
| `orderStore` | yes | Resolve a *created* order by id. Totals are always re-priced from `catalog`, so this only recovers line items + id. |
| `catalog` | yes | `createOrder(items, id, opts)` — the **server-side re-pricing** seam, the amount source of truth (invariant 2). |
| `completion` | yes | Host-bound completion (idempotent record + cart / verification clear). Every rail records through this one seam. |
| `signingKey` | yes\* | Stable HMAC key for the challenge nonce. \*Required *unless* `allowEphemeralKey` is set, so an `options → verify` hop survives a serverless instance split. |
| `origin` | no | RP-id / origin derivation; defaults to the built-in `deriveOrigin`. |
| `settlement` | no | Optional demo-mode settlement (e.g. on-chain x402). Absent ⇒ mock-complete. |
| `allowEphemeralKey` | no | Dev-only escape hatch for a per-process signing key. **Never inferred** — `mount()` does not guess "serverless". |

The fail-fast is deliberate and load-bearing: `mountCeremony` collects every missing required
seam and **throws** with a message naming them, rather than booting a half-wired gate. The
signing-key rule is enforced separately — without a stable key and without an explicit
`allowEphemeralKey`, it throws, because an ephemeral per-process key would break the challenge
HMAC across a serverless instance split (the `options` request and the `verify` request can
land on different instances).

### `CeremonyContext` — what each rail receives

Once validated, the seams become a `CeremonyContext` with every required seam present (and a
resolved `signingKey` / `origin`). A `RailRegistrar` is just
`(app: CeremonyApp, ctx: CeremonyContext) => void`. `CeremonyApp` is a **minimal structural
type** — `{ locals }` plus optional `get` / `post` / `use` — so the package carries no
`express` dependency; a real Express app satisfies it, and a route-less `{ locals }`-only app
(used by the fail-fast tests) is also valid because each rail no-ops when it can't route.

### `resolveOrder` — the shared re-pricing gate

`mount.ts` also exports `resolveOrder(ctx, orderId)`, which **every** rail route funnels the
order through. It reads the created order from `orderStore`, refuses a tampered / unknown id
(`null`), reads *this* order's verification to decide whether the loyalty discount opts in,
and then **re-prices from the catalog** — so the displayed and bound amounts come from the
catalog, never the order id/token (Security invariants 2 and 3). This is why a hand-edited
order token cannot move money: the token is recovered for its line items only; the price is
re-derived.

---

## The three rails + the dcql / request / verify / page / routes mirror pattern

`mount()` registers a fixed list of rail registrars
([`mount.ts`](../../packages/attesto-gate/src/ceremony/mount.ts), `RAILS`):

```ts
const RAILS: RailRegistrar[] = [registerCredentialGate, registerPasskeyGate, registerDcPaymentGate];
```

| Rail (`/attesto/*`) | What it proves | Standard / crypto | Trust today |
| :-- | :-- | :-- | :-- |
| `credential-gate` | Age (`age_over_21 === true`) / loyalty membership | OpenID4VP (Android Chrome) **+** org-iso-mdoc (iOS WebKit), one DCQL/doc-spec each | `presence-only-demo` |
| `passkey` | A WebAuthn assertion → an AP2-shaped payment mandate | WebAuthn same-device + cross-device caBLE (`@simplewebauthn`) — **real cryptography** | real WebAuthn crypto |
| `dc-payment` | An amount-bound payment presentation | Digital Credentials API + signed OpenID4VP with amount-bound `transaction_data` | `presence-only-demo` |

Each rail is a **self-contained directory** under
[`packages/attesto-gate/src/ceremony/`](../../packages/attesto-gate/src/ceremony/) that mirrors the same split.
A new gate **mirrors this structure** rather than copying it:

| File | Responsibility |
| :-- | :-- |
| `dcql.ts` | The DCQL query the wallet receives — doctype + claim leaves (selective disclosure, never-retain). The credential rail derives it from the package's own `credentials.ts` builders so the wire request and the policy layer can't drift. |
| `request.ts` | Builds the **real** signed OpenID4VP request — a reader cert (`@peculiar/x509`), an ephemeral ECDH response-encryption key, a fresh nonce, ES256-signed (`jose.SignJWT`), with the reader context (key + nonce, and for payment the amount-bound `transaction_data`) sealed into a JWE for `verify`. |
| `verify.ts` | The two-paths-one-policy verifier: an **instant-demo** claims path (the tested default, no wallet round-trip) and a **real presentation** path (JWE/ECDH-ES decrypt, nonce/origin binding, ISO-mdoc parse) — both feeding the *same* policy check / deterministic gates. |
| `page.ts` | The server-rendered gate page, drawn through the shared design system ([`theme.ts`](../../packages/attesto-gate/src/ceremony/theme.ts)) so the whole ceremony reads as one branded flow. Drives `navigator.credentials.get({ digital })` synchronously inside the tap (a pre-fetched request, to keep the transient user-activation iOS WebKit needs). Every surface states `presence-only-demo`. |
| `routes.ts` | The `RailRegistrar`. Wires `GET <page>`, `GET <…>/request`, `POST <…>/verify` onto the host app; resolves **every** route's order through `resolveOrder`; reads the verify body from a host parser *or* straight off the request stream (so the rail never requires `express.json()`); records a successful verification scoped to the order id; and completes through `ctx.completion`. |

Concretely, by rail:

- **`credential-gate/`** — `dcql.ts`, `request.ts`, `verify.ts`, `page.ts`, `routes.ts`, plus
  `doc-spec.ts` (the single ISO doctype the iOS org-iso-mdoc path requests) and
  `mdoc-verify.ts` (the iOS HPKE-decrypt path). Routes: `/attesto/credential`,
  `/attesto/credential/request`, `/attesto/credential/verify`.
- **`passkey/`** — `verify.ts`, `page.ts`, `routes.ts` (no `dcql`/`request` — WebAuthn options
  come straight from `@simplewebauthn/server`, and the AP2 mandate + four gates live in the
  shared [`mandate.ts`](../../packages/attesto-gate/src/ceremony/mandate.ts)). Routes:
  `/attesto/passkey`, `/attesto/passkey/options`, `/attesto/passkey/verify`, plus a
  `use`-mounted `/attesto/lib/sw/*` that serves the `@simplewebauthn/browser` ESM same-origin
  (no CDN) with path-traversal containment.
- **`dc-payment/`** — `dcql.ts`, `request.ts`, `verify.ts`, `page.ts`, `routes.ts`, plus
  `txData.ts` (the single source of truth for the amount-bound `transaction_data`). Routes:
  `/attesto/dc-payment`, `/attesto/dc-payment/request`, `/attesto/dc-payment/verify`.

Shared, reused-not-copied helpers sit one level up: the ISO-mdoc machinery in
[`ceremony/mdoc/`](../../packages/attesto-gate/src/ceremony/mdoc/) (`mdoc-iso.ts`, `reader.ts` with
`makeReaderCert` / `makeEncryptionKey`, `readerContext.ts`), the AP2 mandate + the four
deterministic gates in `mandate.ts`, origin derivation in `origin.ts`, and the stateless
signed challenge in `challengeToken.ts`. A new rail reuses these rather than re-implementing
them.

---

## The shared `completeOrder` seam — one path for every rail

There is exactly **one** completion path. Both payment rails (`passkey`, `dc-payment`) call
`ctx.completion(input)`; the host binds that seam to the package's `completeOrder`
([`ceremony/completion.ts`](../../packages/attesto-gate/src/ceremony/completion.ts)) over its own stores. This is
where the load-bearing security invariants are enforced once, for all rails, in order:

1. **Gates.** Every deterministic gate in the mandate must pass, else refuse — recording
   nothing (`reason: "gates"`).
2. **Idempotency.** A replayed verify for an already-recorded order echoes the recorded
   outcome — it settles / records nothing twice. Checked *before* re-pricing (completion
   clears the order's verification, so a replayed discounted order would otherwise reprice
   high and refuse).
3. **Re-price (invariant 2 + 3).** Re-price the lines from the catalog; the loyalty discount
   counts only when *this* order's verification says it was applied. A token claiming a total
   that doesn't match is refused (`reason: "reprice"`).
4. **Age gate (invariant 1).** If any re-priced line is age-restricted, the order must carry a
   positive per-order age claim (written by the credential rail's verify handler) or it is
   refused (`reason: "age"`). This is the shared-seam half of the "enforce on every completion
   path" rule — the passkey and dc-payment rails get the age check *for free* even though they
   never touch the credential rail.
5. **Settlement (optional).** When a `settle` seam is configured, a throw **gates** completion:
   authorized-but-not-settled, no record written, cart intact.
6. **Record + clear.** Write the completed record (mandate id, amount, gates, instrument,
   settlement), clear the cart, and clear this order's per-order verification.

Because every rail reconciles its amount against the *same* re-pricing logic, a discount one
rail accepts and another refuses is impossible by construction (invariant 3).

---

## Adding a new gate or credential

There are two extension points, depending on whether you're adding a *credential* (a new thing
to prove) or a *rail* (a new ceremony surface).

### A new credential — `defineCredential` (no new code path)

Most extensions are just a new credential the existing credential rail already knows how to
serve. Define it with `defineCredential` + `dcql` + an effect builder
([`packages/attesto-gate/src/credentials.ts`](../../packages/attesto-gate/src/credentials.ts)) and drop it into the
same policy array — no registration step:

```ts
import { defineCredential, dcql, gate, required } from "@openmobilehub/attesto-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,                 // explicit positive claim (invariant 5)
  effect: gate(),                                     // or discount({ percent }) / authorize()
  appliesTo: (order) => order.lines.some((l) => l.requiresRx),
  ui: { label: "Prescription", action: "Verify prescription" },
});
// …then: required(prescription) in the policy you pass to attesto.requirements(order, policy)
```

The three effect builders — `gate()`, `discount({ percent })`, `authorize()` — are the only
effects the `requirements()` resolver interprets; `authorize` always sorts last (payment
settles last). `.when((order) => boolean)` AND-composes a call-site predicate onto any
definition-time `appliesTo`.

### A new rail — mirror an existing one

A genuinely new *ceremony* (a different protocol or surface) is a new directory under
`ceremony/` that **mirrors the `dcql` / `request` / `verify` / `page` / `routes` split** of
`dc-payment` / `credential-gate`, exports a `RailRegistrar`, and is added to the `RAILS` array
in `mount.ts`. The contract a new rail must honor:

- Register through the structural `CeremonyApp` (`app.get?` / `app.post?` / `app.use?`) and
  **no-op when the app can't route**, so the fail-fast tests stay green.
- Take **no** `express` dependency; read the verify body via the shared host-parser-or-stream
  helper.
- Resolve **every** route's order through `resolveOrder(ctx, …)` (re-pricing; refuse a
  tampered/unknown id).
- Keep WebAuthn / OpenID4VP bound to the server's origin / RP-id with nonce/replay protection,
  using the injected `signingKey` and `origin` seams (invariant 6) — reuse `origin.ts`,
  `challengeToken.ts`, and the `mdoc/` helpers rather than copying them.
- Scope any verification state by order id via `ctx.verificationStore` — never process-global
  (invariant 4).
- Complete through `ctx.completion` — never a second completion path — so re-pricing, the age
  gate, settlement, and state-clearing behave identically across rails.
- Carry `trust_level: "presence-only-demo"` on every surface until a real issuer/device trust
  anchor lands (v0.2).
