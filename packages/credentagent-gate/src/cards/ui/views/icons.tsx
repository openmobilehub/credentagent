// The cards' line icons (from the AP2 demo's sprite), inline so the page stays one self-contained file.
import type { ReactNode } from "react";
import styles from "./cards.module.css";

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  scale: <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />,
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  link: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  store: <path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6" />,
};

export type IconName = "scale" | "phone" | "check" | "x" | "link" | "store";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `${styles.icon} ${className}` : styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
