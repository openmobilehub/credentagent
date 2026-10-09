// How the card page is offered to the two chat apps (spec 015 FR-2, FR-3): one page, two resources,
// and the tool `_meta` that links a tool's result to them. Plain data and a structural port — the kit
// imports no MCP SDK (principle 6); `McpServer` from @modelcontextprotocol/server fits the port.
import { PERMISSION_STATUS_TOOL, type PermissionStatusAnswer } from "./contract.js";
import type { CardResult } from "./results.js";

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

/** `{ grantId: string }` as a Standard Schema with its JSON Schema — written by hand, so the kit needs
 *  no schema library. The MCP SDK validates tool input through `validate` and lists `jsonSchema`. */
export interface GrantIdSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: { grantId: string } } | { issues: ReadonlyArray<{ message: string }> };
    readonly jsonSchema: { readonly input: (options: unknown) => Record<string, unknown>; readonly output: (options: unknown) => Record<string, unknown> };
  };
}

const GRANT_ID_JSON = { type: "object", properties: { grantId: { type: "string" } }, required: ["grantId"], additionalProperties: false };

export const GRANT_ID_INPUT: GrantIdSchema = {
  "~standard": {
    version: 1,
    vendor: "credentagent",
    validate: (value) =>
      value !== null && typeof value === "object" && typeof (value as { grantId?: unknown }).grantId === "string"
        ? { value: { grantId: (value as { grantId: string }).grantId } } // only the grant id goes through
        : { issues: [{ message: "grantId must be a string" }] },
    jsonSchema: { input: () => ({ ...GRANT_ID_JSON }), output: () => ({ ...GRANT_ID_JSON }) },
  },
};

/** The slice of an MCP server the kit registers through. */
export interface CardsServer {
  registerResource(name: string, uri: string, metadata: { mimeType: string }, read: () => Promise<ResourceRead>): unknown;
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: GrantIdSchema; annotations: { readOnlyHint: true }; _meta: Record<string, unknown> },
    handler: (args: { grantId: string }) => Promise<CardResult>,
  ): unknown;
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

/** The card-only tool the permission card follows the signature through: hidden from the model
 *  (`ui.visibility: ["app"]`), callable from the card (`openai/widgetAccessible`). It takes only a grant
 *  id — never a URL from the card — and answers what the server decided. */
export function registerPermissionStatusTool(server: CardsServer, answer: (grantId: string) => Promise<PermissionStatusAnswer>): void {
  server.registerTool(
    PERMISSION_STATUS_TOOL,
    {
      title: "Permission status (card only)",
      description: "Used by the permission card to follow the phone signature. The model does not call it.",
      inputSchema: GRANT_ID_INPUT,
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
    },
    async ({ grantId }) => {
      const status = await answer(grantId);
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: { ...status } };
    },
  );
}
