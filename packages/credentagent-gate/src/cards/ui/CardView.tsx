// Picks the card for a tool result by its `kind` (spec 015 FR-5). A card only shows: its buttons
// open a link or call a server tool, and the server decides everything (security invariant 1).

import { Component, useState, type ReactNode } from "react";
import { GrantCard, GRANT_VIEW_KIND, type GrantActions, type GrantViewData } from "./grants";
import type { Bridge } from "./bridge";
import { readCard, type CardStore, type ShownCard } from "./card-store";

export interface CardViewProps {
  card: ShownCard | null;
  bridge: Bridge;
  show: CardStore["show"];
}

export function CardView({ card, bridge, show }: CardViewProps) {
  // The last failed button press, if any. Held as `{ error }` so a thrown null or undefined still counts.
  const [trouble, setTrouble] = useState<{ error: unknown } | null>(null);
  if (!card) return null;
  if (card.data.kind === GRANT_VIEW_KIND) {
    const actions = grantActions(
      bridge,
      (result) => {
        setTrouble(null); // a card that now shows a good result clears the old failure
        return show(result);
      },
      (error) => setTrouble({ error }),
    );
    return (
      <>
        <GrantCard grant={card.data as unknown as GrantViewData} actions={actions} />
        {trouble ? <Trouble what="complete that action" error={trouble.error} /> : null}
      </>
    );
  }
  return null; // a kind this page does not know: show nothing rather than guess
}

/** The gallery's buttons. Approve/Decline open the approval page; Revoke calls the server's
 *  `revoke-grant` tool — the name the storefront's grant tools use — and shows the grant it returns.
 *  The frame calls these from bare event handlers that never await them, so every failure goes to
 *  `fail`: a rejected call, and an answer that is not the grant (the server's unknown-grant refusal). */
export function grantActions(bridge: Bridge, show: CardStore["show"], fail: (error: unknown) => void): GrantActions {
  return {
    openLink: (url) => bridge.open(url).catch(fail),
    revoke: async (grantId) => {
      try {
        const result = await bridge.call("revoke-grant", { grantId });
        if (readCard({ structuredContent: result })?.data.kind === GRANT_VIEW_KIND) {
          show({ structuredContent: result });
        } else {
          fail(new Error("the server did not answer with the grant"));
        }
      } catch (error) {
        fail(error);
      }
    },
  };
}

/** A host turns an uncaught error into a bare "Runtime error"; the card says what went wrong instead. */
export class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  render() {
    return this.state.failed ? <Trouble what="render" error={this.state.error} /> : this.props.children;
  }
}

export function Trouble({ what, error }: { what: string; error: unknown }) {
  return (
    <p className="trouble">
      This card couldn&apos;t {what}: {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** The preview's index: every sample view, light and dark. */
export function PreviewIndex({ views }: { views: string[] }) {
  return (
    <nav className="preview" aria-label="Card previews">
      <p>Preview a card:</p>
      <ul>
        {views.map((view) => (
          <li key={view}>
            <a href={`?view=${view}`}>{view}</a> · <a href={`?view=${view}&theme=dark`}>dark</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
