// The receipt card (spec 015 FR-9), ported from the AP2 demo: the store's answer to a purchase. Paid —
// the total, the items, and every check the store ran before it accepted the order. Refused — who, why,
// and that nothing was charged. Both end with the honesty line.
import { useState } from "react";
import type { ReceiptCardData } from "../../contract";
import { CardFrame } from "./frame";
import { Icon } from "./icons";
import { openOrSay } from "./PermissionCard";
import styles from "./cards.module.css";

const money = (amount: number, currency: string): string => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

export function ReceiptCard({ data, open }: { data: ReceiptCardData; open: (url: string) => Promise<void> }) {
  const [openFailed, setOpenFailed] = useState(false);
  if (!data.ok) {
    return (
      <CardFrame trustLevel={data.trustLevel}>
        <div className={`${styles.hero} ${styles.heroBad}`}>
          <div className={styles.badge}>
            <Icon name="x" />
          </div>
          <div>
            <h1>{data.store ?? "The store"} refused this purchase</h1>
            <p className={styles.sub}>Nothing was charged.</p>
          </div>
        </div>
        <p>{data.reason}</p>
        {data.code ? <p className={`${styles.mono} ${styles.sub}`}>{data.code}</p> : null}
      </CardFrame>
    );
  }
  const { order, receiptUrl } = data;
  return (
    <CardFrame trustLevel={data.trustLevel}>
      <div className={`${styles.hero} ${styles.heroOk}`}>
        <div className={styles.badge}>
          <Icon name="check" />
        </div>
        <div>
          <h1>
            Paid {money(order.total, order.currency)} at {order.store}
          </h1>
          <p className={styles.sub}>Verified by the store before it accepted the order</p>
        </div>
      </div>
      <div className={styles.lines}>
        {order.items.map((item, i) => (
          <div key={i} className={styles.row}>
            <span>{item}</span>
          </div>
        ))}
        <div className={`${styles.row} ${styles.total}`}>
          <span>Total</span>
          <span>{money(order.total, order.currency)}</span>
        </div>
      </div>
      <div className={styles.lines}>
        <p className={styles.eyebrow}>
          <Icon name="store" />
          What {order.store} checked
        </p>
        <ul className={styles.checks}>
          {order.checks.map((check, i) => (
            <li key={i}>
              <Icon name="check" />
              <span>{check}</span>
            </li>
          ))}
        </ul>
      </div>
      {receiptUrl ? (
        <div>
          <button type="button" className={styles.button} onClick={() => openOrSay(open, receiptUrl, setOpenFailed)}>
            <Icon name="link" />
            Open receipt
          </button>
          {openFailed ? <p className={styles.sub}>Couldn&apos;t open the receipt.</p> : null}
        </div>
      ) : null}
    </CardFrame>
  );
}
