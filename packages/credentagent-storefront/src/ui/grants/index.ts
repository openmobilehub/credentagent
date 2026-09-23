// The grant gallery public surface (spec 011 §The surface):
//
//   import { GrantCard, grantViews, defineGrantView, BudgetMeter } from "./grants";
//   <GrantCard grant={grant} />                              // zero-config: picks the fitting view
//   <GrantCard grant={grant} views={[grantViews.budgetMeter]} />   // choose / reorder
//   const wineRow = defineGrantView({ id, fits, body });    // extend — same contract as the stock
//
// A custom view receives the INERT GrantViewData projection (never the live Grant) and reuses the
// exported <BudgetMeter/> primitive; the frame (chrome + the non-omittable trust line) is applied
// by GrantCard, not the caller.

export { GrantCard, GrantList } from "./GrantCard";
export type { GrantCardProps, GrantListProps } from "./GrantCard";
export { grantViews, productGrantCard, categoryGrantCard, openGrantCard, approvalCard, terminalCard, budgetMeter } from "./views";
export { defineGrantView } from "./frame";
export { BudgetMeter } from "./BudgetMeter";
export type { BudgetMeterProps } from "./BudgetMeter";
export { GrantActionsContext, useGrantActions } from "./actions";
export type { GrantActions } from "./actions";
export { grantTokens } from "./shared";
export type { GrantView, GrantViewContext, GrantTokens, GrantSlots, DefineGrantViewInput, GrantViewData } from "./types";
export { GRANT_VIEW_KIND } from "../../grant-view";
export type { GrantViewProduct } from "../../grant-view";
