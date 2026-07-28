// The configure-once client (Principle I): construct with your wallet origin,
// then declarative calls. `requirements(order, policy)` resolves a policy to the
// serializable manifest (Context 1); `mount(app)` is the Context-2 seam.

import * as x509 from "@peculiar/x509";
import type { Branding, Credential, CredentAgentOptions, GateOrder, ReaderIdentity, Step, VerificationManifestEntry, VerificationStore } from "./types.js";
import { resolveRequirements } from "./manifest.js";
import { MemoryVerificationStore } from "./store.js";
import { mountCeremony, type CeremonyApp, type CeremonySeams } from "./ceremony/mount.js";
import { Orders, MemoryOrderStore, type CreatedOrder, type CompletedOrder } from "./orders.js";
import { serveOrders } from "./orders-serve.js";
import { Webhooks } from "./webhooks.js";
import { Grants } from "./grants.js";
import { runDoctor, formatDoctorReport, type DoctorReport } from "./doctor.js";

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
  /** The human-not-present resource — `grants.create()` / `grants.retrieve()` (spec 009, #104). */
  readonly grants: Grants;
  /** Stable reader identity presented by the rails (undefined ⇒ per-request self-signed). */
  readonly readerIdentity?: ReaderIdentity;
  /** Host brand for the ceremony pages, threaded into every rail + the checkout page
   *  (undefined ⇒ the built-in look). Set once here; never brands the honesty footer. */
  readonly branding?: Branding;
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
  // Per-order resolved policy (order id → the policy's custom-credential ids), remembered by
  // `requirements()` so the mounted ceremony seam can scope the completion sweep to THIS order's
  // policy under the plain `mount(app, ceremony)` path — not only via `orders.serve` (PR #131
  // review). In-memory + bounded (see `rememberOrderPolicy`); a completing instance that never saw
  // the order falls back to the registry-wide sweep (fail-closed). Holds ids only; never the wire.
  private readonly orderPolicies = new Map<string, readonly string[]>();
  // Config facts `doctor()` inspects (#25). Retained at construction so the preflight can read
  // what was configured once — a stable gateSecret, and whether the stores are shared (injected)
  // or the in-memory defaults. `walletOrigin` + `readerIdentity` are already public/held above.
  private readonly hasGateSecret: boolean;
  private readonly sharedVerificationStore: boolean;
  private readonly sharedOrderStores: boolean;
  // #25 doctor() — EFFECTIVE config captured at mount() (PR #134 review). When the client is
  // composed with a host — `mount(app, ceremony)` seams, or `createStorefront(...) + mount(store.app)`
  // — the signing key / verification store can come from those seams, which doctor's constructor-only
  // flags would miss. Capture what's visible so a correctly configured composition isn't flagged, and
  // record that a host owns the serving surface (its order persistence lives in its completion seam).
  private mountSigningKey = false;
  private mountSharedStore = false;
  private composedWithHost = false;

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
    // #25 doctor(): remember what was configured — an injected store is "shared" (survives an
    // instance split); the default MemoryVerificationStore is not. A non-empty gateSecret makes
    // orders.serve's challenge HMAC stable across instances.
    // #25 doctor(): an injected store counts as "shared" only if it survives an instance split —
    // explicitly passing the EXPORTED in-memory implementation is still process-local, so it does
    // NOT count (PR #134 review). A non-empty gateSecret makes the challenge HMAC stable.
    this.sharedVerificationStore = opts.store !== undefined && !(opts.store instanceof MemoryVerificationStore);
    this.hasGateSecret = typeof opts.gateSecret === "string" && opts.gateSecret.length > 0;
    this.readerIdentity = opts.readerIdentity;
    // Host brand for the ceremony pages — threaded into every mount path below. Kept raw;
    // theme.ts sanitizes each field at the one point it is interpolated into a page.
    if (opts.branding) this.branding = opts.branding;
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
    // #25 doctor(): orders.serve survives an instance split only when BOTH order stores are shared.
    this.sharedOrderStores =
      opts.orderStore !== undefined && !(opts.orderStore instanceof MemoryOrderStore) &&
      opts.completedOrderStore !== undefined && !(opts.completedOrderStore instanceof MemoryOrderStore);
    // The outbound HTTP webhook sender (spec 010). Zero endpoints ⇒ inert (additive, zero-cost).
    this.webhooks = new Webhooks(opts.webhooks ?? {});
    // The delegated-spend resource (spec 009): needs the priced catalog to bound + price spends.
    this.grants = new Grants({ walletOrigin: this.walletOrigin, ...(opts.catalog ? { catalog: opts.catalog } : {}) });
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
          ...(this.branding ? { branding: this.branding } : {}),
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
  /** Remember an order's resolved policy credential ids, bounded so a long-running process can't
   *  grow it without limit — evicting the oldest (FIFO) drops back to the fail-closed registry-wide
   *  sweep for that order, never opens a gate. */
  private rememberOrderPolicy(orderId: string, credentialIds: readonly string[]): void {
    this.orderPolicies.delete(orderId); // re-insert at the tail so a re-resolve refreshes recency
    this.orderPolicies.set(orderId, credentialIds);
    const MAX = 10_000;
    while (this.orderPolicies.size > MAX) {
      const oldest = this.orderPolicies.keys().next().value;
      if (oldest === undefined) break;
      this.orderPolicies.delete(oldest);
    }
  }

  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[] {
    // Register-on-resolve (007): remember each policy credential by id so the mounted
    // rails + `completeOrder` can reach its request/verify/appliesTo by id. Synchronous
    // (an in-memory Map write), so `requirements()` stays sync — no public-API change.
    for (const step of policy) this.registry.set(step.credential.id, step.credential);
    // Remember THIS order's resolved policy so the completion sweep can scope to it under the plain
    // `mount(app, ceremony)` path — not only via `orders.serve` (#59 finding 2 follow-up, PR #131
    // review). The passkey/dc-payment rails can't derive the policy from their context; the mounted
    // ceremony seam (mount.ts) reads this map to set `input.policyCredentialIds` on every rail's
    // completion. A synchronous in-memory write (like register-on-resolve above), keyed by order id
    // — from the developer's policy, never the token. Single-process only: a multi-instance completing
    // instance that never ran this falls back to the registry-wide sweep (fail-closed), same as before.
    this.rememberOrderPolicy(order.id, policy.map((step) => step.credential.id));
    return resolveRequirements(order, policy, { walletOrigin: this.walletOrigin, mountedRoutes: this.mountedRoutes });
  }

  /**
   * Config preflight (#25) — validate this client's configuration for a deployment and return
   * typed plain data: `{ ok, findings: [{ level, code, message, fix }] }`. `ok` is true when there
   * are no `error`-level findings. It NEVER throws (it reports; you decide) and NEVER touches the
   * network — it reads this client's config + `process.env` for deployment signals only.
   *
   *   const report = credentagent.doctor();
   *   if (!report.ok) { report.findings.forEach((f) => console.error(f.message, "→", f.fix)); process.exit(1); }
   *
   * Pass `{ print: true }` for a one-line human-readable summary printed to the console (it returns
   * the SAME report, so you can still branch on `report.ok`):
   *
   *   credentagent.doctor({ print: true });
   *
   * Checks: a missing stable `gateSecret` (an ephemeral challenge key breaks a multi-instance /
   * serverless deploy), a `localhost` `walletOrigin` in a deployed environment (a buyer's phone
   * can't reach it), and the in-memory default stores (verification + order state that don't survive
   * an instance split). In plain local dev — no deployment env signals — it reports nothing.
   */
  doctor(opts: { print?: boolean } = {}): DoctorReport {
    const report = runDoctor({
      walletOrigin: this.walletOrigin,
      // Effective config: the constructor value OR what a mounted host/composed storefront supplied.
      hasGateSecret: this.hasGateSecret || this.mountSigningKey,
      sharedVerificationStore: this.sharedVerificationStore || this.mountSharedStore,
      sharedOrderStores: this.sharedOrderStores,
      composedWithHost: this.composedWithHost,
      env: process.env,
    });
    if (opts.print) {
      const block = formatDoctorReport(report);
      if (!report.ok) console.error(block);
      else if (report.findings.length > 0) console.warn(block);
      else console.log(block);
    }
    return report;
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
      mountCeremony(app as CeremonyApp, { ...ceremony, verificationStore: this.store, readerIdentity: this.readerIdentity, credentialRegistry: this.registry, orderPolicies: this.orderPolicies, ...(this.branding ? { branding: this.branding } : {}) });
      this.mountedRoutes = true;
      // #25 doctor(): a host owns the serving surface here; capture the signing key it supplied via
      // the seams (the verification store is this.store — already reflected in sharedVerificationStore).
      this.composedWithHost = true;
      if (typeof ceremony.signingKey === "string" && ceremony.signingKey.length > 0) this.mountSigningKey = true;
      return;
    }
    // Zero-arg compose (the quickstart): a host (e.g. credentagent-storefront) has
    // already populated the ceremony seams on `app.locals.credentagent`. Wire the rails
    // straight from those seams — including the host's OWN verificationStore when it
    // supplied one, so its `completion` seam shares the exact per-order state the
    // rails write (invariant 4). Falls back to CredentAgent's own store otherwise.
    const locals = (app.locals.credentagent ?? {}) as Partial<CeremonySeams>;
    if (locals.orderStore && locals.catalog && locals.completion) {
      mountCeremony(app as CeremonyApp, { readerIdentity: this.readerIdentity, credentialRegistry: this.registry, orderPolicies: this.orderPolicies, ...(this.branding ? { branding: this.branding } : {}), ...(locals.verificationStore ? {} : { verificationStore: this.store }) });
      this.mountedRoutes = true;
      // #25 doctor(): a composed storefront owns the serving surface. Capture the effective signing
      // key + verification store it published on app.locals (e.g. createStorefront({ signingKey,
      // storage })) so a correctly configured composition isn't flagged (PR #134 review).
      this.composedWithHost = true;
      if (typeof locals.signingKey === "string" && locals.signingKey.length > 0) this.mountSigningKey = true;
      if (locals.verificationStore && !(locals.verificationStore instanceof MemoryVerificationStore)) this.mountSharedStore = true;
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
