# Feature Specification: A spending grant that survives a restart and a second server

**Issue:** #152 · **Date:** 2026-11-11 · **Branches:** `feat/152-*`, one per ticket in [`tasks.md`](tasks.md)
**Builds on:** spec 009 (spending grants), spec 012 (device-signed grants), spec 014 (AP2 delegation), the per-order requirements epic (#442)
**Status:** design for review. Three decisions are open ([Decisions](#decisions-for-the-maintainer)); nothing is built yet.

## In plain terms

A **spending grant** is the limit a person approves once so their agent can buy while they are
away. Today a grant lives in the memory of the one server process that created it. On Vercel any
request can land on any instance, and instances are recycled, so:

- the approve link stops working — it answers "We don't recognise this grant" (seen on
  `credentagent.ai/marketplace-dev` on 2026-11-11, about ten minutes after the grant was made);
- an approval made on one instance is invisible to the agent's re-check on another;
- an authorized grant, and everything spent against it, is lost on a restart.

This spec moves a grant's state behind one injectable store, the way an order's proofs already are
(`VerificationStore`). The default stays in memory, so local development is unchanged. A deployment
passes a shared store and every instance sees the same grant.

## Where a grant lives today

| State | Where | Survives a restart or a second instance? |
| --- | --- | --- |
| The record: status, limits, `allow`, proofs, signing evidence (`GrantRecord` in `grants.ts`) | a `Map` in `Grants` | No |
| The agent key a device-signed grant is bound to (`delegateKeys`) | the same record, as a non-extractable `CryptoKey` | No |
| The sealed intent and its signer (`DelegatedGrant`, made at authorize) | an object on the record | No |
| What was spent, and whether it was revoked (`MemoryRevocationStore`) | a `Map` inside `DelegatedGate` | No |
| Completed spends, for a safe retry (`CompletionContext.records`) | a `Map` inside `DelegatedGate` | No |
| The answer each idempotency key already got (`rec.cache`) | a `Map` on the record | No |
| One-at-a-time changes per grant (`KeyedMutex`) | this process only | No — two instances do not exclude each other |
| Single-use signing nonces (`memoryNonceGuard`) | a `Set` in the signing rail | No — a signature could be replayed on another instance |
| The secret that seals a signing request (`signingSecret`) | random per process unless `gateSecret` is set | No |

## The surface (caller-first)

```js
import { redisStorage } from "@openmobilehub/credentagent-storefront/redis";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const storage = redisStorage.fromEnv({ required: deployed });

const credentagent = new CredentAgent({
  walletOrigin,
  catalog,
  gateSecret: process.env.GATE_SECRET, // already required on a deployment
  grantStore: storage?.grantStore,     // NEW — omit it and grants stay in memory, as today
});
```

Nothing else changes for a caller: `grants.create()`, `grants.retrieve()`, `grant.spend()`,
`grant.revoke()` and `grants.serve(app)` keep their shapes and results.

## The store

One interface in the gate package, with a memory default and a Redis implementation in the
storefront package next to `redisStorage`:

```ts
export interface GrantStore {
  /** The whole saved grant, or undefined. */
  read(grantId: string): MaybePromise<SavedGrant | undefined>;
  /** Save a new grant. Refuses an id that already exists. */
  create(grant: SavedGrant): MaybePromise<boolean>;
  /** Replace the grant ONLY if its saved version is still `expectedVersion`. False = someone else changed it first. */
  replace(grant: SavedGrant, expectedVersion: number): MaybePromise<boolean>;
  /** The spend ledger for this grant: revocation, single use and the total cap, decided in one atomic step. */
  ledger: RevocationStore; // the existing interface, unchanged
  /** The answer an idempotency key already got, saved once. */
  readSpend(grantId: string, key: string): MaybePromise<SavedSpend | undefined>;
  saveSpend(grantId: string, key: string, spend: SavedSpend): MaybePromise<void>;
  /** Use a signing nonce once. False = already used. */
  consumeNonce(nonce: string, ttlSeconds: number): MaybePromise<boolean>;
}
```

`SavedGrant` is plain JSON: the record's fields, a `version` number, the sealed intent once
authorized, and the agent key in the form [decision 1](#decisions-for-the-maintainer) settles.

### Rules

1. **Every change to a grant is compare-and-replace.** Authorize, deny, revoke and recording a
   proof read the grant, check the status, and `replace` it at the version they read. A lost race
   re-reads and re-checks. This is what the per-process `KeyedMutex` did; the mutex stays as a
   cheap first step inside one process.
2. **The ledger decides money atomically.** `commitDraw` already makes the three decisions (not
   revoked, key unused, total not exceeded) in one step. The Redis implementation does it in one
   script, so two instances cannot both spend the last dollars.
3. **Revoke wins.** `revoke()` marks the ledger first, then the record — the order it uses today —
   so a spend in flight on another instance is refused when it commits.
4. **Nothing is guessed.** A grant the store does not hold is unknown: the approve page says so,
   and a spend is refused. A store that errors refuses (as `revocation-unavailable` does today).
5. **The engine is rebuilt, never re-sealed.** An instance that did not authorize the grant rebuilds
   `DelegatedGrant` from the saved sealed intent and the agent key. It never mints a new intent or
   a new key: the person's signature covers the original ones.
6. **Limits stay sealed.** What is saved at create is frozen as today. A saved grant is never
   widened by a later write: `replace` callers change status, proofs (pending only) and evidence,
   never `opts`.

### What changes inside `grants.ts`

- `records: Map` becomes the store. The four internal readers the signing rails call
  (`_intentSignInputsFor`, `_allowedSkusFor`, `_boundsInputFor`, `_engineDelegateFor`) become
  `async`; their callers in `grants-serve.ts` and `intent-sign/routes.ts` await them.
- `Grant.status` is read from the store at `retrieve()`. The handle no longer reflects a later
  change by itself; callers that re-check call `retrieve()` again (the storefront already does).
- `DelegatedGate` takes the store's ledger (`revocation`, an option it already has) and its
  completed-spend records.

## What we validate

Each test must fail if its control is removed (the repo's bypass-test rule). "A" and "B" are two
`Grants` instances sharing one store.

| Scenario | Expected |
| --- | --- |
| Created on A, read on B | Same grant, same approve page |
| Approved on A, re-checked on B | `authorized` |
| Approved on A, spent on B | Completes; A reads the same remaining budget |
| Same idempotency key spent on A and B | One charge; the other gets the replay |
| Two different spends, A and B at once, only one fits the budget | One completes, one is refused `budget-exceeded` |
| Revoked on A while a spend runs on B | The spend is refused `revoked` |
| Approve on A and deny on B at once | Exactly one wins; the grant is never both |
| A proof recorded after the grant authorized | Refused, on either instance |
| Device-signed on A, spent on B | Spends with the key the person signed for; a different key is refused |
| The same signature posted to A then B | The second is refused (nonce already used) |
| A saved grant's sealed intent edited to raise its total, then spent | Refused — the intent's id is a hash of its contents and no longer matches |
| Store unreachable | Spend refused; approve page shows an error, never "approved" |
| No `grantStore` passed | Everything behaves as today, in memory |
| `doctor()` on a deployment with the memory grant store | Warns, naming the fix |

## Not in scope

- A database other than Redis (the interface allows one; none ships).
- Listing a person's grants, or the grant page showing purchases (#406).
- Expiry and revocation of a phone-signed permission the agent holds (#239).
- Issuer-verified trust. `trust_level` values are unchanged.
- Making production refuse to start without a shared store. That lands with the per-order
  equivalent (#448) so both stores change together; here it is a `doctor()` warning.

## Decisions for the maintainer

Each has a recommendation. Ticket T2 onward depends on 1 and 2.

1. **How does the agent key reach the instance that spends?** Today it is a non-extractable key
   that never leaves the process, on purpose (`generateDelegate`). A second instance cannot spend
   without it.
   - **(a) Save it encrypted with `gateSecret`** (a JWE, the same primitive `sealReaderContext`
     uses). *Recommended:* it is the mechanism the gate already uses and reviews. The key becomes
     extractable inside the gate; reading Redis alone is not enough to spend.
   - (b) Derive it from `gateSecret` and the grant id, saving nothing private. No private key at
     rest, but it adds hand-written elliptic-curve key derivation to review.
   - Either way a grant made before a `gateSecret` rotation can no longer be spent.
2. **What does Redis have to support?** `RedisLike` today is `get` / `set` / `del`. Rules 1 and 2
   need an atomic step.
   - **(a) Add `eval` to `RedisLike`** and do compare-and-replace, the ledger commit and the nonce
     in small scripts. *Recommended:* Upstash supports it, and it is the only way the total cap
     holds across instances.
   - (b) Keep `get` / `set` / `del` and accept that two instances can overspend at the same
     moment. Not recommended: it breaks the cap the person approved.
3. **How long is a grant kept?** A grant has no expiry of its own today. *Recommended:* a pending
   grant for 7 days; an authorized, denied or revoked one for 400 days from creation (a
   phone-signed mandate is signed for a year). Spend records and ledger entries live as long as
   their grant.

## Rollout

Grants made before the deploy are in memory and are lost at that deploy, as they are at every
deploy today. No migration is needed. The changelog entry says a deployment should pass
`grantStore`, and that `gateSecret` must be stable for device-signed grants.
