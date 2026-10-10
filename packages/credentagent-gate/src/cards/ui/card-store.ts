// What the card page shows, kept OUTSIDE the DOM (spec 015 FR-5). ChatGPT re-delivers the tool
// output on every `openai:set_globals` event, and a host may re-announce a result; re-rendering on
// each one made the AP2 demo's card flicker and restart its work. The store keeps the card on
// screen and replaces it only when the result's data actually changed.

/** A card's data: any JSON object marked with a `kind`. */
export interface CardData {
  kind: string;
  [key: string]: unknown;
}

/** The card on screen: its data, its card-only extras (`_meta`), and a key that changes with the data. */
export interface ShownCard {
  data: CardData;
  meta: Record<string, unknown>;
  key: string;
}

/** What a host delivers: an MCP Apps tool result, or ChatGPT's toolOutput + toolResponseMetadata. */
export interface HostResult {
  structuredContent?: unknown;
  _meta?: unknown;
}

/** A host's tool result as a card — or null when it is not a card result (no `kind`). */
export function readCard(result: HostResult | null | undefined): ShownCard | null {
  const data = result?.structuredContent;
  if (!data || typeof data !== "object" || typeof (data as { kind?: unknown }).kind !== "string") return null;
  const meta = result?._meta && typeof result._meta === "object" ? (result._meta as Record<string, unknown>) : {};
  return { data: data as CardData, meta, key: JSON.stringify(data) };
}

export interface CardStore {
  /** Show a result. Returns false, changing nothing, when it is no card or the card already shown. */
  show(result: HostResult | null | undefined): boolean;
  current(): ShownCard | null;
  subscribe(listener: () => void): () => void;
}

export function createCardStore(): CardStore {
  let shown: ShownCard | null = null;
  const listeners = new Set<() => void>();
  return {
    show(result) {
      const card = readCard(result);
      if (!card || card.key === shown?.key) return false;
      shown = card;
      for (const listener of listeners) listener();
      return true;
    },
    current: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
