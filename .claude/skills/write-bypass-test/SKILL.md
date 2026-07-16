---
name: write-bypass-test
description: Use when adding or changing a security control in this repo — a gate, a claim check, an amount/discount reconciliation, state keying, or origin/nonce binding — and a test must pin it. Encodes the load-bearing rule that a bypass test must FAIL when its control is deleted. Do NOT use for ordinary feature tests with no security surface.
---

# Writing a bypass test

The repo's testing bar (CLAUDE.md, CONTRIBUTING.md): **a test that would still pass
with the security control removed is not a useful test.** Every control in
[`SECURITY-INVARIANTS.md`](../../../SECURITY-INVARIANTS.md) is pinned by a test that
POSTs the attack and asserts refusal. Reviewers will ask of your diff: *"which test
fails if this line is reverted?"* — this skill makes sure you have an answer.

## The discipline

1. **Name the control and its invariant.** Which of the six invariants does your
   change enforce (or touch)? If none, you may not need a bypass test — stop and
   reconsider whether you're on a security surface at all.
2. **Write the attack, not the happy path.** The test performs what a malicious or
   confused client would do: POST the completion with no verification, hand-edit the
   order token's total, present an `age_over_18` proof to a 21+ gate, replay an
   expired challenge, claim a discount the verification never earned.
3. **Assert the refusal precisely.** Status code AND the typed reason
   (`{ completed: false, reason: "age" }`), not just "didn't succeed". A vague
   assertion can stay green while the control silently changes meaning.
4. **Prove it's load-bearing.** Temporarily disable the control (comment out the
   check, invert the condition), run the test, and confirm it goes **red**. Restore
   the control, confirm green. This step is not optional — it is the whole point.
   Say in the PR which control you deleted to prove it.

## Exemplars in this repo (mirror their shape)

| Attack | Test |
| :-- | :-- |
| Unverified age-restricted order posted straight to completion | `storefront-gate.test.ts` (root) — "REFUSES an age-restricted, unverified order — the handler never runs" |
| Hand-edited (tampered) order total | `ceremony/mount.test.ts` — "refuses a tampered total (re-derived from the catalog, not the token)" |
| Sub-threshold / negative claim (18+ proof at a 21+ gate; `age_over_21 === false`) | `ceremony/credential-gate/credential-gate.test.ts` (CT4) |
| Cross-user / cross-instance state bleed | `client.test.ts` — "two clients keep distinct stores (no cross-instance bleed)" |
| Forged / replayed / expired challenge | `ceremony/challengeToken.test.ts` |
| Presentation sealed for a different origin | `ceremony/mdoc/mdoc-iso.test.ts` — "REJECTS a response sealed under a DIFFERENT origin's session transcript" |

All gate tests live next to the code they pin
(`packages/credentagent-gate/src/**/**.test.ts`). Run one file from the repo root:

```bash
npx vitest run packages/credentagent-gate/src/ceremony/mount.test.ts
```

## Naming

Name the test after the attack it refuses, in caps where the suite does:
`"REFUSES a value-bypass: …"`, `"refuses a tampered total …"`. The test name is
review documentation — a reviewer maps it to the invariant without opening the file.
