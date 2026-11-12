// What the widget shows: nothing until the tool result that opened it arrives, then the grant card
// for a grant result, or the product picker for anything else (#428). The picker used to paint
// first, from the bundled catalog, so a grant result flashed the product grid before its card.
// A widget a GRANT tool opened never shows the picker by itself: with no grant to draw (the call
// is still open, or it answered with questions or a refusal) it shows a one-line notice instead.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GrantCard, GRANT_VIEW_KIND, type GrantActions, type GrantViewData } from "../../../credentagent-gate/src/cards/ui/grants";
import { ShowProducts } from "./ShowProducts";
import styles from "./app.module.css";

// A grant tool result (create/get/spend/revoke) carries the GrantViewData projection, discriminated
// by `kind`, on BOTH host channels (Claude's structuredContent / text, ChatGPT's toolOutput). When
// present, the widget renders the grant card instead of the product picker.
export function grantViewOf(value: unknown): GrantViewData | null {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === GRANT_VIEW_KIND) {
    return value as GrantViewData;
  }
  return null;
}

/** How long the widget waits for the result that opened it before showing the picker anyway, so a
 *  host that never delivers one still gets today's behaviour instead of an empty widget. */
export const FIRST_RESULT_WAIT_MS = 2000;

/** Whether the host has handed over a tool result (anything but null / undefined). */
export const isResult = (output: unknown): boolean => output !== null && output !== undefined;

/** What ChatGPT's widget shows on its FIRST paint: the result it already holds when it mounts, if any. */
export function firstChatGptView(toolOutput: unknown): { received: boolean; grantView: GrantViewData | null } {
  return { received: isResult(toolOutput), grantView: grantViewOf(toolOutput) };
}

/** `received` turns true when the caller marks a result (or when {@link useFallback} gives up waiting). */
export function useFirstResult(alreadyReceived: boolean): [received: boolean, markReceived: () => void] {
  const [received, setReceived] = useState(alreadyReceived);
  return [received, useCallback(() => setReceived(true), [])];
}

/** Calls `onTimeout` after {@link FIRST_RESULT_WAIT_MS}; returns the cancel. */
export function armFallback(onTimeout: () => void): () => void {
  const timer = setTimeout(onTimeout, FIRST_RESULT_WAIT_MS);
  return () => clearTimeout(timer);
}

/** Shows the picker anyway when no result arrived within {@link FIRST_RESULT_WAIT_MS} of `armed` —
 *  Claude arms it once connected, so a slow handshake cannot run the clock out before the result. */
export function useFallback(received: boolean, armed: boolean, markReceived: () => void): void {
  useEffect(() => (received || !armed ? undefined : armFallback(markReceived)), [received, armed, markReceived]);
}

const GRANT_TOOLS = new Set(["create-spending-grant", "get-grant-status", "spend-from-grant", "revoke-grant"]);

/**
 * Whether a grant tool opened this widget. The host names the tool when it can (MCP Apps'
 * `toolInfo`); when it doesn't, the call's arguments tell: only `create-spending-grant` takes a
 * `budget` with a `perSpend`, and only the other three take a `grantId`.
 */
export function isGrantToolCall(toolName: string | undefined, toolInput: unknown): boolean {
  if (toolName) return GRANT_TOOLS.has(toolName);
  if (!toolInput || typeof toolInput !== "object") return false;
  const args = toolInput as Record<string, unknown>;
  return (typeof args.budget === "number" && typeof args.perSpend === "number") || typeof args.grantId === "string";
}

/**
 * What a grant tool's widget says while it has no grant to draw: `waiting` — the call is still
 * open (the server holds a re-check while the human approves); `no-grant` — it answered without
 * one (questions for the human, or a refusal).
 */
export type GrantNotice = "waiting" | "no-grant";

const NOTICE_TEXT: Record<GrantNotice, string> = {
  waiting: "Setting up the spending grant…",
  "no-grant": "No spending grant to show yet — the agent continues in the chat.",
};

export interface WidgetViewProps {
  received: boolean;
  grantView: GrantViewData | null;
  /** Set when a grant tool opened the widget and there is no grant to draw; the picker never shows in its place. */
  grantNotice?: GrantNotice | null;
  grantActions: GrantActions;
  itemCount: number;
  onShowProducts: () => void;
  picker: ReactNode;
}

export function WidgetView({ received, grantView, grantNotice, grantActions, itemCount, onShowProducts, picker }: WidgetViewProps) {
  if (!received) return null;
  if (grantView) {
    return (
      <>
        <GrantCard grant={grantView} actions={grantActions} />
        <ShowProducts itemCount={itemCount} onShow={onShowProducts} />
      </>
    );
  }
  if (grantNotice) {
    return (
      <>
        <div className={styles.status} role="status">{NOTICE_TEXT[grantNotice]}</div>
        <ShowProducts itemCount={itemCount} onShow={onShowProducts} />
      </>
    );
  }
  return <>{picker}</>;
}
