// The injected-seam contract for the ceremony (Context 2). `mountCeremony(app)`
// reads the seams the host provides (options + `app.locals.attesto`), FAILS FAST
// when a load-bearing one is missing (CT2 — never silently degrade), resolves a
// CeremonyContext, and registers each rail's routes onto the host app. With no
// rails extracted yet (Phase 2 — Foundational), it validates the seams + builds
// the context only; the passkey / dc-payment / credential-gate rails push their
// registrars here as they land (US1–US3).
//
// The package stays dependency-free: `CeremonyApp` is a minimal structural type
// (no `express` import) carrying just `locals` + the route methods a rail needs.
import { randomBytes } from "node:crypto";
import type { VerificationStore } from "../types.js";
import { deriveOrigin, type Origin, type RequestLike } from "./origin.js";
import type {
  CeremonyCatalog,
  CeremonyOrder,
  CeremonyOrderStore,
  CompletionSeam,
  SettlementSeam,
} from "./types.js";
import { registerCredentialGate } from "./credential-gate/routes.js";

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
  /** Dev-only: allow an ephemeral per-process signing key. NEVER inferred —
   *  mount() does not guess "serverless". */
  allowEphemeralKey?: boolean;
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
}

/** A rail attaches its routes to the host app given the resolved context. */
export type RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext) => void;

// Per-rail registration scaffold. Each rail (passkey / dc-payment /
// credential-gate) pushes its registrar here once extracted (US1–US3). US1 lands
// the credential gate (age + membership); passkey / dc-payment follow (US2/US3).
// Each registrar no-ops on a route-less app shape, so mount()'s fail-fast tests
// (which pass a `{ locals }`-only app) are unaffected.
const RAILS: RailRegistrar[] = [registerCredentialGate];

/**
 * Read + validate the injected seams, build the CeremonyContext, and register
 * every rail's routes. Throws on a missing required seam (CT2). Seams may arrive
 * via `options` OR `app.locals.attesto` — options win.
 */
export function mountCeremony(app: CeremonyApp, options: Partial<CeremonySeams> = {}): CeremonyContext {
  const locals = (app.locals.attesto ?? {}) as Partial<CeremonySeams> & { store?: VerificationStore };

  const verificationStore = options.verificationStore ?? locals.verificationStore ?? locals.store;
  const orderStore = options.orderStore ?? locals.orderStore;
  const catalog = options.catalog ?? locals.catalog;
  const completion = options.completion ?? locals.completion;
  const settlement = options.settlement ?? locals.settlement;
  const origin = options.origin ?? locals.origin ?? deriveOrigin;
  const allowEphemeralKey = options.allowEphemeralKey ?? locals.allowEphemeralKey ?? false;
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
      `[attesto] mount(): missing required ceremony seam(s): ${missing.join(", ")}. ` +
        `Provide them via attesto.mount(app, { ... }) or app.locals.attesto.`,
    );
  }

  // The challenge HMAC must survive an instance split (options→verify may hit
  // different serverless instances — D6). We do NOT infer "serverless"; an
  // ephemeral per-process key is allowed ONLY when the host opts in explicitly.
  if (!signingKey) {
    if (!allowEphemeralKey) {
      throw new Error(
        `[attesto] mount(): a stable 'signingKey' is required so the challenge HMAC survives an instance split. ` +
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
    ...(settlement ? { settlement } : {}),
  };

  // Re-expose the resolved seams on app.locals so the storefront's gate routes
  // resolve verification THROUGH Attesto (and a re-mount is idempotent).
  app.locals.attesto = { ...(app.locals.attesto as Record<string, unknown> | undefined), store: ctx.verificationStore, ...ctx };

  for (const register of RAILS) register(app, ctx);

  return ctx;
}

/**
 * Shared order resolution + re-pricing (T003a). Resolve a created order by id
 * from the injected store, then RE-PRICE it from the catalog — the displayed and
 * bound amounts come from the catalog, never the id/token (CT3, invariants 2/3).
 * A tampered or unknown id resolves to `null` (the rail refuses).
 */
export async function resolveOrder(ctx: CeremonyContext, orderId: string | undefined | null): Promise<CeremonyOrder | null> {
  if (!orderId) return null;
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
