# Tasks: A spending grant that survives a restart and a second server

Design: [`spec.md`](spec.md) · Issue: #152

Five tickets, each one pull request, each safe to merge alone. "A" and "B" are two `Grants`
instances sharing one store. Every ticket's tests must fail with its control removed.

## T001 — The store seam, and a grant that can be read and decided on any instance

- `GrantStore`, `SavedGrant` and `MemoryGrantStore` in the gate package; `grantStore` on
  `CredentAgentOptions`. Default: memory, so nothing changes without it.
- `Grants` keeps the record in the store. Create, retrieve, approve (page mode), deny, revoke and
  recording a proof go through compare-and-replace (spec rule 1).
- The four internal readers become `async`; `grants-serve.ts` and the signing rail await them.
- A grant authorized on another instance refuses a spend with a clear code until T002 — never
  spends from a guess.
- Tests: created on A, read on B; approved on A, re-checked on B; approve and deny at once;
  a proof after authorize is refused; no `grantStore` behaves as today.
- Size: about 350 lines with tests.

## T002 — Spend and revoke on any instance

Needs decision 1.

- Save the sealed intent and the agent key at authorize; rebuild `DelegatedGrant` from them
  (spec rule 5). `DelegatedGate` uses the store's ledger and completed-spend records.
- Saved answers per idempotency key replace `rec.cache`.
- Tests: approved on A, spent on B; same key on A and B is one charge; revoked on A during a
  spend on B; device-signed on A spends on B with the signed key; an edited saved grant is refused.
- Size: about 350 lines with tests.

## T003 — The Redis store

Needs decisions 2 and 3.

- `redisStorage().grantStore` in the storefront package: the record with compare-and-replace, the
  ledger's atomic `commitDraw`, spend records, time-to-live.
- One contract suite run against both `MemoryGrantStore` and the Redis store (over the test
  double `redis.test.ts` already uses, extended with `eval`).
- Tests: two different spends at once where one fits the budget; store unreachable refuses.
- Size: about 300 lines with tests.

## T004 — One signing nonce, one secret

- The signing rail consumes its nonce through the store (`consumeNonce`), so a signature cannot
  be replayed on another instance.
- A device-signed grant with a shared store and no `gateSecret` fails at construction with the fix
  in the message (a per-process secret cannot verify another instance's request).
- Tests: the same signature posted to A then B is refused.
- Size: about 120 lines with tests.

## T005 — Turn it on

- The quickstart passes `grantStore`; the comment that grants are per-process goes.
- `doctor()` warns about a memory grant store on a deployment.
- Both READMEs, `ARCHITECTURE.md`, the changelog.
- After merge: on `credentagent.ai/marketplace-dev`, create a grant, wait fifteen minutes, open
  the approve link; approve it and confirm the agent's re-check reports `authorized`.
- Size: about 150 lines.
