# Naming clearance — "AttestoMCP" (2026-06-28)

A web clearance sweep (signals only — **not** a legal clearance; a professional USPTO + EUIPO
knockout search is still required before committing the name). Two exact-name hits were
independently verified by fetching the live pages.

## Verdict

**Good word, contested name.** The semantic fit (attestation ↔ verifiable credentials) is real and
lands for the EU-wallet / GDC audience, and the `@openmobilehub/attestomcp` npm handle is free. But the
literal name is in active commercial use by multiple players — two of them inside or adjacent to
AttestoMCP's own identity/security space — and `.com` / `.dev` / `.app` are all taken.

## Exact-name collisions (verified live)

- **attestomcp.com — AttestoMCP Inc.** (US, founded 2023). AI hiring platform; Sept-2025 "Trust Layer" does
  **identity-fraud detection / identity confirmation** (claims ~95% of application fraud). Owns the `.com`,
  LinkedIn, G2, press. ToS asserts trademark/trade-dress in "AttestoMCP." _Identity-adjacent; high._
- **attestomcp.dev — "AttestoMCP" by Dimenfinity** (© 2026). **Hardware-signed privileged-access** security
  product — Secure Enclave, biometric, hardware attestation, tamper-evident audit; for SRE/Security teams.
  **Same category as the library, and holds the `.dev` a dev library wants.** _Worst collision._
- **attestomcp.app** — UK compliance "staff attestation" SaaS (policy sign-offs, audit logs). _Adjacent; high._

## Near-names in the space

- **"Attesso"** (one letter off, near-homophone) — *"payment infrastructure for AI agents — mandates,
  ephemeral cards, SDK"* (api.attesso.com, github.com/Attesso). **Squarely AttestoMCP's lane.** _High confusability._
- **Attestiv** (~$9.2M, AI media-forensics / fraud). **Ethereum Attestation Service / EAS** (attest.org — the
  best-known VC attestation primitive). **Attest** (askattest.com, ~$79M, market research — owns the "Attest"
  root). **OpenAttestation** (GovTech SG, `@govtechsg/open-attestation`). Plus small same-lane SDKs
  (`@usemona/attest-frontend-sdk`, Attestify, YouAttest).

## Trademark signals

- **ATTEST®** — LIVE USPTO reg. 6077675 (Attest Technologies Ltd.), software classes 9/35/42, field =
  market/behavioral research (not identity). Adjacent class, different field → _medium_.
- **No confirmed registered or pending "ATTESTOMCP" mark** surfaced (USPTO/Justia/Trademarkia/EUIPO) — so no
  confirmed registration blocker, but AttestoMCP Inc. has common-law use + an explicit mark claim. EUIPO/TMview
  could not be queried at record level → **a professional EU + US search is the required next step.**

## Term-confusion risk (developer audience)

For *general* devs, "attestation" now skews **software supply-chain provenance** — Sigstore, SLSA, in-toto,
GitHub Artifact Attestations, and especially **npm provenance attestations** (the registry AttestoMCP ships on
has a fixed official meaning for the word). Risk: a dev miscategorizes "AttestoMCP" as a build-provenance tool.
For AttestoMCP's bullseye (EUDI / wallet / VC devs) the word lands correctly. Mitigation if kept: always pair the
name with an identity/consent qualifier ("credential consent for AI agents"), never lead with "attestation."

## Domains (live-site observation only — not registrar availability)

- Taken / live: **attestomcp.com**, **attestomcp.dev**, **attestomcp.app** (all unrelated businesses).
- No live site observed (may or may not be registrable — check a registrar): attestomcp.io, **attestomcp.id**
  (most on-brand for identity), attestomcp.ai, attestomcp.xyz, getattestomcp.com.
- Free: `@openmobilehub/attestomcp` npm scope; no GitHub org literally `attestomcp`.

## Recommendation

Decide **before** publishing `0.1.0` and before the repo split (both cement the name). Get a professional
USPTO + EUIPO knockout search; weight the **attestomcp.dev** same-category collision heavily.

**Decision (2026-06-28):** proceed as **AttestoMCP** for now; a rename is a deferred, accepted-cost find-replace.
The vetted alternatives below are kept as reference IF the rename trigger is ever pulled.

