// The card page's one bridge to whichever app shows it (spec 015 FR-5). Its methods are the card's
// only reach outside itself — open a link, call a server tool — and neither decides anything: the
// server does (security invariant 1).

export type Host = "mcp" | "chatgpt" | "preview";

export interface Bridge {
  host: Host;
  /** Call a server tool from the card; resolves to its structured result (null in the preview). */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Open a link through the host — a sandboxed card cannot open one itself. */
  open(url: string): Promise<void>;
}

/** ChatGPT injects `window.openai`; any other frame is an MCP Apps host (Claude); a top-level tab is the preview. */
export function detectHost(win: { openai?: unknown; self: unknown; top: unknown }): Host {
  if (win.openai) return "chatgpt";
  return win.self !== win.top ? "mcp" : "preview";
}
