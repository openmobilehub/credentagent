// How the card page is offered to the two chat apps (spec 015 FR-2, FR-3): one page, two resources,
// and the tool `_meta` that links a tool's result to them. Plain data and a structural port — the kit
// imports no MCP SDK (principle 6); `McpServer` from @modelcontextprotocol/server fits the port.

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

export interface CardToolMeta {
  [key: string]: unknown;
  /** MCP Apps (Claude): the resource that renders this tool's result. */
  ui: { resourceUri: string };
  /** The same, under the key older MCP Apps hosts read (what ext-apps' `registerAppTool` adds). */
  "ui/resourceUri": string;
  /** ChatGPT: the skybridge template. */
  "openai/outputTemplate": string;
  /** ChatGPT: lets the card call tools — without it, a card's buttons are silently dead. */
  "openai/widgetAccessible": true;
  /** ChatGPT: the status lines shown while the tool runs. */
  "openai/toolInvocation": { invoking: string; invoked: string };
}

/** One builder for every key, so none can be forgotten (the storefront's `appToolMeta` rule). */
export function cardToolMeta(uris: CardUris, status: { invoking?: string; invoked?: string } = {}): CardToolMeta {
  return {
    ui: { resourceUri: uris.resourceUri },
    "ui/resourceUri": uris.resourceUri,
    "openai/outputTemplate": uris.skybridgeUri,
    "openai/widgetAccessible": true,
    "openai/toolInvocation": { invoking: status.invoking ?? "Working…", invoked: status.invoked ?? "Done" },
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

/** Register the page twice — MCP Apps and skybridge — served exactly as built, never rewritten. The
 *  CSP allows `data:` images (the permission card's QR code) and no network origins. */
export function registerCardResources(server: CardsServer, html: string, uris: CardUris): void {
  server.registerResource(uris.resourceUri, uris.resourceUri, { mimeType: MCP_APP_MIME }, async () => ({
    contents: [
      { uri: uris.resourceUri, mimeType: MCP_APP_MIME, text: html, _meta: { ui: { csp: { resourceDomains: ["data:"], connectDomains: [] } } } },
    ],
  }));
  server.registerResource("credentagent-cards-skybridge", uris.skybridgeUri, { mimeType: SKYBRIDGE_MIME }, async () => ({
    contents: [
      { uri: uris.skybridgeUri, mimeType: SKYBRIDGE_MIME, text: html, _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } } },
    ],
  }));
}
