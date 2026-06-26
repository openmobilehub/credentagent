// The canonical `_meta` for a UI-linked storefront tool — emitting BOTH host
// surfaces from ONE place so neither can be forgotten.
//
//   • MCP-Apps hosts (Claude native app / claude.ai) read `ui.resourceUri`.
//   • ChatGPT (skybridge) reads the `openai/*` keys.
//
// `openai/widgetAccessible: true` is what authorizes `window.openai.callTool`.
// The reference demo set `openai/outputTemplate` but NOT `widgetAccessible`
// (an inline `_meta` that forgot a key), which is exactly why its widget rendered
// in ChatGPT but was interactively dead — the steppers and Checkout button
// silently no-op'd. Routing every UI-linked tool through this builder makes that
// omission impossible (FR-014).

export interface AppToolMeta {
  // Index signature so this satisfies the MCP tool `_meta` shape (`{ [k]: unknown } & …`).
  [key: string]: unknown;
  /** MCP-Apps (Claude) — the widget resource to render. */
  ui: { resourceUri: string };
  /** ChatGPT — the skybridge template (the registered `text/html+skybridge` resource). */
  "openai/outputTemplate": string;
  /** ChatGPT — authorizes `window.openai.callTool` from inside the widget. */
  "openai/widgetAccessible": true;
  /** ChatGPT — the invoking/invoked status strings shown while a tool runs. */
  "openai/toolInvocation": { invoking: string; invoked: string };
}

export interface AppToolMetaUris {
  /** The MCP-Apps `ui://` resource (Claude). */
  resourceUri: string;
  /** The ChatGPT skybridge `ui://` resource; defaults to `resourceUri` if a single resource serves both. */
  skybridgeUri?: string;
}

/** Build the canonical UI-linked tool `_meta` (both host surfaces, `widgetAccessible` always on). */
export function appToolMeta(
  uris: AppToolMetaUris,
  status?: { invoking?: string; invoked?: string },
): AppToolMeta {
  return {
    ui: { resourceUri: uris.resourceUri },
    "openai/outputTemplate": uris.skybridgeUri ?? uris.resourceUri,
    "openai/widgetAccessible": true,
    "openai/toolInvocation": {
      invoking: status?.invoking ?? "Working…",
      invoked: status?.invoked ?? "Done",
    },
  };
}
