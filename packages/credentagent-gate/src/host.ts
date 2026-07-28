// defineHost() — the typed "bring your own host" seam contract (Context 2).
//
// `createStorefront()` is ONE host; the product promise is "mount the gate on ANY app." A
// dev with their own Express + MCP server, their own catalog/pricing, and their own order
// store shouldn't have to reverse-engineer the seam contract from client.ts / mount.ts, or
// call the low-level `completeOrder` by hand and thread a shared verification store + the
// credential registry through `app.locals` (exactly what credentagent-storefront's server.ts
// wires internally). `defineHost` absorbs that ceremony:
//
//   const host = defineHost({ catalog, orderStore, records, signingKey });
//   host.publish(app);                          // publish the seams onto the app
//   new CredentAgent({ walletOrigin }).mount(app);   // serve the /credentagent/* proof pages
//
// It BUILDS the shared completion for you from your `catalog` + `records` (or takes a
// ready-made `completion` seam), owns the per-order verification store (or takes yours), and
// publishes everything on `app.locals.credentagent` the SAME way the storefront does — so a
// well-formed host is byte-identical in behavior to the hand-wired seams, with no new path
// and no weakened invariant. Your own action calls `host.complete(input)` so the gates run
// server-side on your completion path too (Security invariant 1), never only in a page.

import { completeOrder, type ClearableCart, type CompletedOrderStore, type CompletionContext } from "./ceremony/completion.js";
import type {
  CeremonyCatalog,
  CeremonyOrderStore,
  CompletionInput,
  CompletionResult,
  CompletionSeam,
} from "./ceremony/types.js";
import type { Credential, VerificationStore } from "./types.js";
import { MemoryVerificationStore } from "./store.js";

/** The minimal Express-app shape `publish()` needs — just `app.locals` (no `express` dep). */
export interface HostApp {
  locals: Record<string, unknown>;
}

export interface DefineHostSpec {
  /** Server-side re-pricing — the amount source of truth (Security invariant 2). Required. */
  catalog: CeremonyCatalog;
  /** Resolve a created order by id (line items only; the catalog re-prices). Required. */
  orderStore: CeremonyOrderStore;
  /**
   * The completed-order store (idempotent, keyed by order id) `defineHost` uses to BUILD the
   * shared completion for you — so you never call `completeOrder` by hand. Provide this OR a
   * ready-made `completion` seam, not both.
   */
  records?: CompletedOrderStore;
  /**
   * A ready-made completion seam, if you'd rather bind `completeOrder` yourself (advanced /
   * an unusual store shape). Mutually exclusive with `records`.
   */
  completion?: CompletionSeam;
  /**
   * Stable HMAC key for the ceremony challenge (e.g. `process.env.GATE_SECRET`) so an
   * options→verify hop survives a serverless instance split. Pass this OR `allowEphemeralKey`.
   */
  signingKey?: string;
  /** Allow a per-process ephemeral key for a single-process dev server. Pass this OR `signingKey`. */
  allowEphemeralKey?: boolean;
  /**
   * The per-order verification store the rails write and completion reads (Security invariant
   * 4). Default: a fresh in-memory store (inject a shared one — e.g. Redis — for multi-instance).
   */
  verificationStore?: VerificationStore;
  /** A cart to empty on completion (optional). */
  cart?: ClearableCart;
  /** Optional demo-mode settlement; throwing GATES completion (records nothing). */
  settle?: CompletionContext["settle"];
  /**
   * Where a rail returns the buyer after they prove — YOUR checkout route, e.g.
   * `(id) => \`/checkout/${id}\``. Absent ⇒ each rail's default `/checkout?order=<id>`, which a
   * non-storefront host usually does not serve (the buyer would be bounced to a dead link).
   */
  returnUrl?: (orderId: string) => string;
  /** Opt-in: treat a verified Cart Mandate as the created-order transport (FR-007). Default off. */
  statelessOrders?: boolean;
}

/**
 * A host bound to its stores: the per-order verification store, `publish(app)` to wire the
 * seams onto your app, and `complete(input)` — the shared completion your OWN action calls so
 * the gates run server-side (never only in a rendered page).
 */
export interface Host {
  /** The per-order verification store the rails write and completion reads (invariant 4). */
  readonly verificationStore: VerificationStore;
  /**
   * Publish the ceremony seams onto `app.locals.credentagent` so `credentagent.mount(app)`
   * wires the `/credentagent/*` rails over them with zero explicit args. Call this BEFORE
   * `mount(app)`. Idempotent-friendly (merges onto any existing `app.locals.credentagent`).
   */
  publish(app: HostApp): void;
  /**
   * The shared completion seam — re-price, reconcile, run the age + custom gates, settle,
   * idempotent record. Call it from your own place-order / MCP tool so a gate is enforced on
   * YOUR completion path (invariant 1). Returns typed plain data: `{ completed, reason? }`.
   */
  complete(input: CompletionInput): Promise<CompletionResult>;
}

