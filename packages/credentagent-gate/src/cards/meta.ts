// How the card page is offered to the two chat apps (spec 015 FR-7): one page, two resources, and the
// tool `_meta` that links a tool's result to them. Plain data and a structural port — the kit imports
// no MCP SDK (principle 6); `McpServer` from @modelcontextprotocol/server fits the port.

/** MCP Apps (Claude) — the same value as `RESOURCE_MIME_TYPE` in @modelcontextprotocol/ext-apps. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The Apps SDK (ChatGPT) "skybridge" template. */
export const SKYBRIDGE_MIME = "text/html+skybridge";

export interface CardUris {
  resourceUri: string;
  skybridgeUri: string;
}

/** Hosts cache a resource by URI, so the URI carries the page's hash: a changed page is a new URI. */
export function cardUris(hash: string): CardUris {
  return {
    resourceUri: `ui://credentagent-cards/cards-${hash}.html`,
    skybridgeUri: `ui://credentagent-cards/cards-${hash}.skybridge.html`,
  };
}

export interface CardToolMetaOptions {
  /** ChatGPT's status line while the tool runs (64 characters at most). Default "Working…". */
  invoking?: string;
  /** ChatGPT's status line once it has run. Default "Done". */
  invoked?: string;
  /** `true` lets the card's own buttons call this tool, with no model turn — for a tool such as Revoke,
   *  never for one that spends. Default `false`: only the model calls it. */
  callableFromCard?: boolean;
}

export interface CardToolMeta {
  [key: string]: unknown;
  /** MCP Apps (Claude): the resource that renders this tool's result, and who may call the tool. */
  ui: { resourceUri: string; visibility: Array<"model" | "app"> };
  /** The same resource, under the key older MCP Apps hosts read (what ext-apps' `registerAppTool` adds). */
  "ui/resourceUri": string;
  /** ChatGPT: the skybridge template. */
  "openai/outputTemplate": string;
  /** ChatGPT: whether the card's script may call this tool with `window.openai.callTool`. */
  "openai/widgetAccessible": boolean;
  /** ChatGPT: the status lines shown while the tool runs. */
  "openai/toolInvocation/invoking": string;
  "openai/toolInvocation/invoked": string;
}

/** One builder for every key, so none can be forgotten. By default the card cannot call the tool: MCP
 *  Apps' own default visibility is `["model", "app"]`, so the kit says `["model"]` out loud. */
export function cardToolMeta(uris: CardUris, options: CardToolMetaOptions = {}): CardToolMeta {
  const callableFromCard = options.callableFromCard === true;
  return {
    ui: { resourceUri: uris.resourceUri, visibility: callableFromCard ? ["model", "app"] : ["model"] },
    "ui/resourceUri": uris.resourceUri,
    "openai/outputTemplate": uris.skybridgeUri,
    "openai/widgetAccessible": callableFromCard,
    "openai/toolInvocation/invoking": options.invoking ?? "Working…",
    "openai/toolInvocation/invoked": options.invoked ?? "Done",
  };
}

interface ResourceRead {
  [key: string]: unknown;
  contents: Array<{ uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }>;
}

/** The slice of an MCP server the kit registers through. */
export interface CardsServer {
  registerResource(name: string, uri: string, metadata: { mimeType: string }, read: () => Promise<ResourceRead>): unknown;
}

/** The MCP Apps CSP: no network origins, and no bare `data:` — the MCP Apps default view CSP already
 *  allows `data:` images (the permission card's QR), and scanners refuse a bare scheme here (#372). */
const uiCsp = () => ({ ui: { csp: { resourceDomains: [], connectDomains: [] } } });

/** Register the page twice — MCP Apps and skybridge — served exactly as built, never rewritten. Both
 *  copies carry the MCP Apps CSP, since an MCP Apps host may read either (#372); the skybridge copy adds
 *  ChatGPT's own `openai/widgetCSP`, which keeps `data:` because ChatGPT's default isn't documented to. */
export function registerCardResources(server: CardsServer, html: string, uris: CardUris): void {
  server.registerResource(uris.resourceUri, uris.resourceUri, { mimeType: MCP_APP_MIME }, async () => ({
    contents: [{ uri: uris.resourceUri, mimeType: MCP_APP_MIME, text: html, _meta: uiCsp() }],
  }));
  server.registerResource("credentagent-cards-skybridge", uris.skybridgeUri, { mimeType: SKYBRIDGE_MIME }, async () => ({
    contents: [
      {
        uri: uris.skybridgeUri,
        mimeType: SKYBRIDGE_MIME,
        text: html,
        _meta: { ...uiCsp(), "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } },
      },
    ],
  }));
}
