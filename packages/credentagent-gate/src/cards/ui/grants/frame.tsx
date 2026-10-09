// The frame (spec 011 FR-4) — the chrome every view composes into: header (kicker/wordmark +
// status pill), the view body, the named slots, and the TRUST LINE, always last and non-omittable.
// The public render path (GrantCard / GrantList) always wraps a body in <Frame>, so there is no
// way to render a view without the trust line — mirroring trustFooter()'s non-overridable rule.
//
// Chrome is decided from the server-derived lifecycle, not per-view knobs: pending is the consent
// moment (louder — wordmark header + lifted showcase shadow, design Q3); terminal states are
// closed objects (desaturated). A custom view renders its own title inside its body; it does not
// reach into the frame (FR-6 — the token theme is the only other customization).

import type { MouseEvent, ReactNode } from "react";
import type { GrantSlots, GrantViewData, DefineGrantViewInput, GrantView } from "./types";
import { useGrantActions } from "./actions";
import { STATUS_PILL, fullTrustSentence, isTerminal } from "./shared";
import styles from "./grants.module.css";

/** The ONLY door for adding a view (FR-3). Returns a {@link GrantView}; the frame is applied by
 *  the gallery, never by the caller — so a body can never render without the trust line. */
export function defineGrantView(input: DefineGrantViewInput): GrantView {
  return { id: input.id, fits: input.fits, body: input.body, ...(input.row ? { row: true } : {}) };
}

/** The status pill (icon + word, never color alone), keyed on the display lifecycle. */
export function StatusPill({ lifecycle }: { lifecycle: GrantViewData["lifecycle"] }) {
  const { tone, icon, label } = STATUS_PILL[lifecycle];
  const toneClass = tone === "accent" ? styles.pillAccent : tone === "warn" ? styles.pillWarn : styles.pillMuted;
  return (
    <span className={`${styles.pill} ${toneClass}`}>
      {lifecycle === "active" ? <span className={styles.pillDot} aria-hidden="true" /> : <span aria-hidden="true">{icon}</span>}
      {label}
    </span>
  );
}

/** The immovable trust line (FR-4). Presence/trustLevel ride as data-attributes so BOTH literal
 *  tokens are in the DOM (the honesty bypass test checks them), while the visible copy is the
 *  honest sentence built from presence. */
export function TrustLine({ grant }: { grant: GrantViewData }) {
  return (
    <div className={styles.trust} data-presence={grant.presence} data-trust-level={grant.trustLevel}>
      <div className={styles.trustLine}>{fullTrustSentence(grant)}</div>
    </div>
  );
}

/** The card's affordances — FRAME-OWNED (spec A1 / design §9.1), never reachable from a view body.
 *  A body receives only the inert `{ grant, tokens, slots }`; the actions (a ceremony deep-link, a
 *  revoke tool call — never a `spend`, never a live grant handle) live here, keyed on the
 *  server-derived lifecycle. `active`/`low` get the agency line + a quiet Revoke; `pending` gets
 *  equal-weight Approve/Decline that both open the approval page (consent happens there, FR-5);
 *  terminal states get nothing (closed objects, no live affordances, design §4.6). */
function ActionFooter({ grant }: { grant: GrantViewData }) {
  const actions = useGrantActions();
  if (grant.lifecycle === "pending") {
    // Both buttons open the CredentAgent approval page — consent happens there, never in the widget.
    // Equal weight, Approve first by reading order (anti-dark-pattern, design §4.4).
    const open = (e: MouseEvent) => {
      if (actions.openLink) {
        e.preventDefault();
        void actions.openLink(grant.approveUrl);
      }
    };
    return (
      <>
        <div className={styles.btnRow}>
          <a className={`${styles.btn} ${styles.btnApprove}`} href={grant.approveUrl} onClick={open}>Approve</a>
          <a className={`${styles.btn} ${styles.btnDecline}`} href={grant.approveUrl} onClick={open}>Decline</a>
        </div>
        <div className={styles.deeplink}>Opens the CredentAgent approval page ↗</div>
      </>
    );
  }
  if (grant.lifecycle === "active" || grant.lifecycle === "low") {
    return (
      <div className={styles.agency}>
        <span>Spends at {grant.merchant} while you&apos;re away</span>
        <button type="button" className={styles.revoke} onClick={() => actions.revoke?.(grant.id)}>Revoke</button>
      </div>
    );
  }
  return null; // terminal (exhausted / revoked / denied): no live affordances (FR-5)
}

/** Wrap a view body in the frame. `row` renders the compact single-grant form (still framed with
 *  the full trust line, so FR-4 holds per-view). */
export function Frame({
  grant,
  slots,
  row = false,
  children,
}: {
  grant: GrantViewData;
  slots?: GrantSlots;
  row?: boolean;
  children: ReactNode;
}) {
  const pending = grant.lifecycle === "pending";
  const terminal = isTerminal(grant.lifecycle);
  const cardClass = [
    styles.gcard,
    pending ? styles.showcase : "",
    terminal ? styles.terminal : "",
    row ? styles.rowFrame : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cardClass}>
      <div className={styles.head}>
        <span className={pending ? styles.wordmark : styles.kicker}>{pending ? "CREDENTAGENT" : "SPENDING GRANT"}</span>
        <StatusPill lifecycle={grant.lifecycle} />
      </div>
      {slots?.topSlot}
      {children}
      {!row && <ActionFooter grant={grant} />}
      {slots?.bottomSlot}
      <TrustLine grant={grant} />
    </div>
  );
}
