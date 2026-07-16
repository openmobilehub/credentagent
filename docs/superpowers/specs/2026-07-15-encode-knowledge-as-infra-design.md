# Encode domain knowledge as infrastructure

**Date:** 2026-07-15 · **Branch:** `encode-knowledge-as-infra`

## Why

Boris Cherny's automation thesis, applied to this repo: an agent (or reviewer) that
re-catches the same class of issue on every PR burns tokens and misses cases; a lint
rule, CI step, or REVIEW.md automates that class forever, and encoded domain knowledge
lets anyone — human or agent — contribute on day one with zero extra context from the
prompter. This repo already does the hard parts (CLAUDE.md invariants,
SECURITY-INVARIANTS.md with bypass tests, a quickstart smoke test in CI, an
`add-ceremony-rail` skill). This change closes the four gaps.

## What

### 1. `REVIEW.md` + review-workflow wiring

- **`REVIEW.md` (repo root)** — the executable review checklist. It orchestrates, not
  duplicates: a diff-trigger table mapping what a PR touches to which
  SECURITY-INVARIANTS.md invariant to check, the delete-the-control bypass-test rule,
  the DX-rubric quick gate (example-is-the-test), the honesty bar, and which checks are
  now mechanical (lint) so reviewers don't spend attention there.
- **`claude-code-review.yml`** — replace the stock template body: ground the prompt in
  `REVIEW.md`, skip drafts (making CONTRIBUTING.md's claim true), and add a
  self-validation step that fails the job if the PR edits the review workflow itself
  (making CLAUDE.md's claim true).
- Inline doc fix: CONTRIBUTING.md says CI pins Node 20; ci.yml uses Node 22.

### 2. Lint layer encoding lintable invariants

Minimal, surgical ESLint 9 flat config at root (`eslint` + `@typescript-eslint/parser`
only — no style preset, zero code churn). Three domain rules, each verified to fire on
a violation and pass on the clean tree:

- **Seam-only completion** (invariant 1): files in a rail dir
  (`ceremony/<rail>/`) may not import `completion.js`; they must complete through the
  injected `ctx.completion` seam.
- **No module-global mutable state** (invariant 4): top-level `let`/`var` and
  top-level `new Map()`/`new Set()`/`new WeakMap()` are banned in both packages' `src`
  (tests excluded). Per-order state lives behind `VerificationStore`.
- **No `Math.random()` in the gate** (invariant 6-adjacent): anything random in the
  security surface uses `node:crypto`. The one existing use (mock display id in
  `mandate.ts`) gets a justified inline disable.

`npm run lint` at root + a lint step in the CI `build-test` job.

### 3. DCO auto-sign-off hook

`scripts/git-hooks/prepare-commit-msg` appends the `Signed-off-by:` trailer from
`git config user.name/email` when missing (idempotent). Activated by a root `prepare`
script setting `core.hooksPath` on `npm install`. Documented in CONTRIBUTING.md.
Generic for all contributors — no hardcoded identity.

### 4. Skills

- **`.claude/skills/write-bypass-test/`** — encodes the "test must fail when the
  control is deleted" discipline with the repo's real exemplar tests.
- **`.claude/skills/publish-release/`** — wraps `docs/PUBLISHING.md` (publish order is
  load-bearing: gate before storefront; honesty gate at publish). Fixes the stale
  `build:packages` command in PUBLISHING.md.

## Out of scope

A general style preset (typescript-eslint recommended / Prettier) — large churn, low
signal for this repo; revisit separately if wanted. No changes to package source
behavior; the only source edit is one comment line.

## Verification

`npm run build`, `npm run typecheck`, `npm test`, `npm run lint` all green in the
worktree; each lint rule demonstrated to fire by temporarily introducing its violation;
every commit DCO-signed.
