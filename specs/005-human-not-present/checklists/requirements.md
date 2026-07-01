# Specification Quality Checklist: Human-Not-Present (HNP) Delegation — First Increment

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-29
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — *behaviors + seams named at the contract level (mandate type, rail, stores), no language/framework choices*
- [x] Focused on user value and business needs — *pre-authorized agent action while the human is away, bounded + revocable*
- [x] Written for non-technical stakeholders — *user stories in plain language; honesty fencing explained in plain terms*
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — *decisions baked in from research; flagged for confirm/override in the callout, not blocking*
- [x] Requirements are testable and unambiguous — *each FR maps to an acceptance scenario / bypass test*
- [x] Success criteria are measurable — *SC-001…SC-006 are pass/fail and control-dependent*
- [x] Success criteria are technology-agnostic — *outcomes (refused / completes / labeled / fail-closed), not framework internals*
- [x] All acceptance scenarios are defined — *4 user stories, Given/When/Then each*
- [x] Edge cases are identified — *grant-predates-order, stale claim, price drift, store unreachable, concurrent draw, confused deputy*
- [x] Scope is clearly bounded — *smallest honest slice; explicit Out of Scope (v0.2+)*
- [x] Dependencies and assumptions identified — *004/003 deps + the Decision-13 constitution amendment; assumptions listed*

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows — *delegate→redeem happy path, bounds-as-controls, revocation, honesty*
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **Maintainer confirmation pending** on the Group-A honesty decisions (1–3) — surfaced in the spec's top callout.
  These are recommendations from the research, not settled; confirm/override before `/speckit-plan`.
- **Governance dependency (Decision 13):** a narrow MINOR constitution amendment (Principles II/III) is a
  prerequisite for `/speckit-implement`; it is a separate `/speckit-constitution` step, not part of this spec.
- **Adversarial review applied (2026-06-29):** a 4-lens review (invariants / honesty / faithfulness /
  real-code feasibility, reading the actual `openmobilehub/attesto` source) found 3 blockers + 9 majors + 7
  minors; all were fixed in the spec. Key corrections: `completeOrder` gains an additive **fail-closed** branch
  (not "unchanged" — the seam re-checks, closing an invariant-1 hole); the cap is an **absolute ceiling**
  (tolerance = 0); HNP gets its own honesty values (`presence: delegated-demo` + `trust_level:
  server-issued-demo`, never reusing `presence-only-demo`); age **always steps up**; single-use uses an
  **atomic** consume; the grant is disclosed as a **bearer** token (invariant 6 only partial); `RevocationStore`
  needs **real** seam glue; honesty expressed as machine-checkable positives.
- The spec is ready for `/speckit-plan` once the maintainer **confirms the baked-in decisions** (esp. the
  Group-A honesty calls and the Decision-13 constitution amendment).
