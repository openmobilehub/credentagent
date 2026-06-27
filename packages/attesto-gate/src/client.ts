// The configure-once client (Principle I): construct with your wallet origin,
// then declarative calls. `requirements(order, policy)` resolves a policy to the
// serializable manifest (Context 1); `mount(app)` is the Context-2 seam.

import type { AttestoOptions, GateOrder, Step, VerificationManifestEntry, VerificationStore } from "./types.js";
import { resolveRequirements } from "./manifest.js";
import { MemoryVerificationStore } from "./store.js";
import { mountCeremony, type CeremonyApp, type CeremonySeams } from "./ceremony/mount.js";

/** The ceremony seams the host supplies to `mount()`; the per-order
 *  verification store is Attesto's own, so the host never passes it here. */
export type MountCeremony = Omit<Partial<CeremonySeams>, "verificationStore">;

/**
 * Minimal structural type for an Express app — the package stays dependency-free
 * (no `express` import). `mount()` only needs `app.locals` for the store seam.
 */
export interface ExpressApp {
  locals: Record<string, unknown>;
}

/** Zero-config default so `new Attesto()` works for local dev. */
const DEFAULT_WALLET_ORIGIN = `http://localhost:${process.env.PORT ?? 3000}`;

export class Attesto {
  readonly walletOrigin: string;
  readonly store: VerificationStore;

  constructor(opts: AttestoOptions = {}) {
    let origin = opts.walletOrigin?.trim();
    if (!origin) {
      // Zero-config: default to localhost so the getting-started example just runs.
      origin = DEFAULT_WALLET_ORIGIN;
    } else if (!/^https?:\/\//.test(origin)) {
      // Wallet ceremonies are origin-bound, so a scheme-less value can't work.
      // Warn and fall back rather than hard-failing (DX over a thrown error).
      console.warn(
        `[attesto] walletOrigin "${origin}" is not an absolute http(s) origin; using ${DEFAULT_WALLET_ORIGIN}. ` +
          `Pass an absolute origin (e.g. https://shop.example) for any deployed environment.`,
      );
      origin = DEFAULT_WALLET_ORIGIN;
    }
    // OpenID4VP / WebAuthn are origin-bound, so a localhost origin in production
    // mints approve links a buyer's phone can't reach. Warn loudly — not fatal.
    if (process.env.NODE_ENV === "production" && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      console.warn(
        `[attesto] walletOrigin is ${origin} in production — buyers can't open localhost approve links. ` +
          `Set { walletOrigin } to your public origin.`,
      );
    }
    this.walletOrigin = origin.replace(/\/$/, "");
    this.store = opts.store ?? new MemoryVerificationStore();
  }

  /**
   * Context 1 — resolve a policy against a server-priced order into the flat,
   * JSON-safe `requires` manifest. Runs `.when()`/`appliesTo` predicates,
   * payment-last; no functions cross the wire.
   */
  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[] {
    return resolveRequirements(order, policy, { walletOrigin: this.walletOrigin });
  }

  /**
   * Context 2 — wire the verification ceremony onto your Express app.
   *
   * Pass the ceremony seams (`{ orderStore, catalog, completion, signingKey, … }`)
   * to register the gate's routes through `mountCeremony`: it validates the seams,
   * FAILS FAST on a missing required one (CT2), and attaches each rail. Attesto's
   * own per-order store is injected as the `verificationStore` (keyed by order id,
   * never process-global — Security invariant 4), so the host never passes it.
   *
   * Called WITHOUT seams it keeps the v0.1 behavior: expose the per-order store
   * via `app.locals.attesto` so a host's existing fail-closed `/credential-gate/*`
   * routes resolve verification state THROUGH Attesto. The rails register only
   * when seams are supplied; with none extracted yet, that path attaches no routes.
   */
  mount(app: ExpressApp, ceremony?: MountCeremony): void {
    if (ceremony) {
      mountCeremony(app as CeremonyApp, { ...ceremony, verificationStore: this.store });
      return;
    }
    const existing = app.locals.attesto as { store?: VerificationStore } | undefined;
    if (existing?.store === this.store) return; // idempotent
    app.locals.attesto = { store: this.store, walletOrigin: this.walletOrigin };
  }
}
