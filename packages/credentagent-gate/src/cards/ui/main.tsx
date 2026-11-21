// The card page (spec 015): connects to whichever app shows it, then renders the card for the latest
// tool result. vite.config.cards.ts builds it into ONE self-contained dist/cards/cards.html.

import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createCardStore } from "./card-store";
import { connectHost } from "./hosts";
import { previewViews } from "./preview";
import type { Bridge } from "./bridge";
import { CardBoundary, CardView, PreviewIndex, Trouble } from "./CardView";
import "./theme.css";

const store = createCardStore();
const root = createRoot(document.getElementById("root")!);

function Cards({ bridge }: { bridge: Bridge }) {
  const card = useSyncExternalStore(store.subscribe, store.current);
  if (!card && bridge.host === "preview") return <PreviewIndex views={previewViews()} />;
  // Keyed by the card, so a card that failed to render never hides the next one.
  return (
    <CardBoundary key={card?.key ?? "none"}>
      <CardView card={card} bridge={bridge} show={store.show} />
    </CardBoundary>
  );
}

connectHost(store).then(
  (bridge) =>
    root.render(
      <StrictMode>
        <Cards bridge={bridge} />
      </StrictMode>,
    ),
  (error: unknown) => root.render(<Trouble what="connect to the chat" error={error} />),
);
