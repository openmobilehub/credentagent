# Trademark knockout-search request — project rename (DRAFT for LF counsel)

> ⚠️ **STALE — reconcile before sending (maintainer decision).** Since this brief was
> drafted, the project **adopted `CredentAgent` as its working name** — the code, the npm
> packages (`@openmobilehub/credentagent-*`), and all docs are already renamed to it. The
> finalist shortlist below (Consentinel / Attorn / Creance / Assentio / Poder) **predates
> that decision** and does not include CredentAgent.
>
> The tension counsel must be told about: `naming-clearance.md` **benched** CredentAgent —
> it had the *cleanest exact clearance* of any candidate (npm + `.com/.dev/.io` all free,
> zero exact hits) but is *weak as a mark* — so choosing it was a deliberate call for
> instant comprehension over distinctiveness. If you send this, the honest ask is a
> knockout on **CredentAgent as the primary mark, carrying its known flags**: (1) the
> generic **"-Agent" suffix** adds no distinctiveness and names the agent, not the consent
> layer; (2) the **crowded "cred-" root** — Credant Technologies (Dell-acquired data
> security, a homophone), CredenTek ("Agentic AI" services, same field), two Credent IT
> firms, Credence adjacency; (3) it says *credential*, not *consent* (the identity half,
> not the authorization differentiator). Keep the five below as **fallbacks if CredentAgent
> knocks out.** **Decision needed before this goes to counsel — do not send as-is.**

**Draft to forward to LF trademark counsel (Daniel Scales / OWF).** Distilled from
`docs/naming-clearance.md` (the working research log — signals only, nine web/npm sweeps + a
naming council). This asks counsel for the one thing the sweeps cannot provide: a professional
**USPTO + EUIPO knockout** on a short finalist list so a name can be committed.

## Why we're renaming

LF brand counsel ruled (2026-07-02) that a **fused "…MCP"** name (our current `AttestoMCP`) implies
the project is run by the MCP project (AgenticAI Foundation trademark) and violates the
[LF trademark policy](https://lfprojects.org/policies/trademark-policy/) unless "MCP" is used
**descriptively** ("X for MCP" is fine; a fused "XMCP" is not). The MCP association is preserved in
the **tagline**, not the mark: *"— the consent gate for MCP agents."* We need a distinctive base
name that stands on its own.

## What the project is (for class/field context)

An open-source **library** (npm, published under `@openmobilehub/…`) — a **consent/authorization
layer for AI agents**: an agent must present a verifiable credential from the user's phone wallet
before a consequential action (payment, age gate, access grant) completes. EUDI-wallet / OpenID4VP
/ WebAuthn ecosystem; audience is identity + wallet + AI-agent developers. Part of Open Mobile Hub
(Linux Foundation).

**Suggested search scope:** classes **9** (software), **36** (payment/financial), **42** (SaaS/dev
tools); US common-law + EUIPO. Flag same-field identity/security/AI-agent and payment marks most
heavily.

## Finalist shortlist (ranked; full rationale in `naming-clearance.md`)

| # | Candidate | One-line fit | Specific flag for counsel to weigh |
| :- | :-- | :-- | :-- |
| 1 | **Consentinel** | consent + sentinel — parses on first hearing; runaway winner of the cold-hearing panel; npm free, `.dev/.io/.ai` open | `.com` registered but bare (holder unknown); generic "Sentinel" security crowd (SentinelOne, MS Sentinel) — assess dilution/coexistence |
| 2 | **Attorn** | real legal verb, root of *attorney* ("to acknowledge/transfer authority to act for another"); npm free, `.com` open | very short mark; may read law-tech; check phonetic "a turn" |
| 3 | **Creance** | falconer's tether = bounded autonomy + *lettres de créance* = credential; highest analytical score; npm + `.com/.dev/.io` all open | French *créance* = "receivable" (finance dilution in FR markets); Credence/Cerence adjacency |
| 4 | **Assentio** | Latin "I assent"; npm free, `.com/.dev/.io` open | Assent Inc. (assent.com, supply-chain compliance) owns the "assent" root — adjacent field; German *assentio GmbH* (staffing, far field) |
| 5 | **Poder** (conditional) | Spanish for *power* and the everyday word for a **power of attorney** (*otorgar poder*); npm + `.dev` free | **US doctrine of foreign equivalents** — translates to "Power"; Microsoft POWER marks live in software. This is the make-or-break counsel question for Poder |

**Backups if the top five knock out:** Durward (Old English "door-ward", clean signals) or Agensent
(cleanest clearance but a written-form typo risk).

## The ask

1. Run a knockout on the five (or the top three if scope is limited: **Consentinel, Attorn,
   Creance**) in classes 9/36/42, US + EU.
2. Confirm the descriptive-tagline pattern (*"[Name] — the consent gate for MCP agents"*) is
   acceptable under the LF policy for whichever name clears.
3. Return the cleared subset; the team picks from those.

## What unblocks once a name clears

The rename is a known-size mechanical find-replace (~171 sites across code + docs, same job as the
prior `AttestoMcp → AttestoMCP` casing pass). After it: add `NPM_TOKEN` → publish `0.2.0` → flip the
reference demo → 004/005 build. The rename is the single blocker in front of that whole chain
(`STATUS.md`).
