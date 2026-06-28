# Project Status — Attesto

_Single source of truth for what's done, what's next, and what's waiting on you._
_Updated **2026-06-28** · `main` · CI green · 160 tests pass._

> **How this file works.** Read it at the start of every working session and update it at the end. It is
> decisions-first: "Decisions for you" (each a checkbox + recommendation), then In flight / next, a rolling
> Done log (linked commits), then standing constraints. Keep it current.

---

## ⏳ Decisions for you

- [ ] **Publish `0.1.0`.** Add the **`NPM_TOKEN`** secret (publish rights to the `@openmobilehub` scope), then
      cut a **GitHub Release** → `.github/workflows/publish.yml` publishes **gate first, then storefront**
      (with provenance). Or publish manually in that order. See `docs/PUBLISHING.md`.
- [ ] **Add the `CLAUDE_CODE_OAUTH_TOKEN` secret** + a `claude-code-review.yml` workflow if you want the
      automated PR review (the org-managed review also covers it).
- [ ] **GDC front-door timing / optional rename.** "Attesto" is contested but chosen for now
      (`docs/naming-clearance.md` has a vetted rename fallback). Confirm before the public GDC push.

---

## 🔨 In flight / next

- **Publish `0.1.0`** — blocked on the `NPM_TOKEN` secret (above). Pre-flight green (CI build+test).
- **Flip the reference demo** — once published, `openmobilehub/mcp-apps-shopping-demo` switches its dependency
  on `@openmobilehub/attesto-*` from the workspace to the published `^0.1.x`.
- **Cart Mandate (004)** — spec ready (`specs/004-cart-mandate/spec.md`); build after publish.

---

## ✅ Done (rolling — newest first)

| What | Where |
| :-- | :-- |
| Repo migrated out of `mcp-apps-shopping-demo` (history-preserved), CI green, branch protection on `main` | this repo |
| Dev + reference docs (`docs/reference/*`, README, ARCHITECTURE, CONTRIBUTING, SECURITY-INVARIANTS) | `docs/` |
| The full ceremony extraction (003): the demo became a thin consumer; the gate is the published library | `specs/003-…` |

---

## 📌 Standing constraints (don't regress)

- **The 6 security invariants** (`SECURITY-INVARIANTS.md`) — a change that breaks one is blocking, even in demo code.
- **Honesty:** `trust_level` stays `presence-only-demo` for the OpenID4VP rails (real wire crypto, no issuer
  trust anchor yet) — never sold as a real safety control. A pro trademark search is advised before publish.
- **DCO** `git commit -s` on every commit; bypass tests must fail with their control removed.
