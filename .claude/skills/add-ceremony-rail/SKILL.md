---
name: add-ceremony-rail
description: Use when adding a new authorization gate ("ceremony rail") to the credentagent-gate package — a new way to prove a credential/consent before a consequential action (a new presentation protocol, auth method, or credential type). Scaffolds the standard rail split, honors the security invariants, and requires load-bearing bypass tests. Do NOT use for changing an existing rail's logic, or for storefront/pricing work.
---

# Adding a ceremony rail to the gate

A rail is a self-contained authorization gate under
`packages/credentagent-gate/src/ceremony/<rail>/`. Every completion path it opens
is a security surface. A new rail MIRRORS an existing one — it does not bolt onto
one, and it does not copy shared helpers.

## Pick the archetype

- **OpenID4VP / presentation rail** (like `dc-payment`, `credential-gate`) — the
  user presents a verifiable credential. Files: `dcql.ts` · `request.ts` ·
  `verify.ts` · `page.ts` · `routes.ts` (+ `<rail>.test.ts`, `presentation.test.ts`).
- **WebAuthn / device rail** (like `passkey`) — no presentation. Files:
  `verify.ts` · `page.ts` · `routes.ts` (+ `<rail>.test.ts`).

Read the closest existing rail end-to-end before writing anything.

## Steps

1. **Scaffold** `src/ceremony/<rail>/` mirroring the chosen archetype's file split.
   Keep each file to its one job: `dcql` = the query, `request` = the signed
   OpenID4VP request, `verify` = parse + check the response, `page` = the browser
   approve page + its JS, `routes` = wire the HTTP endpoints.
2. **Reuse, don't copy.** Import `makeEncryptionKey` from `ceremony/mdoc/reader.ts`
   and the mdoc parsers from `ceremony/mdoc/`. If you're copy-pasting crypto or
   parsing, stop — factor it into `mdoc/` or a shared helper instead.
3. **Wire routes** in `routes.ts` as `export function register<Name>Gate(app, ctx)`:
   - `GET  /credentagent/<rail>` → the approve page (`page.ts`)
   - `GET  /credentagent/<rail>/request` → the signed request for `navigator.credentials.get`
   - `POST /credentagent/<rail>/verify` → verify, then complete **through the shared
     `ctx.completion` / `completeOrder` seam** — never a rail-local completion.
4. **Register the rail:** add `register<Name>Gate` to the `RAILS: RailRegistrar[]`
   array in `ceremony/mount.ts`. That array is the only registration point.
5. **Thread the cart** (statelessOrders): the `?cart=<base64url>` param must survive
   every hop — decode it on the GET routes (`decodeCartMandateParam`), accept
   `cart`/`cartMandate` in the verify POST body, carry it in the page's `returnUrl`
   and any device toggle. Dropping it 404s the store-less checkout. (This is the
   exact bug class that bit dc-payment's ungated place-order and the passkey toggle.)
6. **Honor the invariants** (`SECURITY-INVARIANTS.md`) — the load-bearing ones for a rail:
   - #1 enforce server-side in `/verify` **AND** the shared `completeOrder` — hiding a button is not enforcement.
   - #2 re-derive amounts from the catalog; never trust the order token.
   - #4 scope verification state per session/order — never process-global.
   - #5 require the explicit positive claim (`age_over_21 === true`), matching the product threshold.
   - #6 keep WebAuthn/OpenID4VP bound to this origin/RP-ID; seal + check the nonce.
7. **Honesty:** keep `trust_level: "presence-only-demo"` unless a real issuer/device
   trust anchor is wired. Don't ship copy implying issuer-verified trust.

## Bypass tests are mandatory (and load-bearing)

For each control, write a test that FAILS when the control is deleted:

- POST an **unverified** gated order → assert it is **refused**.
- POST with the **wrong / insufficient claim** (18+ proof at a 21+ gate) → refused.
- POST a **tampered order token / cart mandate** → re-derived amount mismatch → refused.
- Assert **cross-order/session state cannot bleed** (one order's verification does not unlock another).

> A test that still passes with the control removed is not a test. Prove it: delete
> the check, run the test, confirm it goes RED, restore the check.

## Verification before you claim done

- `npm run build` (typecheck) green in the gate workspace.
- `npm run test` green; the new bypass tests present and each verified red-when-removed.
- The rail appears in `RAILS[]` and its routes resolve under `/credentagent/<rail>`.
- README API surface + `docs/reference/api.md` updated if the rail is public.
- Commit with `-s` (DCO); push a branch in-repo (not a fork) so `claude-review` runs.

## Red flags — stop if you catch yourself thinking:

| Thought | Reality |
|---|---|
| "The page hides the pay button when unverified, so it's gated." | Hiding UI is not enforcement — the `/verify` + `completeOrder` paths are. |
| "I'll reuse the amount from the order token." | Order tokens are hand-editable; re-derive from the catalog. |
| "One shared verification key is simpler." | Process-global state = cross-user bleed. Key by order/session. |
| "It decrypts, so the presentation is trusted." | Decryption ≠ trust. Check the nonce, the origin, the positive claim. |
| "I'll copy makeEncryptionKey into the rail." | Reuse `mdoc/reader.ts`; copies drift and rot. |
| "The happy-path test passes, ship it." | If it passes with the control removed, it proves nothing. |
