// Connects the card page to whichever app shows it (spec 015 FR-9) and returns its Bridge.
//  • Claude and other MCP Apps hosts: the ext-apps client — results arrive as `toolresult`.
//  • ChatGPT: `window.openai` — the result is re-delivered on every `openai:set_globals`.
//  • A plain browser tab: the preview, from the `?view=` samples.
// Both chat apps deliver through one guard that ignores a re-delivery of the result it last
// delivered, so a card the user changed (a Revoke) is not put back to the old result.
// A bridge call the host can't make throws, so the card says so instead of failing silently.

import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { detectHost, type Bridge } from "./bridge";
import type { CardStore, HostResult } from "./card-store";
import { previewResult } from "./preview";

/** The part of ChatGPT's `window.openai` the page uses (the surface evolves, so every call is optional). */
interface OpenAiGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  theme?: "light" | "dark";
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (options: { href: string }) => void | Promise<void>;
}
type CardWindow = Window & { openai?: OpenAiGlobals };

export async function connectHost(store: CardStore, win: CardWindow = window): Promise<Bridge> {
  const host = detectHost(win);
  if (host === "chatgpt") return connectChatGpt(deliverer(store), win, win.openai!);
  if (host === "mcp") return connectMcp(deliverer(store));
  return connectPreview(store, win);
}

/** Hands a host's results to the store, skipping a re-delivery of the one it last delivered. Keyed on
 *  the card's data, as the store is: metadata the store ignores can't let a stale result back in. */
function deliverer(store: CardStore): (result: HostResult) => void {
  let delivered: string | undefined;
  return (result) => {
    const key = JSON.stringify(result.structuredContent ?? null);
    if (key === delivered) return;
    delivered = key;
    store.show(result);
  };
}

async function connectMcp(deliver: (result: HostResult) => void): Promise<Bridge> {
  const app = new App({ name: "credentagent-cards", version: "1.0.0" });
  // Listen before connecting, so the result that opened the card is not missed.
  app.addEventListener("toolresult", (result) => deliver(result));
  app.addEventListener("hostcontextchanged", (context) => applyHostContext(context));
  await app.connect();
  applyHostContext(app.getHostContext());
  return {
    host: "mcp",
    call: async (name, args) => (await app.callServerTool({ name, arguments: args })).structuredContent ?? null,
    open: async (url) => {
      // A host may decline with an error result instead of rejecting.
      if ((await app.openLink({ url }))?.isError) throw new Error("the chat app didn't open the link");
    },
  };
}

function connectChatGpt(deliver: (result: HostResult) => void, win: CardWindow, openai: OpenAiGlobals): Bridge {
  const read = (): void => {
    if (openai.theme) setTheme(openai.theme);
    deliver({ structuredContent: openai.toolOutput, _meta: openai.toolResponseMetadata });
  };
  read();
  win.addEventListener("openai:set_globals", read);
  return {
    host: "chatgpt",
    call: async (name, args) => {
      if (!openai.callTool) throw new Error("this chat app can't call the server from a card");
      const result = await openai.callTool(name, args);
      return result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : (result ?? null);
    },
    open: async (url) => {
      if (!openai.openExternal) throw new Error("this chat app can't open links from a card");
      await openai.openExternal({ href: url });
    },
  };
}

function connectPreview(store: CardStore, win: CardWindow): Bridge {
  const params = new URLSearchParams(win.location.search);
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") setTheme(theme);
  store.show(previewResult(params.get("view")));
  return {
    host: "preview",
    call: async () => {
      throw new Error("the preview has no server to call");
    },
    open: async (url) => {
      win.open(url, "_blank", "noopener");
    },
  };
}

/** Force light or dark: `data-theme` for CSS selectors, `color-scheme` for the gallery's light-dark() colors. */
function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** The host's theme, style variables and fonts (MCP Apps); the page's own fallbacks cover the rest. */
function applyHostContext(context: Partial<McpUiHostContext> | undefined): void {
  if (!context) return;
  if (context.theme) {
    applyDocumentTheme(context.theme);
    setTheme(context.theme);
  }
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
