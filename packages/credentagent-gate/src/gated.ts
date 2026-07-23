// gated() — the v0-overnight blocking wrapper, kept as a DEPRECATED shim.
//
// v0.1 is consolidated Mode A: the checkout tool mints the link + surfaces a
// `requires` manifest (see CredentAgent.requirements), and the page runs the gates.
// gated() is the Mode-B blocking shape — it withholds completion and returns a
// `verification_required` envelope. Retained for page-less tools / one minor
// version; prefer `requirements()` for checkout. Will be removed after v0.2.

import type { DcqlQuery, GateOrder } from "./types.js";
import { ageDcql, buildVerificationRequired, envelopeInstruction } from "./envelope.js";

export interface MinimalToolResult {
  structuredContent?: Record<string, unknown>;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// v0.1 enforces ONLY the age gate at the tool layer, so the policy exposes only
// what gated() actually enforces — a policy key that looks enforced but is a
// silent no-op would be a foot-gun for a consent library.
export interface EasyGatePolicy {
  /** Require age verification. `true` uses the cart's strictest item threshold. */
  age?: boolean;
}

export interface GateDeps<A, O extends GateOrder> {
  /** Resolve the order from the tool args (created ONCE, so the id is stable). */
  resolveOrder: (args: A) => O | Promise<O>;
  /** True iff this order is age-restricted AND has no recorded age verification. */
  isAgeUnverified: (order: O) => boolean | Promise<boolean>;
  /** Per-order link the buyer opens to prove age. */
  approveUrl: (order: O) => string;
  /** The age threshold for this order (e.g. 21), or undefined. */
  minAge?: (order: O) => number | undefined;
  /** The DCQL to request; defaults to `ageDcql()`. */
  request?: DcqlQuery;
  resumeTool?: string;
}

/**
 * @deprecated Use `credentagent.gate(handler, { require, provenBy })` — the
 * general Mode-B facade — for page-less tools, or `CredentAgent.requirements()`
 * for checkout. `gated()` is the v0-era shim, kept one minor version.
 *
 * Wrap an MCP tool handler so it returns a `verification_required` envelope when
 * the age gate isn't met, instead of completing. The handler receives the
 * resolved order so it never re-creates it (a fresh id would desync the approve
 * link from the verified order).
 */
export function gated<A, O extends GateOrder>(
  handler: (args: A, ctx: { order: O }) => MinimalToolResult | Promise<MinimalToolResult>,
  policy: EasyGatePolicy,
  deps: GateDeps<A, O>,
): (args: A) => Promise<MinimalToolResult> {
  return async (args: A): Promise<MinimalToolResult> => {
    const order = await deps.resolveOrder(args);
    if (policy.age && (await deps.isAgeUnverified(order))) {
      const minAge = deps.minAge?.(order);
      const env = buildVerificationRequired({
        order,
        credential: "age",
        request: deps.request ?? ageDcql(),
        approveUrl: deps.approveUrl(order),
        detail: `Cart contains age-restricted items. No age verification on file for order ${order.id}.`,
        minAge,
        resumeTool: deps.resumeTool,
      });
      return {
        // VerificationRequired is a plain JSON object; widen to the tool-result shape.
        structuredContent: env as unknown as Record<string, unknown>,
        content: [{ type: "text", text: envelopeInstruction(env) }],
      };
    }
    return handler(args, { order });
  };
}
