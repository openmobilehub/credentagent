import styles from "./app.module.css";

// The confirmed order's proofs (the gate's order proof receipt) — one row per gate, e.g.
// "✓ presence-only-demo · Inspect ↗ · Issuer ↗", then "Check the signatures ↗" (the Multipaz
// verifier) when a wallet proof is shown, and "Order record ↗" (the store's order-status JSON).
// Multipaz links show only for a wallet proof the store kept bytes for; an instant-demo proof says
// so and never links. Nothing here claims more than the proof's own trust_level.
const INSPECTOR = "https://tools.multipaz.org/mdocDeviceResponse#";
const X509 = "https://tools.multipaz.org/x509#";
const VERIFIER = "https://tools.multipaz.org/verifier";

export interface WidgetProof {
  gate: string;
  rail: string;
  trust_level: string;
  presentation?: { inspectUrl?: string; issuerCertUrl?: string };
}

type OpenLink = (url: string) => unknown;

function ExternalLink({ href, label, openLink }: { href: string; label: string; openLink?: OpenLink }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        // Sandboxed iframe: plain target="_blank" is blocked by the host. Route through the
        // bridge like the checkout link.
        e.preventDefault();
        if (openLink) void openLink(href);
        else window.open(href, "_blank", "noopener");
      }}
    >
      {label}
    </a>
  );
}

export function ProofRows({ proofs, recordUrl, openLink }: { proofs?: WidgetProof[]; recordUrl?: string; openLink?: OpenLink }) {
  const record = typeof recordUrl === "string" && /^https?:\/\//i.test(recordUrl) ? recordUrl : null;
  if (!proofs?.length && !record) return null;
  let anyWallet = false;
  const rows = (proofs ?? []).map((p) => {
    const url = p.presentation?.inspectUrl;
    const inspectUrl = typeof url === "string" && url.startsWith(INSPECTOR) ? url : null;
    const cert = p.presentation?.issuerCertUrl;
    const certUrl = typeof cert === "string" && cert.startsWith(X509) ? cert : null;
    if (inspectUrl) anyWallet = true;
    return (
      <div className={styles.confirmRow} key={p.gate}>
        <dt>{p.gate}</dt>
        <dd>
          ✓ {p.rail === "instant-demo" ? "instant demo" : p.trust_level}
          {inspectUrl && <>{" · "}<ExternalLink href={inspectUrl} label="Inspect ↗" openLink={openLink} /></>}
          {certUrl && <>{" · "}<ExternalLink href={certUrl} label="Issuer ↗" openLink={openLink} /></>}
        </dd>
      </div>
    );
  });
  return (
    <>
      {rows}
      {anyWallet && (
        <div className={styles.confirmRow}>
          <dt>Signatures</dt>
          <dd><ExternalLink href={VERIFIER} label="Check with Multipaz ↗" openLink={openLink} /></dd>
        </div>
      )}
      {record && (
        <div className={styles.confirmRow}>
          <dt>Order record</dt>
          <dd><ExternalLink href={record} label="order-status JSON ↗" openLink={openLink} /></dd>
        </div>
      )}
    </>
  );
}
