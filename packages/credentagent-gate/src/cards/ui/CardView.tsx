// Picks the card for a tool result by its `kind` (spec 015 FR-5). A card only shows: its buttons
// open a link or call a server tool, and the server decides everything (security invariant 1).

import { Component, type ReactNode } from "react";
import { GrantCard, GRANT_VIEW_KIND, type GrantActions, type GrantViewData } from "./grants";
import type { Bridge } from "./bridge";
import type { CardStore, ShownCard } from "./card-store";

export interface CardViewProps {
  card: ShownCard | null;
  bridge: Bridge;
  show: CardStore["show"];
}

export function CardView({ card, bridge, show }: CardViewProps) {
  if (!card) return null;
  if (card.data.kind === GRANT_VIEW_KIND) {
    return <GrantCard grant={card.data as unknown as GrantViewData} actions={grantActions(bridge, show)} />;
  }
  return null; // a kind this page does not know: show nothing rather than guess
}

/** The gallery's buttons. Approve/Decline open the approval page; Revoke calls the server's
 *  `revoke-grant` tool — the name the storefront's grant tools use — and shows the grant it returns. */
function grantActions(bridge: Bridge, show: CardStore["show"]): GrantActions {
  return {
    openLink: (url) => bridge.open(url),
    revoke: async (grantId) => {
      show({ structuredContent: await bridge.call("revoke-grant", { grantId }) });
    },
  };
}

/** A host turns an uncaught error into a bare "Runtime error"; the card says what went wrong instead. */
export class CardBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    return this.state.error ? <Trouble what="show this card" error={this.state.error} /> : this.props.children;
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
