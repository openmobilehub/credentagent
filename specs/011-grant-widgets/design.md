# Grant Widgets — UX design

Design pass for spec `011-grant-widgets` (issue #143). Companion to this doc:
**`mockups.html`** in this folder — open it in a browser to see every view, in every
state, rendered in light **and** dark side by side (including one host-branded custom
view). This document explains the *why*; the mockup is the *what it looks like*.

Read `spec.md` first. This doc resolves its four open questions (§8), critiques its
component contract (§9), and recommends spec amendments (§10).

---

## 1. What the human is actually looking at

A grant card answers one question a person is nervous about: **"I'm about to let an
agent spend my money while I'm not watching — what exactly did I agree to, and is it
still safe?"** Everything below serves that. The card is a *window onto server-enforced
state*, never a control (spec FR-5, security invariant 1). So the design's job is
**legibility and honesty**, not interactivity: read the scope, the money, and the
agency in seconds; never imply a safety guarantee we don't have.

Three facts shape every screen:

- **Product-specific grants lead.** "Buy me *this one thing* while I'm away" is the
  sharpest consent story, so `productGrantCard` is the flagship and gets the richest
  treatment (a real product tile with image and quantity math).
- **The consent moment is the one that matters.** `approvalCard` is the only screen
  where a human *decides*. It earns more visual weight than every other view — and the
  most anti-dark-pattern discipline.
- **The trust line is load-bearing and non-omittable.** Every view, stock or custom,
  carries it through a frame the public API cannot skip (FR-4). It is honest to a fault:
  the spending *limits* are really enforced; the *consent* is dev-sealed, not
  wallet-signed. We say both.

---

## 2. Visual language — extending, not replacing

The card lives inside the storefront MCP-App widget bundle (`src/ui/grants/`), so it
**inherits the shopping widget's surface grammar** — the same `light-dark()` color
scheme, card radius, hairline borders, tabular money, and pinned-footer pattern from
`app.module.css` / `global.css`. But a grant card is a **consent surface**, not a
shopping surface, so its accent comes from the **ceremony design system**
(`ceremony/theme.ts`) — the teal the approval page, the checkout hub, and the gate pages
all share — *not* the storefront's shopping blue (`#4f7cff`). This is deliberate: when a
person sees a grant card, the color should say "this is the CredentAgent consent layer,"
the same visual family they'll meet again on the approval page they deep-link to. It also
means the card themes with the host `branding.accent` (#132) for free, because that option
already drives the ceremony `--accent`.

### 2.1 Tokens

All tokens are CSS custom properties resolved through `light-dark(light, dark)` so a
single declaration serves both schemes (matching `global.css`'s `color-scheme: light
dark`). The host `branding.accent` overrides `--grant-accent` exactly as it overrides the
ceremony `--accent`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--grant-accent` | `#0d9488` | `#2dd4bf` | Healthy budget fill, active status, links. **Host-brandable.** |
| `--grant-accent-hover` | `#0f766e` | `#5eead4` | CTA hover (approvalCard only) |
| `--grant-ink` | `#0f172a` | `#f1f5f9` | Primary text |
| `--grant-muted` | `#64748b` | `#94a3b8` | Labels, captions, the trust line |
| `--grant-hairline` | `#e2e8f0` | `#334155` | Card border, dividers (aligns to widget `#e2e2e2/#3a3a3a`) |
| `--grant-surface` | `#ffffff` | `#1f1f1f` | Card background (identical to widget `.card`) |
| `--grant-sunken` | `#f8fafc` | `#181818` | Meter track, chip fill, footer (widget `.footer`) |
| `--grant-warn` | `#fab219` | `#fab219` | **Low-budget fill. FIXED — never themed.** |
| `--grant-crit` | `#d03b3b` | `#e05252` | **Exhausted/denied accent. FIXED — never themed.** |
| `--grant-radius` | `12px` | | Card radius (widget parity; ceremony uses 14px — we keep the widget's 12px since we live in its grid) |
| `--grant-gap` | `12px` | | Base spacing unit (widget `.grid` gap) |

**Why status colors are fixed and never themed:** "running low" and "spent out" must look
the same regardless of the host's brand — a payments-safety signal a merchant should not
be able to recolor into their palette (and the dataviz status ramp is defined as
never-themed). So *only* the healthy fill carries `--grant-accent`; the moment the meter
crosses a severity threshold it switches to the fixed amber/red. The branded custom-view
mock proves this: its healthy meter is violet, but its low-budget meter is still amber.

### 2.2 Typography scale

Reuses the widget's scale so grant cards and product cards sit together without a seam:

- Card kicker / section label — `11px`, uppercase, `letter-spacing: .04em`, `--grant-muted`, weight 600 (widget `.category`).
- Body / product name — `14px`, weight 600, `--grant-ink` (widget `.name`).
- Secondary / description — `12–13px`, `--grant-muted` (widget `.desc`).
- **Budget headline** — `20px`, weight 700, **proportional** figures (`$146` reads tight at display size; dataviz: reserve `tabular-nums` for aligned columns only).
- Small money in rows / chips — `14px`, weight 600, `tabular-nums`.
- Trust line — `12px`, `--grant-muted` (ceremony `.trust-line` parity).

### 2.3 Spacing & radius

- Card padding `16px` (widget `.cardBody` rhythm, one notch up for the denser content).
- Card radius `12px`, `1px` hairline border, no shadow in the widget grid (the widget's
  cards are borderless-shadowless too); the standalone/branded showcase adds the ceremony's
  soft two-layer shadow so it reads as a lifted consent object.
- Chips: `6px` radius, `4px 10px` padding, `--grant-sunken` fill, `--grant-muted` text;
  category chips get a faint accent tint (`--grant-accent` at ~12%).

---

## 3. The budget meter (the one chart-like element)

Designed against the `dataviz` skill. The full rationale for form and marker placement is
in §8 (open questions 1 & 2); the spec here is the build target.

### 3.1 Form: a depleting horizontal bar, never a donut

A budget is **"a single ratio against a limit"** — dataviz maps that straight to a
**meter (same-ramp track)**, explicitly *not* a two-slice pie/donut. The bar wins on
three counts a donut loses: it reads magnitude by **length** (works with no color at
all), it has a natural place to hang the **per-purchase cap marker**, and it literally
**depletes** left-as-you-spend so the "watch it drain while the agent shops" story is
visible.

### 3.2 Geometry

```
$146 of $200 remaining                         ← headline (proportional figures)
┌───────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░│  ← track = full budget; fill = REMAINING
└───────────────────────────────────────────┘     anchored LEFT, recedes as spent
 └──────── up to $130 per purchase ────────┘   ← cap bracket, fixed, under the track
```

- **Track** = the whole budget, full width, `999px` pill, `10px` tall (a slim gauge, not
  a 24px data bar). Track color `--grant-sunken` = the "already-spent" ghost.
- **Fill** = **remaining** budget, `width: remaining/budget`, anchored **left**, fully
  rounded. It **recedes leftward** as the agent spends (a battery draining). The
  accent-colored region is *the money you still have* — which is why its color carries
  severity (below), and why fill = remaining rather than spent (coloring "money gone" in
  the healthy accent would be semantically backwards).
- **Fill severity** (redundant with length + text, never the sole cue):
  - **Healthy** `remaining > 20%` of budget → `--grant-accent` (teal / host brand).
  - **Low** `0 < remaining ≤ 20%` → `--grant-warn` (fixed amber) + a `⚠ Running low` chip.
  - **Exhausted** `remaining == 0` → `--grant-crit` (fixed red), track effectively empty.
- **Cap bracket** — a thin bracket **beneath** the track, anchored at the spend origin
  (left), spanning `perSpend/budget` of the width, labeled `up to $130 per purchase`. It
  is a **fixed reference scale** ("one purchase is at most this wide relative to the whole
  budget"), not a marker that floats inside the fill. See §8 Q2 for why.

### 3.3 The "budget binds below the cap" case

When `remaining < perSpend`, the cap bracket (perSpend-wide) visually **overshoots** the
remaining fill into the spent ghost — an honest, automatic signal that *the budget now
caps the next purchase below the nominal per-purchase limit*. The bracket label switches to
`budget caps next purchase at $28`. This is surfaced **independently of** the amber
low-budget state: a $200/$130 grant with $70 left is still "healthy" by the 20% rule (it's
35%), yet it already can't fund a full $130 purchase — a fact worth showing without crying
"low."

### 3.4 Validation (computed, not eyeballed)

`dataviz/scripts/validate_palette.js` on the three severity fills:

- **CVD separation: PASS** both modes — a colorblind user can tell healthy/low/exhausted
  apart across a list of cards (worst adjacent ΔE 15.9 dark / 20.4 light; target ≥ 8).
- **Normal-vision separation: PASS** both modes.
- **Contrast: amber is 1.83:1 on the light surface** — the documented status-palette case;
  mitigated by the **relief rule** (the amber meter *always* ships with the `⚠ Running
  low` icon+label and the `$X of $Y remaining` value, so color is never the only signal).
- The *lightness-band* check flags amber and dark-teal — that's a **categorical-set**
  metric (it wants mid-lightness hues that read together as a group); a meter shows **one
  state at a time**, so it does not govern here. Documented so a reviewer re-running the
  script sees the same and knows why it's fine.

### 3.5 Accessibility of the meter

- **Readable without color:** length encodes magnitude; the `$146 of $200 remaining` value
  is always present; warning/exhausted add an icon. Remove all color → still legible.
- **Screen reader:** the track is
  `role="meter" aria-valuemin="0" aria-valuemax="200" aria-valuenow="146"
  aria-valuetext="$146 of $200 remaining · up to $130 per purchase"`. The visual bar is
  `aria-hidden`; the value text carries meaning. (`role="progressbar"` is the fallback if a
  target AT lacks `meter` support — same aria-value attributes.)

---

## 4. The gallery — every view, hierarchy, states

Common frame for every card (owned by `defineGrantView`, FR-4): **kicker + status
treatment** at the top, **body** in the middle, **trust line** always last, immovable. The
per-view notes below describe only the *body*.

### 4.0 Status treatment (shared)

A small pill, top-right, icon + word (never color alone):

| Lifecycle | Pill | Color |
|---|---|---|
| pending | `⧗ Needs approval` | accent |
| active | `● Active` | accent |
| active-low | `⚠ Running low` | amber |
| exhausted | `✓ Budget spent` | muted (a *completion*, not an error) |
| revoked | `⊘ Revoked` | muted |
| denied | `✕ Declined` | muted |

### 4.1 `productGrantCard` — the flagship (single SKU)

```
┌──────────────────────────────────────────────┐
│ SPENDING GRANT                     ● Active    │
│                                                │
│ ┌─────┐  Utopia Coffee Beans                   │  ← product tile leads
│ │ img │  Beverages · $18 each                  │
│ └─────┘  up to 3 per purchase · $54 max        │  ← qty math from perSpend/price
│                                                │
│ $146 of $200 remaining                         │  ← budget headline
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░                      │
│  └──── up to $130 per purchase ────┘           │
│                                                │
│ Spends at Utopia while you're away · Revoke    │  ← agency line + quiet revoke link
├────────────────────────────────────────────────┤
│ 🔒 delegated-demo · limits enforced server-     │  ← trust frame (always last)
│    side · consent is dev-sealed, not wallet-    │
│    signed                                       │
└────────────────────────────────────────────────┘
```

**Information hierarchy — what reads first and why:** (1) the **product tile** (image +
name), because "buy me *this thing*" is the whole point — the concrete object is the most
reassuring, fastest-to-grasp fact. (2) the **budget headline + meter** — the money
exposure. (3) the **quantity math** ("up to 3 per purchase") bridges product and cap into
a sentence a person can repeat. (4) the **agency line** ("while you're away") — never
hidden. (5) status pill for lifecycle. (6) trust line.

### 4.2 `categoryGrantCard` (categories ± multiple SKUs)

```
│ SPENDING GRANT                     ● Active    │
│                                                │
│ Anything in these categories at Utopia         │
│ [ Beverages ]  [ Electronics ]                 │  ← category chips (accent tint)
│ plus: [ Utopia Coffee ] [ USB-C Cable ]        │  ← explicit sku chips, muted
│                                                │
│ $146 of $200 remaining                         │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░                      │
│  └──── up to $130 per purchase ────┘           │
```

**Hierarchy:** the **scope chips** read first (what categories), then money. Category chips
are visually primary (accent-tinted); explicit-SKU chips are secondary (muted) and prefixed
"plus:" so the person understands the union. The cap marker matters more here than in the
product card, because there's no single price to anchor on — the `$130/purchase` line is the
only per-item ceiling the human has.

### 4.3 `openGrantCard` (no `allow` bounds)

```
│ SPENDING GRANT                     ● Active    │
│                                                │
│ 🏬 Anything at Utopia                           │  ← merchant-wide, stated plainly
│    No product limits on this grant.            │  ← the honest caveat, not buried
│                                                │
│ $200 total · $130 per purchase carry all       │  ← money leads here (see below)
│ the limits.                                    │
│ $146 of $200 remaining                         │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░                      │
│  └──── up to $130 per purchase ────┘           │
```

**Hierarchy inverts on purpose:** an open grant has *no product scope*, so the **money is
the scope**. The card says so out loud ("No product limits… $200 total and $130 per
purchase carry all the limits") and leans all visual weight onto the budget + cap. Refusing
to dress an unbounded grant up as if it were bounded is the honest move.

### 4.4 `approvalCard` (status === "pending") — the consent moment

This gets the most care. In **under 5 seconds** a person must grasp **WHAT** can be bought,
**HOW MUCH** (total + per purchase), and **WHO/WHEN** (the agent spends, unattended). The
layout is three labeled blocks in exactly that order, then two equal-weight buttons.

```
┌──────────────────────────────────────────────┐
│ CREDENTAGENT                  ⧗ Needs approval │  ← wordmark header (louder than active)
│                                                │
│ Approve a spending grant                       │  ← h1, plain imperative
│ Your agent will spend at Utopia while you're   │  ← one-line agency summary up top
│ away. Here's exactly what you're allowing:     │
│                                                │
│ ┌ WHAT ────────────────────────────────────┐  │
│ │ ☕ Utopia Coffee Beans — $18                │  │  ← scope: concrete, reassuring
│ │    Beverages · up to 3 per purchase        │  │
│ └────────────────────────────────────────────┘  │
│ ┌ HOW MUCH ────────────────────────────────┐  │
│ │  $200 total      ·      $130 per purchase  │  │  ← the two money numbers, large
│ └────────────────────────────────────────────┘  │
│ ┌ WHO ─────────────────────────────────────┐  │
│ │ Your agent spends unattended until the     │  │  ← agency/risk, right before deciding
│ │ budget runs out — or you revoke it.        │  │
│ └────────────────────────────────────────────┘  │
│                                                │
│ [    Approve    ]      [    Decline    ]       │  ← EQUAL weight, side by side
│ Opens the CredentAgent approval page ↗         │  ← honest deep-link disclosure
├────────────────────────────────────────────────┤
│ 🔒 delegated-demo · limits enforced server-side…│
└────────────────────────────────────────────────┘
```

**Why this hierarchy:** reading top-to-bottom is agency-summary → **WHAT** → **HOW MUCH** →
**WHO** → decide. Leading with WHAT (the concrete product) makes the grant legible and
calm; HOW MUCH states the exposure; **ending on WHO — "spends unattended … while you're
away" — right above the buttons means the last thing a person reads before deciding is the
honest, slightly scary truth about agency.** That's the opposite of a dark pattern: we put
the caveat at the decision point, not in fine print.

**For an open grant, the WHAT block says "Anything at Utopia — no product limits," and
HOW MUCH visually leads** (same inversion as §4.3): don't imply a scope that isn't there.

**Anti-dark-pattern rules, enforced in the design:**
- **Approve and Decline are visually identical in weight** — same size, same height, same
  emphasis. Approve sits left (reading order), Decline right; neither is a greyed-out
  afterthought. (Contrast this with the common pattern of a bright "Approve" and a faint
  "Maybe later.")
- **The deep-link is disclosed** ("Opens the CredentAgent approval page") — the buttons
  don't pretend to seal consent inside the widget; consent happens on the server page
  (FR-5, non-goal: no ceremony in the widget).
- **No urgency, no countdown, no red.** Pending is *louder* than active, but calm-louder.

### 4.5 `budgetMeter` (compact, dense layouts)

One line for scanning many grants at once:

```
Utopia · $146 of $200 · ▓▓▓▓▓▓░░ · ≤$130/purchase          🔒 delegated-demo
```

Merchant · remaining/budget · slim meter · cap caption, with a compact `🔒 delegated-demo`
trust marker. The **literal `delegated-demo` token stays on every row** (so the FR-4 bypass
test passes per-view), while the fuller sentence de-duplicates to the list container (§8 Q4,
amendment A7). See §5 for its states.

### 4.6 Terminal states

Terminal cards are **closed objects with no live affordances** (FR-5): no revoke link (there
is nothing to stop), no buttons. The meter is shown frozen and desaturated as a record of
what happened.

```
 exhausted:  ✓ Budget spent · $200 of $200 used · this grant is closed.
 revoked:    ⊘ Revoked on Jul 28 · no further purchases will be made.
 denied:     ✕ Declined · this grant was never activated.
```

Tone matters: **exhausted is a completion, not a failure** — the grant did its job — so it's
muted/neutral, not red-alarm. Revoked and denied are stated plainly and without blame.

---

## 5. Every state, every view — the state matrix + microcopy

States apply across views; the frame renders them consistently. `active-low-budget`
threshold: **`remaining ≤ 20% of budget`** (color → amber). Independently, whenever
`remaining < perSpend`, the cap line notes the budget now binds first.

| State | Status pill | Meter | Microcopy (headline / caption) | Affordances |
|---|---|---|---|---|
| **pending** | `⧗ Needs approval` | — (approvalCard shows bounds, not a live meter) | "Approve a spending grant" / "spends while you're away" | Approve · Decline (equal) |
| **active** | `● Active` | teal | "$146 of $200 remaining" / "Spends at Utopia while you're away" | Revoke (quiet link) |
| **active-low-budget** | `⚠ Running low` | amber | "$28 of $200 remaining" / "Running low — less than one full purchase" (when `remaining < perSpend`) | Revoke |
| **exhausted** | `✓ Budget spent` | red, empty | "Budget spent — $200 of $200 used" / "This grant is closed." | none |
| **revoked** | `⊘ Revoked` | desaturated, frozen | "Revoked on Jul 28" / "No further purchases will be made." | none |
| **denied** | `✕ Declined` | — | "Declined" / "This grant was never activated." | none |
| **loading** | skeleton | skeleton shimmer | — | none (disabled) |
| **stale** | live pill + `· reconnecting…` | last-known, 60% opacity | "$146 of $200 remaining" + "Reconnecting…" caption | Revoke stays enabled; **Approve disabled** until fresh |
| **error / refresh-failed** | live pill + `· offline` | last-known | banner: "Couldn't refresh — showing last known state" + **Retry** | Retry; Revoke stays enabled |

**Loading vs stale vs error — the honesty rules (FR-5):**
- **loading** = first paint, no data yet → skeleton, nothing actionable.
- **stale** = we have last-known data and a refresh is in flight → show the data at reduced
  opacity with "Reconnecting…". A stale card **can never unlock anything** — so the
  consequential action (**Approve**) is disabled until data is fresh, while **Revoke stays
  enabled** (stopping a grant is always fail-safe; you never need fresh data to be allowed
  to stop).
- **error** = refresh failed → keep showing last-known, add an honest banner and Retry.
  Never blank the card (that hides money state); never claim freshness we don't have.

**The trust line — exact wording, data-driven:**

```
🔒 delegated-demo · limits enforced server-side · consent is dev-sealed, not wallet-signed
```

Built from `grant.presence` (`"delegated-demo"`) and `grant.trustLevel`
(`"server-issued-demo"`), mirroring `trustFooter()`'s non-overridable rule. It is honest on
both axes: the **limits** (budget, per-purchase cap, product scope) are *genuinely* enforced
by the server engine — true, load-bearing, and the reason a stale card is safe. The
**consent** is sealed server-side with a dev signature (integrity hash), **not** signed by
the user's wallet key — so we say "dev-sealed, not wallet-signed" rather than implying a
cryptographic wallet binding that the v0.2 roadmap (#71/#14) hasn't delivered. Never
"secured," never a lock-and-nothing-else.

---

## 6. Accessibility

- **Contrast (both schemes):** primary ink on surface clears WCAG AA in light and dark.
  The teal accent is used for fills and large/bold UI, not for small body text on white
  (it's ~3:1 — fine for the meter fill and the ≥14px bold link, not for 12px prose). Dark
  mode uses the lighter teal `#2dd4bf`. Status pills and the meter always pair color with an
  **icon + word**, so the sub-3:1 amber-on-light case is mitigated by the relief rule (§3.4).
- **Meter without color:** §3.5 — length + value text + icon; strip color and it still reads.
- **Screen-reader text:** the meter's `aria-valuetext` = "$146 of $200 remaining · up to
  $130 per purchase". Chips are a labeled list ("Allowed categories: Beverages, Electronics").
  Status pill text is real text, not an icon-only glyph. The trust line is plain text in DOM
  order (read last, as it renders).
- **Focus order** (approvalCard): h1 → WHAT → HOW MUCH → WHO → **Approve → Decline** →
  deep-link note → (trust line, non-interactive). Approve precedes Decline in the DOM
  (reading order), and both are real buttons with identical focus rings. Active card focus
  order: content → Revoke → trust line.
- **Touch targets:** buttons ≥ 44px tall (ceremony `.btn` is 48px — we match); the Revoke
  link has a ≥ 44px tappable area despite looking like inline text; chips ≥ 32px.
- **Motion:** the depletion animation and any skeleton shimmer respect
  `prefers-reduced-motion` (snap, don't animate).

---

## 7. Responsive

- **Narrow chat column (~320px)** — the common case. Cards are full-width. The product tile
  keeps image-left down to ~300px, then stacks image-above-text below that. Chips wrap. The
  meter is fluid. On the approvalCard, **Approve/Decline stay side-by-side down to ~300px**
  (two 48px buttons fit), and only stack below that — and when they stack they remain
  **equal full-width** with identical styling, so stacking never implies one is primary
  (Approve on top = reading order, not emphasis).
- **Wider hosts (≥ 460px)** — the card caps at `max-width: 460px` (ceremony `.wrap` parity)
  and doesn't stretch into an ungainly ribbon; it centers or flows in the widget's
  `auto-fill` grid alongside other cards.
- **Collapse to row density** — when **≥ 3 grants** render together, *or* a card's container
  is narrower than ~240px, the frame collapses to the **`budgetMeter` row** so budgets can be
  scanned and compared vertically instead of scrolled past as tall cards. One or two grants
  keep their full fitting card.

---

## 8. Open questions — resolved

### Q1 · Depleting bar vs. donut → **depleting horizontal bar (meter).**

A budget is a single ratio against a limit; the `dataviz` form table maps that directly to a
**meter (same-ramp track)** and explicitly names a "pie of 2 slices" as the wrong form. The
bar reads magnitude by **length** (legible with zero color, so it survives CVD and grayscale),
gives the **per-purchase cap** a natural place to live (a bracket underneath — a donut has
nowhere honest to put it), and **depletes visibly** so "watch it drain as the agent shops"
is shown, not described. A donut would force the cap into a second ring or a center label,
both weaker. **Recommendation: bar.**

### Q2 · Where the per-purchase cap marker reads best → **a fixed bracket beneath the track, anchored at the spend origin.**

Not a tick floating *inside* the depleting fill: that collides with the fill's severity color
and *moves* as the budget drains, muddying both readings. A **fixed reference bracket** under
the track — anchored left, spanning `perSpend/budget` — answers the exact consent question
("how big can *one* purchase be, relative to the whole?") and never moves. Bonus: when
`remaining < perSpend` the bracket **overshoots** the fill, which *is* the honest signal that
the budget now caps the next purchase below the nominal limit. A moving "next-bite" marker was
considered and rejected (motion churn; ambiguous once the budget binds first). **Recommendation:
fixed bracket, below, left-anchored, labeled.** On the compact `budgetMeter` the cap degrades to
a caption (`≤$130/purchase`) — no room for an unambiguous in-track marker at ~320px.

### Q3 · How loud the pending/consent state should be → **louder than active, but calm-louder.**

Pending is the one screen where a human *decides*, so `approvalCard` earns real weight: the
full wordmark header (vs the active card's tiny kicker), the three WHAT/HOW MUCH/WHO blocks,
and two full-size buttons. Active cards are quiet read-only displays by comparison. But
"louder" means **more structured and legible, not more alarming** — no red, no countdown, no
urgency copy, and Approve/Decline at equal weight. The loudness buys *comprehension time*, not
pressure. **Recommendation: elevate structure and header weight; keep zero urgency theatrics.**

### Q4 · `budgetMeter` as the dense-layout default → **yes for ≥ 3 grants; no for 1–2.**

Stacking three full product/category cards makes a person scroll past tall blocks to compare
budgets; three `budgetMeter` rows let them scan remaining-vs-budget down a column in one look.
So: **≥ 3 grants (or a per-card width under ~240px) default to `budgetMeter`; one or two grants
keep the full fitting card** (the flagship product story is worth the height when there's room).
The catch is the trust line: eight identical trust lines down a list train the eye to skip them
— repetition becomes its own dark pattern. Resolve it by keeping the **literal `delegated-demo`
token on every row** (FR-4 bypass test still passes per-view) while **de-duplicating the fuller
sentence to one authoritative line at the list-container footer** (amendment A7). **Recommendation:
budgetMeter as the ≥3-grant default, with the per-row token + per-container full line split.**

---

## 9. Critique of the component contract

The spec's contract is `defineGrantView({ id, fits, body })`, `body({ grant, tokens, slots })`,
`slots: { headerExtra, footerExtra }`, `density: card|row`, `tokens: { accent, radius,
spacing }`. It's close to right (it correctly mirrors `defineCredential` and the
non-overridable `trustFooter`), but six things would push designers/developers into bad UI.
Each maps to a DX principle in `docs/reference/architecture-principles.md`.

1. **`body`/`fits` should receive the inert `GrantViewData` projection, never the live
   `Grant` handle.** The surface example passes `grant`, and `Grant` (grants.ts) carries
   `spend()` and `revoke()` *methods*. If a custom `body` gets that, a view can call
   `grant.spend()` from inside the widget — the exact display-only violation FR-5 forbids —
   and it also lacks the resolved product details FR-1 promises. **Amendment:** `body`/`fits`
   receive `GrantViewData` (plain data: the computed `budget/spent/remaining/perSpend`,
   resolved product, `lifecycle`, `presence/trustLevel`) — *no methods*. A view that
   physically cannot call `spend()` cannot bypass the server (Principle 3: make illegal
   states unrepresentable; Principle 5). Approve/Revoke are passed as frame-owned actions,
   not reachable from `body`.

2. **`fits` needs a server-derived `lifecycle`, not per-view re-derivation.** The gallery
   fits terminal views on "exhausted," but `exhausted` isn't a `status` value (status is
   `pending|authorized|denied|revoked`; exhausted = `authorized` + `remaining == 0`). Making
   every `fits` re-derive "exhausted" and "low" from `remaining`/`budget` is duplicated
   critical logic that will drift. **Amendment:** compute `lifecycle:
   "pending"|"active"|"low"|"exhausted"|"revoked"|"denied"` **once, server-side**, on
   `GrantViewData`; `fits` and the frame read it (Principle 7: one choke point).

3. **`fits: (g) => boolean` makes selection depend on invisible array order.** "First fitting
   wins, most-specific first" means whoever composes `grantViews.all` must hand-curate the
   order, and a custom `fits: () => true` placed first silently shadows every better stock
   view — the `[wineClubRow, ...grantViews.all]` example only works because the author
   front-loaded it. That's magic you can't see through. **Amendment:** let `fits` return
   `false | number` (a specificity score) or give each view a `specificity`, and select by
   `max(specificity where fits)`, array order as tie-break only (Principle 11).

4. **`tokens: { accent, radius, spacing }` under-serves custom views and invites theming a
   status color.** A custom view that draws its own budget indicator needs the warning/critical
   colors too — with only `accent` exposed, it'll invent an arbitrary red *and* may theme a
   status color (breaking "status never themed"). **Amendment:** `tokens` exposes the full role
   set — `accent`, fixed `status.{good,warning,critical}`, `ink`, `muted`, `hairline`,
   `surface`, `radius`, `spacing` — documented that status colors are fixed. Better: **export a
   ready-made `<BudgetMeter grant={data}/>` primitive** so custom views reuse the validated
   meter (severity + aria + cap marker) instead of rebuilding it (Principle 5; the
   example-is-the-test rule — the wine-club example should be a body around `<BudgetMeter/>`,
   not a hand-rolled bar).

5. **`footerExtra` "renders above the trust line" — the name lies about the layout.** A slot
   called `footerExtra` that is *not* at the bottom (the trust line is) will surprise
   developers, and some will fight to put content below the trust line — the one thing FR-4
   forbids. **Amendment:** name slots for their position relative to the immovable frame —
   `topSlot` / `bottomSlot`, where `bottomSlot` is documented as "above the trust line, which
   is always last." The API shape should make the trust line's finality obvious, not a thing
   you discover by experiment (Principle 2: names state the important thing; Principle 10).

6. **`density: card|row` vs the `budgetMeter` *view* is ambiguous.** Is `<GrantCard
   density="row"/>` the `budgetMeter`, or a squished `productGrantCard`? The spec lists
   budgetMeter as both a gallery view and (implicitly) the row density. **Amendment:** density
   is a **frame layout** property (any view can render `card` or `row`); `budgetMeter` is the
   view that *only* has a row form; a card-only view forced to `row` delegates to `budgetMeter`.
   Document the interaction so nothing is inferred silently (Principle 11).

---

## 10. Recommended spec amendments (summary)

For the spec's "reflected here" acceptance item:

- **A1** — `body`/`fits` take the inert `GrantViewData` projection, never the live `Grant`
  (enforces FR-5 display-only *by construction*).
- **A2** — add a server-derived `lifecycle` field to `GrantViewData`
  (`pending|active|low|exhausted|revoked|denied`); `fits`/frame read it, not re-derive it.
- **A3** — `fits` returns a specificity score (or views carry `specificity`); selection is
  `max` by specificity, not invisible array order.
- **A4** — `tokens` exposes the full role set incl. **fixed** status colors; export a
  `<BudgetMeter/>` primitive for reuse.
- **A5** — rename slots to `topSlot`/`bottomSlot`; `bottomSlot` is "above the always-last
  trust line."
- **A6** — define the density × view interaction (density is a frame layout; a card-only view
  forced to `row` delegates to `budgetMeter`); **`budgetMeter` is the default for ≥ 3 grants.**
- **A7** — keep the literal `delegated-demo` token per view (bypass test) but de-duplicate the
  full trust sentence to the list container in dense layouts, so repetition doesn't defeat the
  honesty line.
- **Trust-line wording** — adopt `🔒 delegated-demo · limits enforced server-side · consent is
  dev-sealed, not wallet-signed` (data-driven from `presence`/`trustLevel`).
- **Threshold** — `active-low-budget` at `remaining ≤ 20%` of budget; surface "budget caps the
  next purchase" independently whenever `remaining < perSpend`.
```
