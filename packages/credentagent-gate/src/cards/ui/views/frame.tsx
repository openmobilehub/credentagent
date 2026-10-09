// The honesty frame (spec 015 FR-6): every card about a permission or a payment renders inside it, and
// its last line says what the card can prove — built from the data's trust level, never omitted.
import type { ReactNode } from "react";
import styles from "./cards.module.css";

export function honestyText(trustLevel: string): string {
  return trustLevel === "presence-only-demo"
    ? "Demo: the signatures are real, but the payment credential is not issuer-verified yet (presence-only-demo). No real money moves."
    : `Trust level: ${trustLevel}.`;
}

export function HonestyLine({ trustLevel }: { trustLevel: string }) {
  return (
    <p className={styles.honesty} data-trust-level={trustLevel}>
      {honestyText(trustLevel)}
    </p>
  );
}

export function CardFrame({ eyebrow, trustLevel, children }: { eyebrow?: ReactNode; trustLevel: string; children: ReactNode }) {
  return (
    <section className={styles.card}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      {children}
      <HonestyLine trustLevel={trustLevel} />
    </section>
  );
}
