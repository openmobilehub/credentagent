// The permission card (spec 015 FR-7), ported from the AP2 demo: sign on your phone to let the agent buy
// at ONE store, within these limits. It only shows — the store enforces the limits, and the live status
// comes from the server.
import { useState } from "react";
import type { PermissionCardData } from "../../contract";
import { CardFrame } from "./frame";
import { Icon } from "./icons";
import { shortName, usd } from "./format";
import styles from "./cards.module.css";

export type SignatureState = { kind: "waiting" } | { kind: "signed"; trustLevel?: string } | { kind: "not-signed"; status: string };
export const WAITING: SignatureState = { kind: "waiting" };

export interface PermissionCardProps {
  data: PermissionCardData;
  /** The QR code of the signing link, from the result's `_meta` — shown only if it is an image data URL. */
  qr: unknown;
  state: SignatureState;
  open: (url: string) => Promise<void>;
}

export function PermissionCard({ data, qr, state, open }: PermissionCardProps) {
  const [openFailed, setOpenFailed] = useState(false);
  const { store, limits } = data;
  const qrSrc = typeof qr === "string" && qr.startsWith("data:image/") ? qr : null;
  const openLink = (): void => {
    setOpenFailed(false);
    open(data.approveUrl).catch(() => setOpenFailed(true));
  };
  return (
    <CardFrame
      eyebrow={
        <>
          <Icon name="phone" className={styles.icon} />
          Permission request
        </>
      }
      trustLevel={data.trustLevel}
    >
      <div className={styles.split}>
        <div className={styles.stack}>
          <h1>Sign on your phone to let the agent buy at {store.name}</h1>
          {data.why ? (
            <p className={styles.why}>
              Why {store.name}: {data.why}
            </p>
          ) : null}
          <dl className={styles.facts}>
            <dt>Store</dt>
            <dd>
              {store.name}
              {store.merchantId ? <div className={`${styles.mono} ${styles.sub}`}>{store.merchantId}</div> : null}
            </dd>
            <dt>Products</dt>
            <dd>{data.products.map(shortName).join(", ")}</dd>
            <dt>Per purchase</dt>
            <dd>up to {usd(limits.perPurchase)}</dd>
            <dt>In total</dt>
            <dd>up to {usd(limits.total)}</dd>
          </dl>
          <div>
            <StatusPill state={state} />
          </div>
        </div>
        <div className={`${styles.qr} ${state.kind === "signed" ? styles.signed : ""}`}>
          {qrSrc ? <img src={qrSrc} alt={`QR code for the signing link at ${store.name}`} /> : null}
          <span>Scan with your phone&apos;s camera</span>
          <button type="button" className={styles.button} onClick={openLink}>
            <Icon name="link" className={styles.icon} />
            Open link
          </button>
          {openFailed ? <span>Couldn&apos;t open the link — scan the code instead.</span> : null}
        </div>
      </div>
      <p className={styles.sub}>
        Only this store, only these products, only up to these amounts. The agent spends it with its own key, which the store never sees.
      </p>
    </CardFrame>
  );
}

function StatusPill({ state }: { state: SignatureState }) {
  if (state.kind === "signed") {
    return (
      <span role="status" className={`${styles.pill} ${styles.ok}`}>
        <Icon name="check" className={styles.icon} />
        Signed on your phone{state.trustLevel ? ` · ${state.trustLevel}` : ""}
      </span>
    );
  }
  if (state.kind === "not-signed") {
    return (
      <span role="status" className={`${styles.pill} ${styles.bad}`}>
        <Icon name="x" className={styles.icon} />
        Not signed · {state.status}
      </span>
    );
  }
  return (
    <span role="status" className={`${styles.pill} ${styles.warn}`}>
      <span className={styles.dot} />
      Waiting for your signature
    </span>
  );
}
