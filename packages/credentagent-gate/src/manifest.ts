// requirements() — the code→data boundary (Principle VI).
//
// Runs each Step's `appliesTo` predicate server-side (Context 1), drops the
// gates that don't apply, orders them (payment / authorize settles LAST), and
// emits a flat, JSON-safe manifest: NO functions, NO closures. This is the only
// place policy code becomes wire data — `structuredContent.requires` is exactly
// what the agent and the widget receive.

import type {
  Credential,
  Effect,
  GateOrder,
  Step,
  TrustLevel,
  VerificationManifestEntry,
} from "./types.js";

export interface ResolveContext {
  /** Origin the per-order approve link binds to. */
  walletOrigin: string;
  /** mdoc trust honestly stated in every entry; v0.1 is presence-only. */
  trustLevel?: TrustLevel;
  /**
   * Where the gates are enforced. v0.1 is consolidated Mode A: every gate runs
   * on the checkout page (Context 2), so entries are `"checkout"`. (`"tool"` is
   * the Mode-B / blocking shape — roadmap.)
   */
  enforcedAt?: "tool" | "checkout";
  /**
   * Set once `credentagent.mount()` has wired the ceremony rails onto the host app, so
   * the approve links resolve to THIS server's mounted `/credentagent/*` routes instead
   * of the legacy `/credential-gate/*` shape. age/membership share the credential
   * page (`?cred=…`); payment authorizes on the dc-payment page.
   */
  mountedRoutes?: boolean;
  /**
   * Set when a `verifier` seam was wired at mount() (008). The blocking gate/authorize
   * credentials are then proven in ONE external-verifier ceremony, so their approve links
   * all resolve to the single `/credentagent/delegated?order=…` page rather than the
   * per-credential dc-payment / credential rails. A discount stays on the credential rail.
   */
  delegated?: boolean;
}

/** Per-order approve link, e.g. `https://shop.example/credential-gate/age?order=ORD-1`. */
function approveUrlFor(walletOrigin: string, credentialId: string, orderId: string): string {
  const origin = walletOrigin.replace(/\/$/, "");
  return `${origin}/credential-gate/${credentialId}?order=${encodeURIComponent(orderId)}`;
}

/**
 * Per-order approve link onto the MOUNTED ceremony routes (`credentagent.mount()`):
 *   payment/authorize → `…/credentagent/dc-payment?order=…`  (passkey is the alt rail)
 *   age / membership / other gate → `…/credentagent/credential?order=…&cred=<id>`
 * Same origin the checkout link uses, so the host can re-home it onto its own base.
 */
function mountedApproveUrlFor(walletOrigin: string, credentialId: string, effect: Effect["kind"], orderId: string, delegated: boolean): string {
  const origin = walletOrigin.replace(/\/$/, "");
  const order = encodeURIComponent(orderId);
  // Delegated (008): only the PAYMENT (authorize) credential is proven through the external
  // verifier's delegated ceremony (DPC + settlement). Identity gates (age) stay on the built-in
  // credential rail — a REAL OpenID4VP mdoc presentation the wallet answers first — so the flow
  // is TWO-STEP (verify age, THEN pay), matching the reference marketplace: the wallet opens for
  // the mDL on the age step, then for the DPC on the payment step. A discount stays on the
  // credential rail too (opt-in).
  if (delegated && effect === "authorize") {
    return `${origin}/credentagent/delegated?order=${order}`;
  }
  if (effect === "authorize" || credentialId === "payment") {
    return `${origin}/credentagent/dc-payment?order=${order}`;
  }
  return `${origin}/credentagent/credential?order=${order}&cred=${encodeURIComponent(credentialId)}`;
}

/** The strictest `age.over(n)` among these credentials that applies to the order; 0 when none. */
function strictestAge(order: GateOrder, credentials: Iterable<Credential>): number {
  let min = 0;
  for (const c of credentials) {
    if (c.id !== "age" || typeof c.params?.minAge !== "number") continue;
    if (c.appliesTo && !c.appliesTo(order)) continue;
    min = Math.max(min, c.params.minAge);
  }
  return min;
}

/**
 * The age an order's own policy requires: the strictest `age.over(n)` step that applies to it
 * (its `appliesTo` / `.when()` run server-side, exactly as for the manifest below), or `0` when
 * the policy asks for no age. Like any gate, it blocks whether the step is `required` or not.
 * This is what `CompletionInput.policyMinAge` carries (#354).
 */
export function policyMinAge(order: GateOrder, policy: readonly Step[]): number {
  return strictestAge(order, policy.map((step) => step.credential));
}

/**
 * The age the REGISTERED `age` credential requires of this order, or `0` when none applies —
 * what decides when the order's own policy age is unknown (the server forgot the order, it
 * restarted, or another instance resolved it). It mirrors the custom-gate sweep: scoped to the
 * order's policy when its credential ids are known, the whole registry otherwise. The registry
 * holds ONE `age` (the last resolved), so this is the order's own age only on a server with a
 * single age rule; with several it can be lower, or 0 (#411).
 */
export function registeredMinAge(
  order: GateOrder,
  registry: ReadonlyMap<string, Credential> | undefined,
  policyCredentialIds?: readonly string[],
): number {
  const cred = registry?.get("age");
  if (!cred || (policyCredentialIds && !policyCredentialIds.includes("age"))) return 0;
  return strictestAge(order, [cred]);
}

/**
 * Resolve a policy against an order into the serializable manifest.
 *
 * Ordering: declared order is preserved EXCEPT that `authorize`-effect entries
 * (payment) are moved to the end — payment always settles last, even when a
 * developer declares it earlier in the policy (Principle IV / contract CT3).
 */
export function resolveRequirements(
  order: GateOrder,
  policy: Step[],
  ctx: ResolveContext,
): VerificationManifestEntry[] {
  const trust_level: TrustLevel = ctx.trustLevel ?? "presence-only-demo";
  const enforcedAt = ctx.enforcedAt ?? "checkout";

  const entries = policy
    // Drop gates whose inclusion predicate (defineCredential appliesTo + any
    // composed .when()) is present and returns false.
    .filter((step) => {
      const applies = step.credential.appliesTo;
      return applies ? applies(order) : true;
    })
    .map((step): VerificationManifestEntry => {
      const c = step.credential;
      const effect = c.effect.kind;
      const entry: VerificationManifestEntry = {
        credential: c.id,
        required: step.required,
        effect,
        enforcedAt,
        trust_level,
        label: c.ui.label,
      };
      if (c.params?.minAge != null) entry.minAge = c.params.minAge;
      if (effect === "discount" && c.params?.percent != null) entry.discountPct = c.params.percent;
      if (ctx.mountedRoutes) {
        // Ceremony is mounted: every entry that maps to a `/credentagent/*` route gets a
        // per-order approve link — including the membership discount, which is
        // proven on the same credential page (so the buyer can opt into the discount).
        entry.approveUrl = mountedApproveUrlFor(ctx.walletOrigin, c.id, effect, order.id, ctx.delegated ?? false);
      } else if (effect === "gate" || effect === "authorize") {
        // Legacy `/credential-gate/*` shape — a gate/authorize is proven via a
        // per-order ceremony link; a discount is merely presented, no approve link.
        entry.approveUrl = approveUrlFor(ctx.walletOrigin, c.id, order.id);
      }
      return entry;
    });

  // Stable payment-last: non-authorize entries keep their order, then authorize.
  const settleLast = entries.filter((e) => e.effect === "authorize");
  const rest = entries.filter((e) => e.effect !== "authorize");
  return [...rest, ...settleLast];
}
