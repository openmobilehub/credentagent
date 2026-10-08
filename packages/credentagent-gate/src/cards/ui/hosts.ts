// Connects the card page to whichever app shows it (spec 015 FR-5) and returns its Bridge.
//  • Claude and other MCP Apps hosts: the ext-apps client — results arrive as `toolresult`.
//  • ChatGPT: `window.openai` — the result is re-delivered on every `openai:set_globals`, which the
//    card store absorbs (it replaces the card only when the data changed).
//  • A plain browser tab: the preview, from the `?view=` samples.

import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { detectHost, type Bridge } from "./bridge";
import type { CardStore } from "./card-store";
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
  if (host === "chatgpt") return connectChatGpt(store, win, win.openai!);
  if (host === "mcp") return connectMcp(store);
  return connectPreview(store, win);
}

async function connectMcp(store: CardStore): Promise<Bridge> {
  const app = new App({ name: "credentagent-cards", version: "1.0.0" });
  // Listen before connecting, so the result that opened the card is not missed.
  app.addEventListener("toolresult", (result) => {
    store.show(result);
  });
  app.addEventListener("hostcontextchanged", (context) => applyHostContext(context));
  await app.connect();
  applyHostContext(app.getHostContext());
  return {
    host: "mcp",
    call: async (name, args) => (await app.callServerTool({ name, arguments: args })).structuredContent ?? null,
    open: async (url) => {
      await app.openLink({ url });
    },
  };
}

function connectChatGpt(store: CardStore, win: CardWindow, openai: OpenAiGlobals): Bridge {
  const read = (): void => {
    if (openai.theme) setTheme(openai.theme);
    store.show({ structuredContent: openai.toolOutput, _meta: openai.toolResponseMetadata });
  };
  read();
  win.addEventListener("openai:set_globals", read);
  return {
    host: "chatgpt",
    call: async (name, args) => {
      const result = await openai.callTool?.(name, args);
      return result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : (result ?? null);
    },
    open: async (url) => {
      await openai.openExternal?.({ href: url });
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
    call: async () => null,
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
