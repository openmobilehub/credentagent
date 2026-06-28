# Naming clearance — "Attesto" (2026-06-28)

A web clearance sweep (signals only — **not** a legal clearance; a professional USPTO + EUIPO
knockout search is still required before committing the name). Two exact-name hits were
independently verified by fetching the live pages.

## Verdict

**Good word, contested name.** The semantic fit (attestation ↔ verifiable credentials) is real and
lands for the EU-wallet / GDC audience, and the `@openmobilehub/attesto` npm handle is free. But the
literal name is in active commercial use by multiple players — two of them inside or adjacent to
Attesto's own identity/security space — and `.com` / `.dev` / `.app` are all taken.

## Exact-name collisions (verified live)

- **attesto.com — Attesto Inc.** (US, founded 2023). AI hiring platform; Sept-2025 "Trust Layer" does
  **identity-fraud detection / identity confirmation** (claims ~95% of application fraud). Owns the `.com`,
  LinkedIn, G2, press. ToS asserts trademark/trade-dress in "Attesto." _Identity-adjacent; high._
- **attesto.dev — "Attesto" by Dimenfinity** (© 2026). **Hardware-signed privileged-access** security
  product — Secure Enclave, biometric, hardware attestation, tamper-evident audit; for SRE/Security teams.
  **Same category as the library, and holds the `.dev` a dev library wants.** _Worst collision._
- **attesto.app** — UK compliance "staff attestation" SaaS (policy sign-offs, audit logs). _Adjacent; high._

## Near-names in the space

- **"Attesso"** (one letter off, near-homophone) — *"payment infrastructure for AI agents — mandates,
  ephemeral cards, SDK"* (api.attesso.com, github.com/Attesso). **Squarely Attesto's lane.** _High confusability._
- **Attestiv** (~$9.2M, AI media-forensics / fraud). **Ethereum Attestation Service / EAS** (attest.org — the
  best-known VC attestation primitive). **Attest** (askattest.com, ~$79M, market research — owns the "Attest"
  root). **OpenAttestation** (GovTech SG, `@govtechsg/open-attestation`). Plus small same-lane SDKs
  (`@usemona/attest-frontend-sdk`, Attestify, YouAttest).

## Trademark signals

- **ATTEST®** — LIVE USPTO reg. 6077675 (Attest Technologies Ltd.), software classes 9/35/42, field =
  market/behavioral research (not identity). Adjacent class, different field → _medium_.
- **No confirmed registered or pending "ATTESTO" mark** surfaced (USPTO/Justia/Trademarkia/EUIPO) — so no
  confirmed registration blocker, but Attesto Inc. has common-law use + an explicit mark claim. EUIPO/TMview
  could not be queried at record level → **a professional EU + US search is the required next step.**

## Term-confusion risk (developer audience)

For *general* devs, "attestation" now skews **software supply-chain provenance** — Sigstore, SLSA, in-toto,
GitHub Artifact Attestations, and especially **npm provenance attestations** (the registry Attesto ships on
has a fixed official meaning for the word). Risk: a dev miscategorizes "Attesto" as a build-provenance tool.
For Attesto's bullseye (EUDI / wallet / VC devs) the word lands correctly. Mitigation if kept: always pair the
name with an identity/consent qualifier ("credential consent for AI agents"), never lead with "attestation."

## Domains (live-site observation only — not registrar availability)

- Taken / live: **attesto.com**, **attesto.dev**, **attesto.app** (all unrelated businesses).
- No live site observed (may or may not be registrable — check a registrar): attesto.io, **attesto.id**
  (most on-brand for identity), attesto.ai, attesto.xyz, getattesto.com.
- Free: `@openmobilehub/attesto` npm scope; no GitHub org literally `attesto`.

## Recommendation

Decide **before** publishing `0.1.0` and before the repo split (both cement the name). Get a professional
USPTO + EUIPO knockout search; weight the **attesto.dev** same-category collision heavily.

**Decision (2026-06-28):** proceed as **Attesto** for now; a rename is a deferred, accepted-cost find-replace.
The vetted alternatives below are kept as reference IF the rename trigger is ever pulled.

## Alternatives shortlist (reference — generated + cleared 2026-06-28)

Search-signal clearance only (medium confidence — TMview/USPTO were rate-limited; any final pick needs a
counsel-run TMview/USPTO/EUIPO clearance in classes 9/36/42). A second sweep also surfaced a **third** exact-name
Attesto collision — **attesto.ai** (verifiable-compliance) — alongside `.dev`/`.com` and the `Attesso` homophone.

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Heralda** | contested | Best on-pitch identity metaphor (a herald authenticates before the gate opens); npm + dev TLDs free, no same-space rival | Phonetically echoes **Hedera** — our own settlement rail |
| **Warrend** | clear | Coined from warrant+ward ("authorized AND defended"); **cleanest clearance of the set** (npm + all 4 domains free) | Reads like a misspelling of "warrant" |
| **Avowa** | contested | Best pure "consent" fit (from *avow*); npm + GitHub free | Phonetic nearness to **Avoco** (UK identity/age-verification — same crowd); premium `.com` |
| Pledgewire | clear | "consent on the wire"; fully registrable | "pledge" skews crowdfunding/payments |
| Proviso / Cedo / Sigl | contested | Decent concepts | Same-space history (Proviso=KYC), security homophone (Cedo→Ceedo), taken npm token (Sigl) |
| ~~Threshold / Credenza / Vellum / Voucher~~ | **blocked** | — | Funded same-space incumbent owns the name+pitch (Threshold Network / Credenza / Vellum AI / generic coupon word) |

**If switching:** the analysis recommended **Heralda** (if the Hedera echo is tolerable when said aloud next to
the settlement rail at GDC) → else **Warrend** (maximally safe) → else **Avowa** (if "consent-first" is paramount).

Tracked as resolved **D0** in `STATUS.md` (proceeding as Attesto; this shortlist is the rename fallback).
