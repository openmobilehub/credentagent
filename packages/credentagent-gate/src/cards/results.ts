// Tool results that render as a card (spec 015 FR-4): the card's data as `structuredContent`, marked
// with a `kind`; one text block for the model — a note on what to do next, then the same data as
// JSON; and card-only extras in `_meta`, which reach the card without costing the model context.

export interface CardResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export function cardResult(data: { kind: string }, note: string, extras?: Record<string, unknown>): CardResult {
  return {
    content: [{ type: "text", text: `${note}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: { ...data },
    ...(extras ? { _meta: extras } : {}),
  };
}
