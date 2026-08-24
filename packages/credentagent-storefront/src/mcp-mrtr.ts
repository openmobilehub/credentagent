// MRTR over the MCP SDK — the small bit of plumbing the SDK does not do for us yet.
//
// In MCP's multi round-trip pattern the client retries a tool call carrying two request-level
// params next to `name` and `arguments`:
//
//   { "method": "tools/call", "params": { "name": "…", "arguments": {…},
//                                         "inputResponses": {…}, "requestState": "…" } }
//
// `@modelcontextprotocol/sdk@1.29` predates the pattern: its `tools/call` schema knows nothing
// about those two fields and a tool handler only ever receives `arguments`. So this module wraps
// the server's raw `tools/call` handler, reads the two fields off the request before the SDK
// parses them away, and parks them where the handler can read them for the duration of that one
// call (AsyncLocalStorage — concurrent calls never see each other's state).
//
// It is additive and fail-soft: nothing here changes how a tool call behaves, and if a future SDK
// starts surfacing these params itself, `enableMrtrParams` simply stops being the only path.
// Tool handlers must ALSO accept the answers through their own arguments, because no shipping
// client implements MRTR yet — see `create-spending-grant`.
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The two request-level fields MRTR adds to `tools/call`. */
export interface MrtrCallParams {
  /** Opaque server state the client echoed back verbatim. */
  requestState?: string;
  /** The client's answers to the previous round's questions. */
  inputResponses?: unknown;
}

const current = new AsyncLocalStorage<MrtrCallParams>();

/** The MRTR params of the `tools/call` being handled right now (`{}` outside one). */
export function mrtrParams(): MrtrCallParams {
  return current.getStore() ?? {};
}

/**
 * Teach an `McpServer` to carry MRTR's request-level params through to its tool handlers.
 * Call it AFTER the tools are registered (the SDK installs its `tools/call` handler lazily).
 *
 * Returns false if the SDK's internals moved and the wrap could not be applied — the caller
 * keeps working through the tool-argument fallback rather than breaking.
 */
export function enableMrtrParams(server: McpServer): boolean {
  type RawHandler = (request: { params?: Record<string, unknown> }, extra: unknown) => Promise<unknown>;
  const handlers = (server as unknown as { server?: { _requestHandlers?: Map<string, RawHandler> } }).server?._requestHandlers;
  const inner = handlers?.get("tools/call");
  if (!handlers || typeof inner !== "function") return false;

  handlers.set("tools/call", (request, extra) => {
    const params = request?.params ?? {};
    return current.run(
      {
        requestState: typeof params.requestState === "string" ? params.requestState : undefined,
        inputResponses: params.inputResponses,
      },
      () => inner(request, extra),
    );
  });
  return true;
}
