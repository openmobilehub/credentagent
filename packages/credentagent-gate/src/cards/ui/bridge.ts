// The card page's one bridge to whichever app shows it (spec 015 FR-9). Its methods are the card's
// only reach outside itself — open a link, call a server tool — and neither decides anything: the
// server does (security invariant 1).

export type Host = "mcp" | "chatgpt" | "preview";

export interface Bridge {
  host: Host;
  /** Call a server tool from the card; resolves to its structured result. Rejects when there is no
   *  server to call (the preview, or a host that can't call one from a card). */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Open a link through the host — a sandboxed card cannot open one itself. Rejects when the host
   *  can't or didn't open it. */
  open(url: string): Promise<void>;
}

/** ChatGPT injects `window.openai`; any other frame is an MCP Apps host (Claude); a top-level tab is the preview. */
export function detectHost(win: { openai?: unknown; self: unknown; top: unknown }): Host {
  if (win.openai) return "chatgpt";
  return win.self !== win.top ? "mcp" : "preview";
}