> **Update (2026-07-02): the rename trigger IS pulled.** LF brand counsel (Daniel Scales) ruled that "MCP"
> in the name suggests the project is run by the MCP project (AgenticAI Foundation trademark) and violates
> the LF trademark policy unless used **descriptively** — "X for MCP" is fine, a fused "XMCP" is not. See
> [#80](https://github.com/openmobilehub/credentagent/issues/80). The shortlists below are now **live candidates**, not reference. Whatever the pick, the MCP
> association survives in the tagline ("X — the consent gate for MCP agents"), which counsel's pattern allows.

## Alternatives shortlist (reference — generated + cleared 2026-06-28)

Search-signal clearance only (medium confidence — TMview/USPTO were rate-limited; any final pick needs a
counsel-run TMview/USPTO/EUIPO clearance in classes 9/36/42). A second sweep also surfaced a **third** exact-name
AttestoMCP collision — **attestomcp.ai** (verifiable-compliance) — alongside `.dev`/`.com` and the `Attesso` homophone.

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

## Second sweep (2026-07-02) — consent/agent fusions, post-counsel-ruling

Brief: names fusing **agent + consent/attestation**. Same method (npm registry + web + live-domain probes);
same caveat (signals only — the counsel-run USPTO/EUIPO knockout in classes 9/36/42 is still required).

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Consentinel** | clear-ish | consent + sentinel — parses on first hearing as "a sentinel guarding consent"; the sentinel doubles as the agent-acting-for-you metaphor (the HNP story). npm free; `.dev/.io/.ai` no DNS; **no company/product hits** | `.com` registered but bare (title-only placeholder, holder unknown); 4 syllables; generic "Sentinel" security crowd (Microsoft Sentinel, SentinelOne) |
| **Assentry** | clear-ish | assent + sentry + entry (*entry upon assent*); short. npm free; `.dev/.io` no DNS | `.com` = small India/UK audit-consulting firm (different space); "assent" fainter than "consent"; misreads ("a sentry", "ascentry") |
| **Proxent** | clear-ish | proxy + consent — "consent held by a proxy" is literally the delegation product. npm free; `.dev/.io` no DNS; no company/product hits | `.com` registered (302 redirect, holder unidentified); "prox-" skews proxy/infra tooling |
| Wardent | unswept | ward + warden coinage; npm free; `.com/.dev` no DNS | web sweep not done; reads like a "warden" typo; not consent-specific |
| Placet | unswept | Latin "it pleases" — the historical formal vote of **assent**; npm free; `.com` no DNS | obscurity (general devs won't parse it); web sweep not done |

**Killed in this sweep:** Consentry (npm taken; active CONSENTRY LIMITED UK; ConSentry Networks ghost in LAN
security), Attestant (Bitwise's $4B ETH-staking brand + the attest- root crowding above), Procura (AlayaCare's
healthcare-software brand), Consentia (records-management firm + the consent-management SaaS crowd), Mandata
(live `.com`; UK haulage TMS), Agentry (SAP), and avouch / vouchsafe / countersign / legatus / imprimatur /
depute (npm tokens taken).

### Third sweep (2026-07-02, same day) — "agent" fused in + "Open" prefix

Brief: names that *contain* "agent" (leveraging the accident that **agent and consent share the "-ent"
ending**, and Latin ***agens*** = "the one acting"), plus LF-house-style **Open** combinations.

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Agensent** | **cleanest of all sweeps** | *agens* (Latin: the acting one) + assent + reads as "agent-sent" — a triple pun that IS the product (the agent draws under your assent). npm free; `.com/.dev` no DNS; **zero company/product hits** | Pronunciation ambiguity (AY-jen-sent vs a-JEN-sent); "agent" only implied for readers who miss the Latin |
| Consagent | clear-ish | consent ∪ agent overlapped on "-ent"; npm free; no company hits | `.com` live (unidentified); misreads as **"con's agent"** (fraudster) |
| Agensio | unswept | agens + -io (the Consentio pattern); npm free | `.com` registered (redirect); web sweep not done |
| OpenAssent | clear-ish | LF house pattern (OpenWallet, Open Mobile Hub); npm free; `.com/.org` no DNS | descriptive = weakly protectable mark; "assent" fainter than consent |
| OpenCeremony | dark horse | "ceremony" is both the repo's own vocabulary AND the WebAuthn spec's official term for auth flows; npm free; `.com/.dev` no DNS | says *how* (ritual) not *what* (consent); wedding connotation |
| ~~Agentio / OpenConsent / OpenMandate / OpenPact~~ | **blocked** | — | Agentio = $340M creator-ads startup (Series B, Forbes list); OpenConsent = a crowded ecosystem (OConsent protocol, Visible Privacy, GitHub orgs, openconsent.com); OpenMandate + OpenPact = npm tokens taken |

### Fourth sweep (2026-07-02) — the power-of-attorney family

Brief: *"the consent layer for agents to act on behalf of humans — like a power of attorney."* The Intent
Mandate **is** a limited power of attorney (bounded, revocable, time-limited, registered), so the legal
acting-for-another vocabulary was swept: PoA terms across legal traditions.

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Attorn** | **clean** | Real legal verb ("to acknowledge/transfer authority") — the root of *attorney* = "one appointed to act on another's behalf." npm free; `.com` no DNS; **zero company hits** | Obscure verb; may read law-tech |
| **Perpro** | clear-ish | *Per procurationem* — the **"p.p."** humans have signed on letters for centuries when authorized to act for another. "p.p. for AI agents" is a ready-made talk line. npm free; `.com/.dev` no DNS | PERPRO LTD (small UK co) + PERPROS (HK web shop) — both far from the space |
| ~~Prokura~~ | blocked-ish | German/Nordic **bounded corporate signing authority** (a *Prokurist* signs for the firm within statutory limits, registered, revocable) — conceptually THE product | Kearney-owned consultancy brand (`prokura.com/.dev`); procurement confusion |
| ~~Stead / Gestor / Fiducio~~ | contested | "in your stead" / the Spanish acts-for-you professional / the fiduciary root | stead.global + Stead Software (software shops); `gestor` a common Spanish code word, `.com` live; Fiducia/Atruvia adjacency, `.com` live |
| ~~behest / sayso / ombud / behalf / delega~~ | **blocked** | great acting-for-another words | npm tokens all taken |

Regardless of the name pick, the fourth-sweep brief hands us the **pitch line**: *"a bounded, revocable
power of attorney for AI agents."*

### Fifth sweep (2026-07-02) — naming-council output

A 5-persona generator panel (legal-Latin scholar, portmanteau wordsmith, devtools brand strategist, EUDI
insider, polyglot poet) × 3 judge lenses (brief-fit, stage-clarity, ownability) produced **43 new candidates**.
Convergence signal: the council — not told about the fourth sweep — independently re-derived **Perpro** and
**Attorn** as its #1 and #2. New names, post npm/domain/web verification:

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Assentee** | clean-ish | **absentee → assentee**: while the human is *absentee*, the agent acts as the *assentee* — the party your assent was formally granted to (the legal -ee of trustee/grantee). The best pure HNP pun of any sweep. npm free; `.com/.dev` no DNS | **Assent Inc.** (assent.com, supply-chain *compliance* software) owns the root word in an adjacent-sounding category; may be misheard as "absentee" |
| **Adnutum** | **clean** | civil-law revocation *ad nutum* — "at a nod": a mandate revocable at the principal's mere nod. Bounded-revocable in one real doctrine. npm free; `.com` no DNS; zero hits | Obscure Latin — the story must be told before the name lands |
| **Jussu** | clean-ish | Roman law *actio quod iussu* — the principal is bound **because he ordered it**; *jussu meo* = "by my order". npm free; `.dev` no DNS; zero company hits | `.com` parked; pronunciation drift ("JUS-soo"/"YUS-su") |
| Nodary | clear-ish | notary + nod — the witness that records your nod of assent. npm free | `.com` live (unidentified); Node.js / TUF-Notary echoes |
| Affido | clear-ish | Italian *affidare* "I entrust" — the *fides* root winks at both *affidavit* and **FIDO/WebAuthn**, the product's actual rail. npm free | `.com` live; in Italian *affido* commonly means child foster care; f/ff spelling drift |
| Indult / Agrant / Byleave / Handfast / Agensign | second tier | canon-law bounded permission / "a grant"+agent / "by your leave"+believe / the hand-clasp consent ceremony / *agens*+sign | all npm-free; `.com` live for the first two; weaker judge scores or search-dilution |

### Sixth sweep (2026-07-02) — stewardship, statute, and permission across languages

Brief: more, from unexplored veins — medieval stewardship, UK LPA statute, tort doctrine, Icelandic/Arabic/
Turkish permission-and-mandate words.

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Volens** | **clean** | *volenti non fit iniuria* — the common-law **doctrine of consent** itself; *volens* = "the willing one." npm free; `.com/.dev` no DNS; zero company hits | Latin opacity; "willing" needs the doctrine told |
| **Umbod** | **clean** | Icelandic *umboð* = **mandate / agency / power of attorney** (*umboðsmaður* = agent-at-law — the root of *ombudsman*). npm free; `.com` no DNS; zero hits | Unfamiliar; "um-bod" can sound hesitant ("um…") |
| **Donee** | clean-ish | the **exact statutory term** in UK lasting-power-of-attorney law for the person empowered to act on the donor's behalf. npm free; `.dev` no DNS | `.com` taken; donee/donor confusion; "donate" echo |
| Izin | clear-ish | Turkish/Indonesian for **permission**; two syllables, spells itself. npm free; `.com` no DNS | Indonesian licensing-portal associations (regional) |
| Venia | contested | Latin *venia* = permission/leave/grace (*venia docendi*). npm free; `.com` no DNS | **Adobe's Venia** — the Magento/PWA reference *storefront* — same commerce demo space |
| ~~Castellan~~ | **blocked** | holds the castle in the lord's absence — perfect HNP metaphor | Castellan Solutions (Riskonnect) + castellan.net + Warhammer's Knight Castellan |
| ~~locum / seneschal / reeve / troth / custos / marque / tessera~~ | **blocked** | good acting-for-another words | npm tokens taken |
| ~~Mandato / Tutela / Sanad / Bidden / Handsel / Grantee / Firman~~ | contested | PoA (ES/IT) / Roman guardianship / Arabic trust-chain / "as bidden" / token-sealed bargain / grant receiver / royal license | live `.com`s (Tutela Technologies, Gulf Sanad brands, FIRMAN generators); weaker stories |

**Maintainer-suggested check (2026-07-02): ~~Consentio~~ — contested, ruled out.** Latin "I consent"; npm
free, but **Consentio Platform SL** (Barcelona, $14.2M, active 2026) runs a B2B **commerce/ordering platform**
under the name (`.co/.com/.io`) — transaction-workflow software, uncomfortably close to a checkout-gating
library — and a second Consentio (`consentio.cloud`) sells compliance software. The exact "good word,
contested name" pattern that flagged Attesto.

**Its clean cousin: Assentio** (Latin *"I assent"* — same first-person-verb shape and "-io" music). npm free;
`.com/.dev/.io` **unregistered** (`.ai` taken); only exact-name hit is assentio GmbH, a small German
recruiting/staffing firm far from the space. Shares Assentee's root-word flag (Assent Inc., supply-chain
compliance). **Added to the queue's strong seconds.**

### Team spreadsheet review (2026-07-02) — all 19 entries annotated

Full verdicts for the team's candidate sheet (Google Sheets, "Pick your top 3"). npm tokens were free for all
newly-checked entries unless noted; the blocks are companies/products, not tokens.

| Entry | Verdict | Why |
| :-- | :-- | :-- |
| Consent Rail | weak | no exact collision, but two-word descriptive (weak mark) + crowded CMP/cookie-consent category |
| Grant Gateway | ❌ blocked | "Grants Gateway" is the **literal name of New York State's enterprise grants system** (grantsmanagement.ny.gov) + Maryland's Grants Gateway Portal; grantgateway.com live; two generic words = near-unprotectable |
| Grantix | ❌ contested | GrantiX co. (LinkedIn); `grantix.com/.io` live; funding-grant miscategorization |
| Trustify | ❌ blocked | npm token published; Trustify Inc. (US) collapsed in a fraud scandal (CEO convicted) |
| Confirma | ❌ blocked | **Confirma Software** — Nordic software group, 530+ employees, 17k customers |
| Trustix | ❌ blocked | active EU/NLnet-funded OSS trust project (nix-community) + defunct Trustix Secure Linux |
| ConsentioAgent | ❌ rejected | contains **Consentio Platform SL's** active mark + generic "-Agent" = implied affiliation (the same defect counsel ruled against for "MCP") |
| SureSign | ❌ contested | Suresign = established health-diagnostics brand (owns `.com`); e-sign connotation crowded |
| Autentiq | ⚠️ contested | near-names in the **same identity space**: **authentik** (popular OSS IdP), Authentiq (IdP app); reads as a misspelling |
| TrustWave | ❌❌ blocked | **Trustwave** — major global cybersecurity company (MSSP, SpiderLabs); hardest block on the sheet |
| Permiso | ❌❌ blocked | **Permiso Security** — identity security incl. **AI-agent/MCP runtime** (May 2026 launch); our exact space; npm taken |
| Yesly | ❌ blocked | **YESLY** — Finder's smart-home product line (major EU electronics maker) |
| Agreeon | clear-ish | no collision found; reads as the phrase "agree on"; near Agreon/Aggregion |
| AgentTry | clear-ish | no collision found; meaning unclear ("agent try"?) — weak concept |
| TrustRail | ❌ blocked | **trustrail.ai** — AI compliance platform (EU AI Act, ISO 42001); same AI-governance space |
| **Endorso** | ✅ **cleanest on the sheet** | no hits; npm free; *endorse* = signing over authority (real concept fit); domains unswept — **added to the bench** |
| AttestoAgent | ❌ rejected | re-imports **all three original Attesto collisions** (attesto.com / attesto.dev same-category / attesto.app) + the Attesso homophone + generic "-Agent" — the name the project already renamed away from |
| VeriAgent | ⚠️ weak | no exact hit, but "veri-" is a crowded root (Verisign, Veriff, Verily) + generic "-Agent" |
| Confido | ❌ blocked | **Confido** (YC S21 fintech, funded) + Confidosoft + the notorious 2017 Confido ICO exit scam |
| AgentAssent | clear-ish | added by the team 2026-07-02; clean sweep (npm + domains free, no hits; Assent Inc. root adjacency) — the **uncompressed form of Agensent**: same two words, unfused; 4 syllables, weaker as a mark than the fusion |

Net: 11 of 20 contested/blocked, including every starred pick on the sheet. Clean survivors: **Endorso** and
**AgentAssent** (whose compressed form, Agensent, is already the queue leader).

**Family ruling — ~~"Consent-" + Latin suffix~~ (2026-07-02):** the derivative space is **saturated**: Consento
(npm + key-sharing project), Consentra (compliance automation), Consentua (consent mgmt), Konsento (GDPR SaaS),
Consentio (×2 companies), Consentia, Consentry, Consentric — plus the CMP industry. The still-unclaimed strings
(Consentum / Consenta / Consenza / Consentus / Consenti) are each one letter from an active consent-tech mark:
likelihood-of-confusion territory, weak and typo-leaky even where technically free. What works is carrying
"consent" audibly while **breaking the `Consent-` prefix shape**: **Consentinel**, **Prinsent**, **Proxent**
(all already in the queue).

**Family ruling — ~~anything "Gateway"~~ (2026-07-02):** npm tokens are free, but the category is claimed:
**agentgateway** is a **Linux Foundation project** (Solo.io-donated, Agentic AI Foundation orbit — the same
foundation that hosts MCP) and "gateway" in agent infrastructure now means **traffic proxy** (also Docker MCP
Gateway, IBM ContextForge MCP Gateway) — a consent library named "___ Gateway" reads as routing middleware and
squats a sibling LF project's category. Gate ≠ gateway: the checkpoint metaphor ("gate") stays in the package
name + tagline (`…-gate`, "the consent gate for MCP agents"); "-gate" as a brand suffix collides with the
scandal suffix. Distinctive brand on top comes from the finalist queue.
Recommendation to the team: add the cleared finalists (**Agensent · Prinsent · Assentio · Perpro · Attorn** +
Endorso) as new rows and star among those.

**Team-suggested check (2026-07-02): ~~ConsentioAgent~~ — rejected.** Fuses a third party's **active mark**
(Consentio Platform SL, commerce software) with the generic suffix "Agent" — literally reads as "an agent of
Consentio" (implied affiliation: the same defect counsel just ruled against for "MCP", different victim), adds
zero trademark distinctiveness, and is 5 syllables / awkward as a package token. What the team liked about it
survives cleanly elsewhere: **Agensent** is the same two morphemes fused (agent + consent, clean clearance),
and the literal phrase lives in the tagline ("… — the consent gate for MCP agents").

**Maintainer-suggested check (2026-07-02): ~~Permiso~~ — BLOCKED, the hardest collision of all checks.**
**Permiso Security** (permiso.io, Palo Alto) is an identity-security platform for human, non-human **and AI
identities**, and in **May 2026** launched AI-agent runtime security covering agent runs, tool calls **and MCP
servers** — the library's exact space (identity + AI agents + MCP). npm token also taken. The
permission-in-another-language slot in the queue is **Izin** (Turkish/Indonesian, sixth sweep, clear-ish).

**Maintainer-suggested check (2026-07-02): ~~Grantix~~ — contested, ruled out.** npm free, but
`grantix.com` + `grantix.io` are live and a **GrantiX** company exists (LinkedIn). Worse: in software, "grant"
reads as **funding grants** — grant-management SaaS is a large crowded category (Fluxx, Instrumentl,
Foundant…) — so the name miscategorizes the library on first hearing (the OAuth "authorization grant" reading
is on-brief but can't be forced). Same dated "-ix" air as Trustix. The grant root survives on the bench as
**Agrant** ("a grant" + agent).

**Maintainer-suggested check (2026-07-02): ~~Trustix~~ — contested, ruled out.** npm + `.com/.dev/.io` free,
BUT an **active open-source software-trust project** owns the name: nix-community/trustix (distributed trust
for binary caches; Tweag-announced, **EU NLnet/NGI-funded** — the same EU orbit as our EUDI/GDC audience).
Also the defunct Trustix Secure Linux (Comodo), TRUSTiX USA (consultancy), live `trustix.ai`, and the
"trust-" root is as crowded as "attest-".

### Seventh sweep (2026-07-02) — the triad: agents + humans + consent

Brief: all three parties in one name. Key lever: agency law's word for the human is **the principal** — a word
that only exists relative to an agent, so it carries the agent implicitly.

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Prinsent** | **clean** | **principal + consent** — "the principal's consent" is the agency-law answer to the triad (a principal implies an agent), with a third echo: it *sounds like "present"* — the human-present ceremony. npm free; `.com/.dev` no DNS; zero hits | One letter from **Pinsent Masons** (major international law firm) — must be weighed at knockout; may be heard as "present"/"prin-cent" |
| **Humansent** | clean-ish | **human + (as)sent** — "authority, human-sent": the agent acts on what the human sent. Spells itself; the HNP story in plain English. npm free; `.dev` no DNS; no company hits | `.com` live (unidentified); literal/plain vs. brandable; near-name Humand (YC HR app) |
| Kinsent | clean-ish | kin + consent; npm free; `.com` no DNS | "kin" = family, not humans generally; weaker triad fit |
| Concordat | second tier | a formal agreement between two authorities (the human and the agent as parties); npm free; `.dev` no DNS | `.com` registered; no consent/agent sound; churchy-diplomatic register |
| ~~Entente / Consentric / Humanod / Humandate~~ | **blocked** | agENT+consENT→entENTE / consent+concentric (human at the center) / human+nod / human+mandate | npm taken (Entente); Consentric = prior UK consent-management product (npm taken); humanoid misread + live `.com`; "human date" misread + registered `.com` |

### Eighth sweep (2026-07-02) — naming council round 2

Five fresh personas (mythologist, radio-procedure nerd, falconry/heraldry historian, diplomatic-protocol
expert, synthetic namer) × 3 judges with a quality bar pegged to the queue leaders; 46 new candidates.
Post-verification survivors:

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Creance** | **clean** | the falconer's **training tether** — the long line that lets a hawk fly *autonomously within bounds* — from Old French *créance* (trust), the same word as a diplomat's **lettres de créance**: bounded autonomy + credential in one real word. npm free; `.com/.dev/.io` all unregistered; zero hits | pronunciation split (KREE-ance / cray-ONCE); French *créance* = "receivable" (finance dilution in francophone markets); Credence/Cerence adjacency |
| **Dedimus** | clear-ish | the chancery writ ***Dedimus potestatem*** — "we have given power": bounded authority granted to a **named person** for **one specific act** on another's behalf — the Intent Mandate as a centuries-old instrument. npm + `.dev` free | `.com` registered; tiny far-space hits ($89 "Dedimus Potestatem" legal-forms software, a Cyprus shell); Latin opacity |
| Persign / Keyturn / Annuo / Ratum | second tier | per+sign ("p.p." made plain) / the two-man-rule key turn / Latin "I nod assent" / Roman ratification (*ratum habere*) | persign.com live; Keyturn web-unswept; Annuo/Ratum obscure + web-unswept |
| ~~Nuncio / Protem / Spondeo / Revoco~~ | **blocked** | herald with credentials / pro-tempore / Roman consent pledge / "I recall" (revocation) | npm taken (Nuncio, Protem); Spondeo = Polish services firm; revoco.com registered (UK recruiter) |

**Maintainer ear-test (2026-07-02): Agensent demoted.** Said aloud, it parses as "sent by Agen" (a
*typo* of agent — the "-sent" verb reading amputates "agens") and carries a **godsend/heaven-sent** religious
register. The agens+assent+agent-sent layering works only on paper. Same "-sent" structure flags **Humansent**.
Kept on the list (clearance remains the cleanest) but no longer a leader.

### Verdict council (2026-07-02) — cold-hearing panel + analytical judges + Agensent adjudication

Judge-only council: 5 cold-hearing personas (conference attendee, EU non-native dev, security skeptic,
journalist, budget VP) scored the **bare names** with no stories or clearance data; a brand strategist + a
trademark attorney scored with full dossiers; an impartial adjudicator ruled on the maintainer's two Agensent
charges. Scoreboard (cold /50 + analysis /20):

| Name | Cold | Analysis | Combined | The cold panel's ear |
| :-- | :-- | :-- | :-- | :-- |
| **Consentinel** | **40** | 13 | **53** | *"decodes itself in real time — you hear consent and sentinel fuse mid-word"*; only name with essentially no mishearing risk; survives DE/ES/FR accents (shared Latin roots) |
| **Attorn** | 24 | 16 | 40 | strong on paper; aloud = *"a turn"* / *"attorney cut off mid-word"* |
| **Creance** | 21 | **18** | 39 | highest analytical score, but the panel couldn't spell it after hearing (*Creance/Créance/Kreeance*) and misheard *"clearance"/"credence"/"crayons"* |
| **Assentio** | 28 | 10 | 38 | 2nd-best aloud; but *Asensio* (footballer) spelling fork, Assent Inc. adjacency, and it starts with "Ass-" from a stage |
| **Volens** | 21 | 15 | 36 | crisp, but at speed smears toward *"violence"* — bad neighbor for a security product |
| Agensent | 20 | 13 | 33 | unstable stress; *"agent scent"*, *"adjacent"*, *"pharmaceutical name"* |
| Perpro | 19 | 11 | 30 | *"PrePro"* (production slang), *"-Pro SaaS sea"* |
| Dedimus / Prinsent / Assentee | 16/17/11 | 13/7/10 | 29/24/21 | Latin opacity / heard as *"present"* + Pinsent Masons kills the trademark score / heard as *"absentee"* |

**Agensent adjudication:** typo charge **upheld but inverted** — *spoken*, natural t-deletion makes it a clean
homophone of "agent-sent" (the stage is its safest surface); the defect is **written**, at the write-down
moment (readers repair "Agen" to a misspelling; npm/search traffic bleeds to "agentsent"), mitigable via
defensive registrations + a one-line gloss. Religious charge **rejected** (the providential register lives in
"god-"/"heaven-", not "-sent"; cf. Resend, unsent; security branding tolerates Kerberos — a hell-hound). **Not
fatal**, but a stronger undiagnosed defect surfaced: the "-sent/-send" slot reads as **delivery/messaging
infrastructure** (Resend, SendGrid, Airsend) — category drift for a consent gate. Disposition: demotion was
right; viable **fallback**, not leader.

### Ninth sweep (2026-07-02) — gatekeepers, guardian spirits, and permission across languages

| Candidate | Signal | Fit | Top risk |
| :-- | :-- | :-- | :-- |
| **Durward** | **clean** | Old Scots/English **door-ward** — the household officer who kept the door; a person-word (cf. Clerk) that says the job plainly. npm free; `.com/.dev` unregistered; zero hits; Walter Scott pedigree | surname reading; British-quaint register |
| Idhini | clear-ish | Swahili **permission/consent/authorization** (ee-DEE-nee). npm + `.dev` free; no company hits | `.com` parked; opaque outside East Africa |
| ~~Vordr~~ | contested | Norse *vörðr* — a warden-spirit bound to one person | `vordr.dev` + `vordr.io` both live (existing dev product likely) |
| ~~Assentia / Symbolon / watchword / warder / ostiary / signet / Quivive / Vicero~~ | **blocked** | assent+ia (≈ *in absentia*!) / the Greek matched-halves token / sentry vocabulary | Assentia Inc. (clinical-payments software); Symbolon astrology products; npm tokens taken; registered `.com`s |

**Maintainer-suggested check (2026-07-02): CredentAgent — cleanest exact clearance of any check, weak as a
mark; benched.** npm free (`credentagent`, `credent-agent`, even bare `credent`), `.com/.dev/.io` all
unregistered, zero exact company/product hits — and "credent" is a real word (archaic English: *believing,
trusting*), fusing with agent on the shared "-ent". Instant comprehension is the best of any candidate: nobody
asks what a CredentAgent library does. But three standing rulings apply: (1) the **generic "-Agent" suffix**
adds no distinctiveness (the ConsentioAgent / AttestoAgent / VeriAgent defect) and **names the agent, not the
consent layer that checks it** — category drift toward "an agent SDK"; (2) the **"cred-" root is crowded**:
Credant Technologies (Dell-acquired data security — a homophone), CredenTek ("Agentic AI" services), two
Credent IT firms, plus the Credence adjacency that dinged Creance; (3) it says *credential*, not *consent* —
the identity half without the authorization half that is the product's differentiator. Verdict: strongest
**descriptive fallback** on the bench; if instant-parse is the priority, Consentinel delivers it with a
distinctive mark.

**Crafted candidate (2026-07-02): Poder.** Spanish for *power* — and the **everyday Spanish word for a power
of attorney**: *otorgar poder* ("to grant power") is the literal notarial formula; you give your agent **un
poder**. Two open syllables (po-DAIR / PO-der), self-spelling, no stress trap; instant meaning for ~500M
speakers, one sentence for everyone else; authentic to the maintainer. Clearance: npm + `.dev` free; **no
software product found** with the name (nearest: Podero, energy — different word; PODER, Mexican civic NGO —
far space). **Flags:** (1) US **doctrine of foreign equivalents** — *Poder* translates to *Power*, and
Microsoft's POWER marks live in software classes; likely distinguishable but this is a mandatory counsel
question; (2) "powder" drift in fast American English (spelling anchors it); (3) `.com` presumed long gone
(common word). Tagline: *"Poder — a power of attorney for AI agents"* / demo line: *"give your agent un
poder, not your password."* **Added to the strong seconds.**

**Crafted candidate (2026-07-02): Norva — the pure-sound pick.** Brief: syllables that sound cool, meaning
optional (the fanciful-mark school: Kodak/Vercel/Deno). Survivor of two sound-first sweeps (killed there:
Kelvo = active invoicing SaaS; Zelvo = fintech + retail brands; Kelva = industrial tech; senva/veyra/voxa npm
taken; zenta/venzo/talo/sivo/orvo/elvo `.com`s live). **NOR-va**: one spelling, first-syllable stress, no
mishearing neighbors except *nova* and *norma* ("the rule") — both flattering. npm + `norva.dev` free; zero
company hits; `norva.com` = a Virginia concert venue (far space). Strongest trademark class precisely because
it means nothing.

**Queue (final, 2026-07-02, post-verdict-council + ninth sweep):** **Consentinel** (runaway cold-hearing
winner) → **Attorn · Creance · Assentio · Durward · Poder** (each strong on a different axis: legal root /
metaphor+clearance / sound / plain-English person-word / instant-meaning Spanish PoA) → **Volens · Agensent
(fallback) · Perpro · Dedimus · Idhini** → the rest. Counsel knockout shortlist: **Consentinel, Attorn,
Creance, Assentio** (+ Poder if the foreign-equivalents check clears, Durward or Agensent as backup).

Tracked in [#80](https://github.com/openmobilehub/credentagent/issues/80) (rename mandatory per counsel 2026-07-02; this doc holds the candidate queue).
