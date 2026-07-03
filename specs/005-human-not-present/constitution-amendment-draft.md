# DRAFT — Constitution amendment for HNP (Decision 13)

**Status**: proposal only — the constitution itself is untouched. Ratifying = maintainer applies these
edits to `.specify/memory/constitution.md` with the version bump. Required before `/speckit-implement`
of 005 (spec.md, Dependencies).

**Version**: 1.0.0 → **1.1.0** (MINOR: materially expanded guidance on II, III, VII; no principle
removed or redefined incompatibly — every existing rule remains true for human-present flows).

---

## Principle II — amended text

Replace the last sentence block with:

> (1) the MCP tool handler runs ONCE when checkout is requested and only mints the link + reports
> requirements — there is no phone in the loop, so it MUST NOT perform a credential ceremony. It MAY,
> however, **verify a pre-existing delegation grant** minted in an earlier, separate live ceremony:
> redeeming a grant is verification of consent already given, not a new ceremony, and MUST run entirely
> server-side against the full gate chain. (2) the checkout page/phone is where ceremonies actually run —
> including the **delegate ceremony** that mints a grant; (3) a poll reports completion. Conflating these
> contexts is the documented root cause of confusion and is forbidden.

**Rationale**: HNP's redeem path executes in Context 1 with no phone. The old wording ("no credential
ceremony") was written assuming every credential act is a ceremony; delegation splits mint-time (a real
ceremony, Context 2) from redeem-time (server-side verification, Context 1).

## Principle III — amended text

Append:

> These rules govern **human-present** flows. A human-not-present redemption has, by definition, no
> browser session and no live buyer; its consolidation invariant is instead: **one delegate ceremony**
> (itself a single consolidated handoff, per this principle) authorizes a bounded set of later
> redemptions, and **every redemption runs the full server-side gate chain on every completion path**
> (Security Requirements). The agent still only orchestrates and polls; it MUST NOT hold or perform
> authorization itself.

**Rationale**: "one browser session" cannot be satisfied by a flow whose point is that no session
exists. The load-bearing intent — no piecemeal, bypassable verification — is preserved by moving the
consolidation to the delegate ceremony and the seam checks.

## Principle VII — amended text

Replace the first two sentences with:

> Status MUST be carried in types, not prose: `enforcedAt: "tool" | "checkout" | "intent"`, an
> orthogonal **`presence`** axis (`"live" | "delegated-demo" | "delegated"`) carrying *when consent
> happened*, and `trust_level` (`"presence-only-demo" | "server-issued-demo" | "issuer-verified"`)
> carrying *how strongly the authorization is bound* — the live-ceremony/nonce connotation lives on the
> presence axis, not in `trust_level`. `"server-issued-demo"` is WEAKER than `"presence-only-demo"`: it
> proves issuance only, not user authorization. Every `presence: "delegated-demo"` surface MUST carry a
> non-empty `disclaimer`, MUST NOT expose any `authorizedByUser`-style field, and MUST NOT settle real
> value. A real HNP control requires `presence: "delegated"` AND `trust_level: "issuer-verified"`.

**Rationale**: 005 FR-012/FR-014. Two orthogonal facts (when consent happened / how strongly it's
bound) were conflated in one enum; delegation makes the conflation dangerous.

## Terminology ruling (disambiguation)

- **"envelope"** refers ONLY to the Mode-B `verification_required` wire envelope (`envelope.ts`).
- A standing HNP authorization is a **grant** (typed `ap2.IntentMandate`); the merchant's standing
  delegation config is the **delegation policy**. The phrase "spending envelope" MUST NOT be used.

## Mode-B `gated()` ruling

`gated()` and the wire envelope are **retained unchanged** as the page-less blocking primitive,
decoupled from HNP. Async step-up (an HNP redeem answering with a blocking envelope) remains roadmap —
explicitly out of 005's scope.

## Sync impact (on ratification)

- Bump version line to 1.1.0 with amendment date.
- Plan-template Constitution Check: add the presence/trust_level/enforcedAt widenings to the checklist.
- No template structure changes required; CLAUDE.md honesty-fencing section gains the presence axis at
  005 implementation time (not before — the axis doesn't exist in code yet).
