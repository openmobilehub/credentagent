// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT, and the tool results that render as cards on it.
//
//   const cards = createCards({ tools: { revoke: "revoke-grant" } }); // once per process
//   cards.register(server);                                          // per server instance
//   server.registerTool("get-grant", { inputSchema, _meta: cards.toolMeta() }, async () => cards.grant(view));
//
// A card only shows; it never decides — every limit is enforced on the server (security invariant 1).

import { loadCardsPage } from "./page.js";
import { cardToolMeta, cardUris, registerCardResources, type CardsServer, type CardToolMeta } from "./meta.js";
import { cardResult, type CardResult } from "./results.js";
import { REVOKE_TOOL_META, type GrantViewData } from "./grant-view.js";

export interface CardsOptions {
  /** The tools a card's buttons call. `revoke`: your tool a grant card's Revoke button calls with
   *  `{ grantId }`, registered with `toolMeta()`. Without it the card draws no Revoke: the page never
   *  guesses a tool name (spec 015 FR-6). */
  tools?: { revoke?: string };
}

export interface Cards {
  /** The card page itself — serve it on a route to preview every card without a chat (`?view=`). */
  readonly html: string;
  /** Register the card page on an MCP server, once per server instance (a stateless server builds one per request). */
  register(server: CardsServer): void;
  /** The tool `_meta` that makes a tool's result render as a card, in Claude and ChatGPT alike. */
  toolMeta(status?: { invoking?: string; invoked?: string }): CardToolMeta;
  /** A tool result that shows a grant; the gallery picks the view that fits it. Names `tools.revoke`
   *  in `_meta` under `REVOKE_TOOL_META`, so the card can draw Revoke. */
  grant(view: GrantViewData, options?: { note?: string }): CardResult;
}

const GRANT_NOTE = "If the person can see this grant in a card, don't repeat its numbers; say in a sentence what changed.";

/** Configure once per process. Reads the built page now, so a missing build fails at startup, not mid-chat. */
export function createCards(options: CardsOptions = {}): Cards {
  const page = loadCardsPage();
  const uris = cardUris(page.hash);
  const revoke = options.tools?.revoke;
  const grantMeta = revoke ? { [REVOKE_TOOL_META]: revoke } : undefined;
  return {
    html: page.html,
    register: (server) => registerCardResources(server, page.html, uris),
    toolMeta: (status) => cardToolMeta(uris, status),
    grant: (view, opts) => cardResult(view, opts?.note ?? GRANT_NOTE, grantMeta),
  };
}

export { GRANT_VIEW_KIND, REVOKE_TOOL_META } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
export type { CardsServer, CardToolMeta } from "./meta.js";
export type { CardResult } from "./results.js";
