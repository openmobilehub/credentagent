import styles from "./app.module.css";

// The confirmed order's proofs (the gate's order proof receipt) — one row per gate, e.g.
// "✓ presence-only-demo · Inspect ↗". The link opens the wallet's credential in Multipaz Tools
// (decoded in the browser) and shows only for a wallet proof the store kept bytes for; an
// instant-demo proof says so and never links. Nothing here claims more than the proof's own
// trust_level.
const INSPECTOR = "https://tools.multipaz.org/mdocDeviceResponse#";

export interface WidgetProof {
  gate: string;
  rail: string;
  trust_level: string;
  presentation?: { inspectUrl?: string };
}

export function ProofRows({ proofs, openLink }: { proofs?: WidgetProof[]; openLink?: (url: string) => unknown }) {
  if (!proofs?.length) return null;
  return (
    <>
      {proofs.map((p) => {
        const url = p.presentation?.inspectUrl;
        const inspectUrl = typeof url === "string" && url.startsWith(INSPECTOR) ? url : null;
        return (
          <div className={styles.confirmRow} key={p.gate}>
            <dt>{p.gate}</dt>
            <dd>
              ✓ {p.rail === "instant-demo" ? "instant demo" : p.trust_level}
              {inspectUrl && (
                <>
                  {" · "}
                  <a
                    href={inspectUrl}
                    onClick={(e) => {
                      // Sandboxed iframe: plain target="_blank" is blocked by the host. Route
                      // through the bridge like the checkout link.
                      e.preventDefault();
                      if (openLink) void openLink(inspectUrl);
                      else window.open(inspectUrl, "_blank", "noopener");
                    }}
                  >
                    Inspect ↗
                  </a>
                </>
              )}
            </dd>
          </div>
        );
      })}
    </>
  );
}