const err = (msg: string): Error => new Error(`[credentagent] defineHost(): ${msg}`);

/**
 * Turn a host's domain pieces (catalog, order store, completed-order store) into the ceremony
 * seams the gate consumes, with the shared `completeOrder` built for you. Fails fast, at
 * construction, on an incomplete or contradictory seam set — one clear error door.
 */
export function defineHost(spec: DefineHostSpec): Host {
  // One error door: validate the seam set up front (not a silent partial wiring).
  const missing: string[] = [];
  if (!spec.catalog) missing.push("catalog");
  if (!spec.orderStore) missing.push("orderStore");
  if (missing.length > 0) {
    throw err(`missing required seam(s): ${missing.join(", ")}. Pass { catalog, orderStore, records, signingKey }.`);
  }
  const hasRecords = spec.records !== undefined;
  const hasCompletion = spec.completion !== undefined;
  if (hasRecords && hasCompletion) {
    throw err("provide EITHER `records` (defineHost builds the completion for you) OR a ready-made `completion` seam — not both.");
  }
  if (!hasRecords && !hasCompletion) {
    throw err("provide `records` (a completed-order store) so defineHost can build the completion seam, or pass your own `completion`.");
  }
  if (!spec.signingKey && !spec.allowEphemeralKey) {
    throw err(
      "a stable `signingKey` is required so the challenge HMAC survives an instance split. " +
        "Pass { signingKey } (e.g. process.env.GATE_SECRET), or { allowEphemeralKey: true } for a single-process dev server.",
    );
  }

  const verificationStore = spec.verificationStore ?? new MemoryVerificationStore();

  // The app `publish()` binds to, so the built completion can read — LAZILY, at call time —
  // the seams `mount()` injects onto app.locals AFTER publish. Same lazy read the storefront
  // does for the registry; here also for the resolved signing key.
  let boundApp: HostApp | undefined;
  const localsOf = (): { credentialRegistry?: ReadonlyMap<string, Credential>; signingKey?: string } | undefined =>
    boundApp?.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential>; signingKey?: string } | undefined;
  const registryOf = (): ReadonlyMap<string, Credential> | undefined => localsOf()?.credentialRegistry;
  // The key completion verifies a Cart Mandate with MUST be the one the rails signed it with.
  // On the `allowEphemeralKey` path mount GENERATES the key and republishes it here, so
  // forwarding `spec.signingKey` (undefined) would skip signature + reconciliation entirely —
  // a tampered/replayed cart mandate would pass. Read the resolved key from the bound app.
  const signingKeyOf = (): string | undefined => localsOf()?.signingKey ?? spec.signingKey;

  // Build the shared completion over the host's stores (unless the host brought its own).
  const complete: CompletionSeam =
    spec.completion ??
    ((input: CompletionInput): Promise<CompletionResult> =>
      completeOrder(input, {
        catalog: spec.catalog,
        verificationStore,
        records: spec.records!,
        ...(spec.cart ? { cart: spec.cart } : {}),
        ...(spec.settle ? { settle: spec.settle } : {}),
        ...(signingKeyOf() ? { signingKey: signingKeyOf() } : {}),
        // Read at CALL time (mount injects the registry after publish) so a custom gate() is
        // enforced here, not only in the rendered page (invariant 1). Absent ⇒ sweep skipped.
        ...(registryOf() ? { credentialRegistry: registryOf() } : {}),
      }));

  return {
    verificationStore,
    complete: (input) => Promise.resolve(complete(input)),
    publish(app: HostApp): void {
      boundApp = app;
      app.locals.credentagent = {
        ...(app.locals.credentagent as Record<string, unknown> | undefined),
        orderStore: spec.orderStore,
        catalog: spec.catalog,
        verificationStore,
        completion: complete,
        ...(spec.signingKey ? { signingKey: spec.signingKey } : {}),
        // Match mount()'s fail-closed default: an ephemeral key is allowed only when the host
        // opted in (or supplied no stable key on a single-process server).
        allowEphemeralKey: spec.allowEphemeralKey ?? !spec.signingKey,
        ...(spec.statelessOrders ? { statelessOrders: spec.statelessOrders } : {}),
        // A non-storefront host serves its checkout at its OWN route; publish it so the rails
        // return the buyer there after a proof, not to the default /checkout?order=<id>.
        ...(spec.returnUrl ? { returnUrl: spec.returnUrl } : {}),
      };
    },
  };
}
