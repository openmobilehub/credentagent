// What the widget shows: nothing until the tool result that opened it arrives, then the grant card
// for a grant result, or the product picker for anything else (#428). The picker used to paint
// first, from the bundled catalog, so a grant result flashed the product grid before its card.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GrantCard, type GrantActions, type GrantViewData } from "../../../credentagent-gate/src/cards/ui/grants";
import { ShowProducts } from "./ShowProducts";

/** How long the widget waits for the result that opened it before showing the picker anyway, so a
 *  host that never delivers one still gets today's behaviour instead of an empty widget. */
export const FIRST_RESULT_WAIT_MS = 2000;

/** Whether the host has handed over a tool result (anything but null / undefined). */
export const isResult = (output: unknown): boolean => output !== null && output !== undefined;

/** `received` turns true when the caller marks a result, or after {@link FIRST_RESULT_WAIT_MS}. */
export function useFirstResult(alreadyReceived: boolean): [received: boolean, markReceived: () => void] {
  const [received, setReceived] = useState(alreadyReceived);
  useEffect(() => {
    if (received) return;
    const timer = setTimeout(() => setReceived(true), FIRST_RESULT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [received]);
  return [received, useCallback(() => setReceived(true), [])];
}

export interface WidgetViewProps {
  received: boolean;
  grantView: GrantViewData | null;
  grantActions: GrantActions;
  itemCount: number;
  onShowProducts: () => void;
  picker: ReactNode;
}

export function WidgetView({ received, grantView, grantActions, itemCount, onShowProducts, picker }: WidgetViewProps) {
  if (!received) return null;
  if (grantView) {
    return (
      <>
        <GrantCard grant={grantView} actions={grantActions} />
        <ShowProducts itemCount={itemCount} onShow={onShowProducts} />
      </>
    );
  }
  return <>{picker}</>;
}
