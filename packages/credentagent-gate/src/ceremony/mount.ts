// The injected-seam contract for the ceremony (Context 2). `mountCeremony(app)`
// reads the seams the host provides (options + `app.locals.credentagent`), FAILS FAST
// when a load-bearing one is missing (CT2 — never silently degrade), resolves a
// CeremonyContext, and registers each rail's routes onto the host app. With no
// rails extracted yet (Phase 2 — Foundational), it validates the seams + builds
// the context only; the passkey / dc-payment / credential-gate rails push their
// registrars here as they land (US1–US3).
//
// The package stays dependency-free: `CeremonyApp` is a minimal structural type
// (no `express` import) carrying just `locals` + the route methods a rail needs.
import { randomBytes } from "node:crypto";
import type { Credential, ReaderIdentity, VerificationStore } from "../types.js";
import { deriveOrigin, type Origin, type RequestLike } from "./origin.js";
import type {
  CeremonyCatalog,
  CeremonyOrder,
  CeremonyOrderStore,
  CompletionSeam,
  DelegatedVerifier,
  SettlementSeam,
} from "./types.js";
import { verifyCartMandate } from "./cartMandate.js";
import { registerCredentialGate } from "./credential-gate/routes.js";
import { registerPasskeyGate } from "./passkey/routes.js";
import { registerDcPaymentGate } from "./dc-payment/routes.js";
import { registerDelegatedPaymentGate } from "./delegated-payment/routes.js";

/** Minimal Express-app shape mount() needs (no `express` dependency). */
export interface CeremonyApp {
  locals: Record<string, unknown>;
  // Route methods the rails use once they land; optional for the foundational
  // scaffold, which registers no routes yet.
  get?(path: string, ...handlers: unknown[]): unknown;
  post?(path: string, ...handlers: unknown[]): unknown;
  use?(path: string, ...handlers: unknown[]): unknown;
}

/** What the host injects. Required seams throw if missing (CT2); `origin`,
 *  `settlement`, and the signing-key escape hatch have safe behaviors. */
export interface CeremonySeams {
  /** Per-order verification state (never process-global — invariant 4). */
  verificationStore: VerificationStore;
  /** Resolve a created order by id (totals are re-priced from `catalog`). */
  orderStore: CeremonyOrderStore;
  /** Server-side re-pricing — the amount source of truth (invariant 2). */
  catalog: CeremonyCatalog;
  /** Host-bound completion (idempotent record + cart/verification clear). */
  completion: CompletionSeam;
  /** Stable HMAC key for the challenge nonce. Required so options→verify survive
   *  an instance split (D6) UNLESS `allowEphemeralKey` is explicitly set. */
  signingKey?: string;
  /** RP-id / origin derivation; defaults to the built-in `deriveOrigin`. */
  origin?: (req: RequestLike) => Origin;
  /** Optional demo-mode settlement seam (absent ⇒ mock-complete). */
  settlement?: SettlementSeam;
  /** Optional external verifier/processor (008, #60). When present, the delegated rail
   *  is served and verification/settlement are delegated to it — the gate still owns
   *  pricing, binding, policy and recording. Absent ⇒ the delegated rail registers
   *  NOTHING and every existing path is byte-unchanged (genuinely optional, like
   *  `settlement`). */
  verifier?: DelegatedVerifier;
  /** Dev-only: allow an ephemeral per-process signing key. NEVER inferred —
   *  mount() does not guess "serverless". */
  allowEphemeralKey?: boolean;
  /** Opt-in (default false): treat a VERIFIED Cart Mandate as the created-order
   *  transport, so `resolveOrder` reconstructs the order from it with no
   *  `orderStore` read (FR-007 / US3). Off ⇒ the store stays the source of truth
   *  and the mandate is an additive integrity envelope only. */
  statelessOrders?: boolean;
  /** Stable reader identity the rails present in their OpenID4VP request (clears
   *  the wallet's "unknown verifier" warning). Absent ⇒ per-request self-signed
   *  reader (presence-only). Normally set once on `new CredentAgent({ readerIdentity })`. */
  readerIdentity?: ReaderIdentity;
  /** The gate's in-process credential registry (id → Credential), populated by
   *  `requirements()` and passed here by `CredentAgent.mount()` (007). The rails read
   *  it to serve a custom credential's own request/verify; it is re-published on
   *  `app.locals.credentagent` so the host's `completion` seam can hand it to
   *  `completeOrder` for the custom-gate sweep. Holds CODE (never the wire). */
  credentialRegistry?: ReadonlyMap<string, Credential>;
}

