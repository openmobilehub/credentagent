// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT, and the tool results that render as cards on it.
//
//   const cards = createCards();                                    // once per process
//   cards.register(server);                                          // per server instance
//   server.registerTool("get-grant", { inputSchema, _meta: cards.toolMeta() }, async () => cards.grant(view));
//
// A card only shows; it never decides — every limit is enforced on the server (security invariant 1).

import { loadCardsPage } from "./page.js";
import { cardToolMeta, cardUris, registerCardResources, type CardsServer, type CardToolMeta } from "./meta.js";
import { cardResult, type CardResult } from "./results.js";
import type { GrantViewData } from "./grant-view.js";

export interface Cards {
  /** The card page itself — serve it on a route to preview every card without a chat (`?view=`). */
  readonly html: string;
  /** Register the card page on an MCP server, once per server instance (a stateless server builds one per request). */
  register(server: CardsServer): void;
  /** The tool `_meta` that makes a tool's result render as a card, in Claude and ChatGPT alike. */
  toolMeta(status?: { invoking?: string; invoked?: string }): CardToolMeta;
  /** A tool result that shows a grant; the gallery picks the view that fits it. */
  grant(view: GrantViewData, options?: { note?: string }): CardResult;
}

const GRANT_NOTE = "The person sees this grant in a card. Don't repeat its numbers; say in a sentence what changed.";

/** Configure once per process. Reads the built page now, so a missing build fails at startup, not mid-chat. */
export function createCards(): Cards {
  const page = loadCardsPage();
  const uris = cardUris(page.hash);
  return {
    html: page.html,
    register: (server) => registerCardResources(server, page.html, uris),
    toolMeta: (status) => cardToolMeta(uris, status),
    grant: (view, options) => cardResult(view, options?.note ?? GRANT_NOTE),
  };
}

export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
export type { CardsServer, CardToolMeta } from "./meta.js";
export type { CardResult } from "./results.js";
