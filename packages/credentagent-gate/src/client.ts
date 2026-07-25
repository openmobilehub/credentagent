// The configure-once client (Principle I): construct with your wallet origin,
// then declarative calls. `requirements(order, policy)` resolves a policy to the
// serializable manifest (Context 1); `mount(app)` is the Context-2 seam.

import * as x509 from "@peculiar/x509";
import type { Credential, CredentAgentOptions, GateOrder, ReaderIdentity, Step, VerificationManifestEntry, VerificationStore } from "./types.js";
import { resolveRequirements } from "./manifest.js";
import { MemoryVerificationStore } from "./store.js";
import { mountCeremony, type CeremonyApp, type CeremonySeams } from "./ceremony/mount.js";
import { Orders, MemoryOrderStore, type CreatedOrder, type CompletedOrder } from "./orders.js";
import { serveOrders } from "./orders-serve.js";
import { Webhooks } from "./webhooks.js";

x509.cryptoProvider.set(globalThis.crypto);

/** The ceremony seams the host supplies to `mount()`; the per-order
 *  verification store is CredentAgent's own, so the host never passes it here. */
export type MountCeremony = Omit<Partial<CeremonySeams>, "verificationStore">;

/**
 * Minimal structural type for an Express app — the package stays dependency-free
 * (no `express` import). `mount()` only needs `app.locals` for the store seam.
 */
export interface ExpressApp {
  locals: Record<string, unknown>;
}

/** Zero-config default so `new CredentAgent()` works for local dev. */
const DEFAULT_WALLET_ORIGIN = `http://localhost:${process.env.PORT ?? 3000}`;

export class CredentAgent {
  readonly walletOrigin: string;
  readonly store: VerificationStore;
  /** The human-present checkout resource — `orders.create()` / `orders.retrieve()` (spec 009). */
  readonly orders: Orders;
  /** Outbound HTTP webhooks — `webhooks.register()` / `webhooks.constructEvent()` (spec 010). */
  readonly webhooks: Webhooks;
  /** Stable reader identity presented by the rails (undefined ⇒ per-request self-signed). */
  readonly readerIdentity?: ReaderIdentity;
  private readonly listeners = new Map<string, Set<(payload: { id: string }) => void>>();
  // True once the ceremony rails are wired onto a host app (so `/credentagent/*` routes
  // exist on this server). `requirements()` then emits approve links that resolve
  // to those mounted routes rather than the legacy `/credential-gate/*` shape.
  private mountedRoutes = false;
  // True once `orders.serve(app)` has wired the checkout (idempotent — one serve per client).
  private ordersServed = false;
  // In-process credential registry (id → Credential), populated as `requirements()`
  // resolves policies — register-on-resolve, so a developer registers nothing (Principle
  // V). Injected into the ceremony context at `mount()` so the rails can serve a custom
  // credential's own request/verify and `completeOrder` can sweep applicable custom gates
  // (007). Holds CODE (verify/appliesTo) in-process; never serialized, never the wire.
  private readonly registry = new Map<string, Credential>();

