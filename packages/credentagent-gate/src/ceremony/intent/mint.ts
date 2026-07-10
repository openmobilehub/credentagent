// The delegate side of the intent rail (005): compose + seal the bounds into an
// Intent Mandate. v0.1 is server-composed + server-signed (demo), so the returned
// grant is a bearer instrument the agent holds and the delegate key is handed back
// with it — presence "delegated-demo" / trust_level "server-issued-demo". The
// wallet-server increment moves the sealing behind the user's biometric without
// changing this shape. Reuses `generateDelegate` + `sealIntent` (no crypto here).
import { generateDelegate, sealIntent, type IntentBounds } from "../mandate.js";

/** The delegate private key type, without naming the DOM `CryptoKey` global. */
type DelegateKey = Awaited<ReturnType<typeof generateDelegate>>["privateKey"];

export interface MintOptions {
  /** The one merchant this grant may spend at. */
  merchant: string;
  /** Per-purchase absolute cap. */
  perOrder: number;
  /** Cumulative lifetime cap across every draw (no reset in v0.1). */
  total: number;
  currency?: string;
  description?: string;
  /** Informational in v0.1 (audit / kill-switch key; not an enforced identity). */
  subject?: string;
}

/**
 * Mint ONE grant. Returns the sealed `grant` (the content-addressed Intent Mandate)
 * and the `delegateKey` the agent holds to sign draws (v0.1 demo — the wallet holds
 * it in the real model). Deterministic bounds, real ES256 key, demo-fenced labels.
 */
export async function mintGrant(opts: MintOptions): Promise<{ grant: IntentBounds; delegateKey: DelegateKey }> {
  const { privateKey, delegate } = await generateDelegate();
  const grant = await sealIntent({
    type: "credentagent.IntentBounds/v0",
    naturalLanguageDescription: opts.description,
    merchants: [opts.merchant],
    currency: opts.currency ?? "USD",
    maxAmount: opts.perOrder,
    totalAmount: opts.total,
    subject: opts.subject,
    delegate,
    presence: "delegated-demo",
    trust_level: "server-issued-demo",
  });
  return { grant, delegateKey: privateKey };
}
