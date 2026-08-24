// Frame-owned actions (spec 011 FR-5). The card is display-only; its affordances are deep-links
// to the server ceremony or calls to the existing grant tools, provided by the host via context so
// the view bodies stay pure ({ grant, tokens, slots } only). Absent a provider (tests / a plain
// browser), the affordances still render but are inert — a stale card can never enact anything.

import { createContext, useContext } from "react";

export interface GrantActions {
  /** Open a deep-link (the approval page) through the host bridge (sandboxed iframes block
   *  plain target="_blank"). */
  openLink?: (url: string) => void | Promise<void>;
  /** Revoke a grant via the existing `revoke-grant` tool; the card re-renders from the result. */
  revoke?: (grantId: string) => void | Promise<void>;
}

export const GrantActionsContext = createContext<GrantActions>({});
export const useGrantActions = (): GrantActions => useContext(GrantActionsContext);