  constructor(opts: CredentAgentOptions = {}) {
    let origin = opts.walletOrigin?.trim();
    if (!origin) {
      // Zero-config: default to localhost so the getting-started example just runs.
      origin = DEFAULT_WALLET_ORIGIN;
    } else if (!/^https?:\/\//.test(origin)) {
      // Wallet ceremonies are origin-bound, so a scheme-less value can't work.
      // Warn and fall back rather than hard-failing (DX over a thrown error).
      console.warn(
        `[credentagent] walletOrigin "${origin}" is not an absolute http(s) origin; using ${DEFAULT_WALLET_ORIGIN}. ` +
          `Pass an absolute origin (e.g. https://shop.example) for any deployed environment.`,
      );
      origin = DEFAULT_WALLET_ORIGIN;
    }
    // OpenID4VP / WebAuthn are origin-bound, so a localhost origin in production
    // mints approve links a buyer's phone can't reach. Warn loudly — not fatal.
    if (process.env.NODE_ENV === "production" && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      console.warn(
        `[credentagent] walletOrigin is ${origin} in production — buyers can't open localhost approve links. ` +
          `Set { walletOrigin } to your public origin.`,
      );
    }
    this.walletOrigin = origin.replace(/\/$/, "");
    this.store = opts.store ?? new MemoryVerificationStore();
    this.readerIdentity = opts.readerIdentity;
    // Honesty / fail-fast: a reader cert whose SAN doesn't cover the origin host is
    // silently rejected by the wallet (origin binding, invariant 6). Warn now, at
    // construction, rather than let it surface as an opaque ceremony failure.
    if (this.readerIdentity) warnOnReaderSanMismatch(this.readerIdentity, this.walletOrigin);
    // Item 5: register any credentials declared up front so EVERY instance enforces them from
    // boot — not only after requirements() ran on THIS instance. A serverless / multi-worker
    // completion instance may never run requirements() (checkout landed elsewhere), leaving the
    // registry empty and the completion sweep a no-op → an applicable gate() completes UNPROVEN
    // (fail-open). register-on-resolve stays for zero-config dev; this makes multi-instance
    // deploys fail-closed. Reserved ids are inert here (the sweep + resolveCred skip them).
    for (const c of opts.credentials ?? []) this.registry.set(c.id, c);
    // The orders resource — configure-once: it reuses this client's origin + requirements(),
    // with in-memory order stores by default (inject a shared store for multi-instance deploys).
    // The two stores are held here so `orders.serve(app)` binds the checkout over the SAME
    // state `orders.create()` / `orders.retrieve()` use (invariant 4 — keyed per order id).
    const createdStore = opts.orderStore ?? new MemoryOrderStore<CreatedOrder>();
    const completedStore = opts.completedOrderStore ?? new MemoryOrderStore<CompletedOrder>();
    // The outbound HTTP webhook sender (spec 010). Zero endpoints ⇒ inert (additive, zero-cost).
    this.webhooks = new Webhooks(opts.webhooks ?? {});
    this.orders = new Orders({
      walletOrigin: this.walletOrigin,
      requirements: (order, policy) => this.requirements(order, policy),
      created: createdStore,
      completed: completedStore,
      emit: (event, payload) => this.emit(event, payload),
      // Fire-and-forget from the completion choke point — never blocks a settled order.
      deliverWebhook: (type, object) => { void this.webhooks.deliver(type, object); },
      serve: (app) => {
        if (this.ordersServed) return; // idempotent
        serveOrders(app as CeremonyApp, {
          walletOrigin: this.walletOrigin,
          created: createdStore,
          completed: completedStore,
          complete: (record) => this.orders._complete(record),
          requirements: (order, policy) => this.requirements(order, policy),
          verificationStore: this.store,
          credentialRegistry: this.registry,
          ...(this.readerIdentity ? { readerIdentity: this.readerIdentity } : {}),
          ...(opts.gateSecret ? { signingKey: opts.gateSecret } : {}),
        });
        this.ordersServed = true;
        this.mountedRoutes = true; // approve links now resolve to the mounted rails
      },
    });
  }