/** The resolved context each rail receives (every required seam present). */
export interface CeremonyContext {
  verificationStore: VerificationStore;
  orderStore: CeremonyOrderStore;
  catalog: CeremonyCatalog;
  completion: CompletionSeam;
  signingKey: string;
  origin: (req: RequestLike) => Origin;
  settlement?: SettlementSeam;
  /** The external verifier/processor, when the host configured one (008). Absent ⇒
   *  the delegated rail is inert and no delegated route exists. */
  verifier?: DelegatedVerifier;
  /** FR-007: when true, `resolveOrder` may reconstruct from a verified Cart Mandate
   *  with no store read (absent/false — store is the source of truth). `mountCeremony`
   *  always sets it; optional here so a hand-built context literal need not. */
  statelessOrders?: boolean;
  /** Stable reader identity the rails present (absent ⇒ per-request self-signed). */
  readerIdentity?: ReaderIdentity;
  /** The gate's credential registry (007) — the rails read it to serve a custom
   *  credential's own request/verify. Absent when no CredentAgent registry was passed. */
  credentialRegistry?: ReadonlyMap<string, Credential>;
}

/** A rail attaches its routes to the host app given the resolved context. */
export type RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext) => void;

// Per-rail registration scaffold. Each rail (passkey / dc-payment /
// credential-gate) pushes its registrar here once extracted (US1–US3). US1 lands
// the credential gate (age + membership); passkey / dc-payment follow (US2/US3).
// Each registrar no-ops on a route-less app shape, so mount()'s fail-fast tests
// (which pass a `{ locals }`-only app) are unaffected.
// `registerDelegatedPaymentGate` (008) self-skips unless a `verifier` seam is
// configured, so adding it here changes nothing for a host that hasn't opted in.
const RAILS: RailRegistrar[] = [registerCredentialGate, registerPasskeyGate, registerDcPaymentGate, registerDelegatedPaymentGate];

/**
 * Read + validate the injected seams, build the CeremonyContext, and register
 * every rail's routes. Throws on a missing required seam (CT2). Seams may arrive
 * via `options` OR `app.locals.credentagent` — options win.
 */
