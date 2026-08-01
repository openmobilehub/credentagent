// The grant-view contract (spec 011 FR-3). A view is the ONLY thing the gallery is built from —
// stock views are not special. A view receives the INERT `GrantViewData` projection (never the
// live Grant handle, spec A1), the token role set, and the frame's named slots; it returns the
// BODY only. The frame (chrome + status + the always-last trust line) is owned by the gallery, so
// there is no way to render a body without it (FR-4).

import type { ReactNode } from "react";
import type { GrantViewData } from "../../grant-view";

export type { GrantViewData } from "../../grant-view";

/** The token role set a view body may read (spec 011 A4). Every value is a CSS custom-property
 *  reference resolved through `light-dark()`; the host `branding.accent` overrides `--grant-accent`
 *  ONLY. The status colors are FIXED and never host-themed — a brand can color money-you-have,
 *  never a money warning. Exposing them (rather than just `accent`) keeps a custom view from
 *  inventing an arbitrary red or theming a status color. */
export interface GrantTokens {
  accent: string;
  ink: string;
  muted: string;
  hairline: string;
  surface: string;
  sunken: string;
  /** FIXED status colors — never themed. */
  status: { good: string; warning: string; critical: string };
  radius: string;
  spacing: string;
}

/** Named slots (spec 011 FR-6 / A5). The names state position relative to the immovable frame:
 *  `bottomSlot` renders ABOVE the always-last trust line — the trust line's finality is legible
 *  in the API, not discovered. */
export interface GrantSlots {
  topSlot?: ReactNode;
  bottomSlot?: ReactNode;
}

/** What a view `body` receives. `grant` is the inert projection — no methods, so a body cannot
 *  enact anything (display-only by construction, FR-5). */
export interface GrantViewContext {
  grant: GrantViewData;
  tokens: GrantTokens;
  slots: GrantSlots;
}

/** A grant view. `fits` returns a specificity SCORE (or `false`) — the highest-scoring fitting
 *  view wins, so selection is explicit, not invisible array order (spec A3). `row: true` marks a
 *  view that only has a compact row form (the budgetMeter), used for the density delegation. */
export interface GrantView {
  id: string;
  fits: (grant: GrantViewData) => number | false;
  body: (ctx: GrantViewContext) => ReactNode;
  row?: boolean;
}

/** The single door for adding a view (FR-3). `defineGrantView` returns a {@link GrantView}; the
 *  frame is applied by the gallery, never by the caller. */
export interface DefineGrantViewInput {
  id: string;
  fits: (grant: GrantViewData) => number | false;
  body: (ctx: GrantViewContext) => ReactNode;
  row?: boolean;
}