  /**
   * Subscribe to a lifecycle event. Today: `"order.settled"` — fired once when an order
   * completes (the completed-store write emits it).
   *
   * This is an IN-PROCESS listener, NOT an HTTP webhook: the handler runs in the same Node
   * process that completed the order, synchronously, with no network hop, retry, or signing.
   * In a single-process server that's all you need — react here instead of polling. In a
   * multi-instance / serverless deploy the event fires only on the instance that completed
   * the order; a listener elsewhere won't hear it, so read `orders.retrieve(id)` (backed by a
   * shared completed-order store) as the durable, cross-instance signal. A real outbound HTTP
   * webhook is not built yet.
   */
  on(event: "order.settled", handler: (payload: { id: string }) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  private emit(event: string, payload: { id: string }): void {
    for (const h of this.listeners.get(event) ?? []) {
      try { h(payload); } catch (err) { console.error(`[credentagent] ${event} handler threw:`, err); }
    }
  }

  /**
   * Context 1 — resolve a policy against a server-priced order into the flat,
   * JSON-safe `requires` manifest. Runs `.when()`/`appliesTo` predicates,
   * payment-last; no functions cross the wire.
   */
  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[] {
    // Register-on-resolve (007): remember each policy credential by id so the mounted
    // rails + `completeOrder` can reach its request/verify/appliesTo by id. Synchronous
    // (an in-memory Map write), so `requirements()` stays sync — no public-API change.
    for (const step of policy) this.registry.set(step.credential.id, step.credential);
    return resolveRequirements(order, policy, { walletOrigin: this.walletOrigin, mountedRoutes: this.mountedRoutes });
  }

  /**
   * Context 2 — wire the verification ceremony onto your Express app.
   *
   * Pass the ceremony seams (`{ orderStore, catalog, completion, signingKey, … }`)
   * to register the gate's routes through `mountCeremony`: it validates the seams,
   * FAILS FAST on a missing required one (CT2), and attaches each rail. CredentAgent's
   * own per-order store is injected as the `verificationStore` (keyed by order id,
   * never process-global — Security invariant 4), so the host never passes it.
   *
   * Called WITHOUT seams it keeps the v0.1 behavior: expose the per-order store
   * via `app.locals.credentagent` so a host's existing fail-closed `/credential-gate/*`
   * routes resolve verification state THROUGH CredentAgent. The rails register only
   * when seams are supplied; with none extracted yet, that path attaches no routes.
   */
  mount(app: ExpressApp, ceremony?: MountCeremony): void {
    if (ceremony) {
      mountCeremony(app as CeremonyApp, { ...ceremony, verificationStore: this.store, readerIdentity: this.readerIdentity, credentialRegistry: this.registry });
      this.mountedRoutes = true;
      return;
    }
    // Zero-arg compose (the quickstart): a host (e.g. credentagent-storefront) has
    // already populated the ceremony seams on `app.locals.credentagent`. Wire the rails
    // straight from those seams — including the host's OWN verificationStore when it
    // supplied one, so its `completion` seam shares the exact per-order state the
    // rails write (invariant 4). Falls back to CredentAgent's own store otherwise.
    const locals = (app.locals.credentagent ?? {}) as Partial<CeremonySeams>;
    if (locals.orderStore && locals.catalog && locals.completion) {
      mountCeremony(app as CeremonyApp, { readerIdentity: this.readerIdentity, credentialRegistry: this.registry, ...(locals.verificationStore ? {} : { verificationStore: this.store }) });
      this.mountedRoutes = true;
      return;
    }
    // Legacy (no seams): expose the per-order store so a host's existing
    // fail-closed routes resolve verification THROUGH CredentAgent.
    const existing = app.locals.credentagent as { store?: VerificationStore } | undefined;
    if (existing?.store === this.store) return; // idempotent
    app.locals.credentagent = { store: this.store, walletOrigin: this.walletOrigin, credentialRegistry: this.registry };
  }
}

/** DNS SAN entries on a reader leaf cert (empty if none / unparseable). */
function readerSanDnsNames(certPem: string): string[] {
  const san = new x509.X509Certificate(certPem).getExtension(x509.SubjectAlternativeNameExtension);
  return san ? san.names.items.filter((n) => n.type === "dns").map((n) => n.value) : [];
}

/** Warn (never throw) if the reader cert's SAN doesn't cover the wallet-origin
 *  host — the wallet would otherwise reject the request with no useful signal. */
function warnOnReaderSanMismatch(identity: ReaderIdentity, walletOrigin: string): void {
  let host: string;
  try {
    host = new URL(walletOrigin).hostname;
  } catch {
    return;
  }
  let dns: string[];
  try {
    dns = readerSanDnsNames(identity.cert);
  } catch {
    return; // malformed cert surfaces at request time; don't crash construction
  }
  if (dns.length > 0 && !dns.includes(host)) {
    console.warn(
      `[credentagent] readerIdentity cert SAN [${dns.join(", ")}] does not include walletOrigin host "${host}". ` +
        `The wallet will reject the request (origin binding). Re-mint the reader cert with a SAN covering "${host}".`,
    );
  }
}