export function mountCeremony(app: CeremonyApp, options: Partial<CeremonySeams> = {}): CeremonyContext {
  const locals = (app.locals.credentagent ?? {}) as Partial<CeremonySeams> & { store?: VerificationStore };

  const verificationStore = options.verificationStore ?? locals.verificationStore ?? locals.store;
  const orderStore = options.orderStore ?? locals.orderStore;
  const catalog = options.catalog ?? locals.catalog;
  const completion = options.completion ?? locals.completion;
  const settlement = options.settlement ?? locals.settlement;
  const verifier = options.verifier ?? locals.verifier;
  const origin = options.origin ?? locals.origin ?? deriveOrigin;
  const allowEphemeralKey = options.allowEphemeralKey ?? locals.allowEphemeralKey ?? false;
  const statelessOrders = options.statelessOrders ?? locals.statelessOrders ?? false;
  const readerIdentity = options.readerIdentity ?? locals.readerIdentity;
  const credentialRegistry = options.credentialRegistry ?? locals.credentialRegistry;
  let signingKey = options.signingKey ?? locals.signingKey;

  // Fail fast (CT2) — a load-bearing seam must never silently default. (`origin`
  // has a safe built-in default; `settlement` is genuinely optional.)
  const missing: string[] = [];
  if (!verificationStore) missing.push("verificationStore");
  if (!orderStore) missing.push("orderStore");
  if (!catalog) missing.push("catalog");
  if (!completion) missing.push("completion");
  if (missing.length > 0) {
    throw new Error(
      `[credentagent] mount(): missing required ceremony seam(s): ${missing.join(", ")}. ` +
        `Provide them via credentagent.mount(app, { ... }) or app.locals.credentagent.`,
    );
  }

  // The challenge HMAC must survive an instance split (options→verify may hit
  // different serverless instances — D6). We do NOT infer "serverless"; an
  // ephemeral per-process key is allowed ONLY when the host opts in explicitly.
  if (!signingKey) {
    if (!allowEphemeralKey) {
      throw new Error(
        `[credentagent] mount(): a stable 'signingKey' is required so the challenge HMAC survives an instance split. ` +
          `Pass { signingKey } (e.g. process.env.GATE_SECRET), or { allowEphemeralKey: true } for a single-process dev server.`,
      );
    }
    signingKey = randomBytes(32).toString("hex");
  }

  const ctx: CeremonyContext = {
    verificationStore: verificationStore as VerificationStore,
    orderStore: orderStore as CeremonyOrderStore,
    catalog: catalog as CeremonyCatalog,
    completion: completion as CompletionSeam,
    signingKey,
    origin,
    statelessOrders,
    ...(credentialRegistry ? { credentialRegistry } : {}),
    ...(settlement ? { settlement } : {}),
    ...(verifier ? { verifier } : {}),
    ...(readerIdentity ? { readerIdentity } : {}),
  };

  // Re-expose the resolved seams on app.locals so the storefront's gate routes
  // resolve verification THROUGH CredentAgent (and a re-mount is idempotent).
  app.locals.credentagent = { ...(app.locals.credentagent as Record<string, unknown> | undefined), store: ctx.verificationStore, ...ctx };

  for (const register of RAILS) register(app, ctx);

  return ctx;
}

/**
 * Shared order resolution + re-pricing (T003a). Resolve a created order by id,
 * then RE-PRICE it from the catalog — the displayed and bound amounts come from
 * the catalog, never the id/token (CT3, invariants 2/3). A tampered or unknown id
 * resolves to `null` (the rail refuses).
 *
 * FR-007 (opt-in `statelessOrders`): when the host has no shared order store, a
 * VERIFIED Cart Mandate carried on the request is the order transport — pass it as
 * `opts.cartMandate` and the created order is reconstructed from it with NO store
 * read, so a created order survives an instance split (US3). It stays fail-closed:
 * a forged / tampered / replayed (wrong-order) / expired mandate does not resolve
 * an order, and the catalog STILL reprices (the mandate carries the items, never
 * the price — invariant 2). Off (default), the store is the source of truth and any
 * mandate is an additive integrity envelope checked at completion, not a transport.
 */
export async function resolveOrder(
  ctx: CeremonyContext,
  orderId: string | undefined | null,
  opts?: { cartMandate?: unknown },
): Promise<CeremonyOrder | null> {
  if (!orderId) return null;

  // Stateless transport (opt-in): reconstruct from the verified mandate, no store read.
  if (ctx.statelessOrders && opts?.cartMandate !== undefined) {
    const verdict = verifyCartMandate(opts.cartMandate, orderId, ctx.signingKey);
    if (!verdict.ok) return null;
    const verification = await ctx.verificationStore.read(orderId);
    const loyaltyApplied = !!(verification as { loyalty?: { applied?: boolean } } | undefined)?.loyalty?.applied;
    return ctx.catalog.createOrder(
      verdict.mandate.lines.map((l) => ({ productId: l.id, quantity: l.quantity })),
      orderId,
      { loyaltyApplied },
    );
  }

  // Default: the store is the source of truth.
  const stored = await ctx.orderStore.read(orderId);
  if (!stored || stored.id !== orderId || !Array.isArray(stored.lines)) return null;
  // A loyalty discount is applied only when THIS order's verification opts in
  // (invariant 3); the line items come from the store, every price from the
  // catalog.
  const verification = await ctx.verificationStore.read(orderId);
  const loyaltyApplied = !!(verification as { loyalty?: { applied?: boolean } } | undefined)?.loyalty?.applied;
  return ctx.catalog.createOrder(
    stored.lines.map((l) => ({ productId: l.id, quantity: l.quantity })),
    orderId,
    { loyaltyApplied },
  );
}
