// The permission card's live status, on the server (spec 015 FR-7). The kit remembers each permission
// it issued and owns BOTH waits on its signature: the model's (`waitForSignature`, the main path — the
// model waits in its own turn) and the card's (the card-only status tool). Owning both is what lets
// it decide, in one place, when the card may tell the chat "signed": once per grant, and never while
// the model is still waiting in its turn — a second "go ahead" could make the model buy twice.
//
// State is in memory, per process, keyed by grant id (invariant 4). A multi-instance deploy would
// need a shared store here — an additive option for later.

import type { PermissionInput, PermissionStatusAnswer } from "./contract.js";

/** What `readPermission` answers. Anything else it returns (the signed intent, say) passes through `waitForSignature`. */
export interface PermissionStatus {
  /** "pending" until the person signs; then "authorized" — or "denied", "revoked", … */
  status: string;
  trustLevel?: string;
}

/** How the server reads a permission's live status, given the permission the kit issued. */
export type ReadPermission<R extends PermissionStatus = PermissionStatus> = (permission: PermissionInput) => Promise<R>;

/** `waitForSignature` for a grant this process never issued, or forgot an hour after its last use. */
export interface UnknownPermission {
  status: "unknown";
}

export interface PermissionWatch<R extends PermissionStatus> {
  /** Remember a permission the kit just showed: the model has its QR code and is about to wait. */
  issued(permission: PermissionInput): void;
  /** The model's wait, in its own turn: re-reads until signed, refused, or `holdMs` passes. */
  waitForSignature(grantId: string): Promise<R | UnknownPermission>;
  /** The card's wait: what the card-only status tool answers. */
  cardStatus(grantId: string): Promise<PermissionStatusAnswer>;
}

/** How long one card-only status call holds. */
const CARD_HOLD_MS = 25_000;
/** How often both waits re-read the status, and how often the card re-checks the model during its grace. */
const POLL_MS = 1_500;
const GRACE_POLL_MS = 500;
/** A permission is forgotten an hour after it was last used. */
const FORGET_AFTER_MS = 3_600_000;

interface Entry {
  permission: PermissionInput;
  /** The model knows it was signed: its wait answered "authorized", or the card told the chat. */
  told: boolean;
  /** `waitForSignature` calls in flight. */
  openWaits: number;
  /** When the model last heard "pending" (or got the card) — it calls again within the grace window. */
  lastHeard: number;
  lastUsed: number;
}

export function createPermissionWatch<R extends PermissionStatus>(options: {
  read: ReadPermission<R>;
  holdMs: number;
  modelGraceMs: number;
  /** Seams for the tests' virtual clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): PermissionWatch<R> {
  const { read, holdMs, modelGraceMs } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const entries = new Map<string, Entry>();

  const modelIsWaiting = (entry: Entry): boolean => entry.openWaits > 0 || now() - entry.lastHeard < modelGraceMs;

  /** Re-read until the status is no longer "pending" or `ms` passes. */
  async function hold(entry: Entry, ms: number): Promise<R> {
    const until = now() + ms;
    for (;;) {
      const answer = await read(entry.permission);
      if (answer.status !== "pending" || now() >= until) return answer;
      await sleep(POLL_MS);
    }
  }

  return {
    issued(permission) {
      for (const [grantId, entry] of entries) if (now() - entry.lastUsed > FORGET_AFTER_MS) entries.delete(grantId);
      entries.set(permission.grantId, { permission, told: false, openWaits: 0, lastHeard: now(), lastUsed: now() });
    },

    async waitForSignature(grantId) {
      const entry = entries.get(grantId);
      if (!entry) return { status: "unknown" };
      entry.openWaits += 1;
      try {
        const answer = await hold(entry, holdMs);
        if (answer.status === "authorized") entry.told = true;
        return answer;
      } finally {
        entry.openWaits -= 1;
        entry.lastHeard = now();
        entry.lastUsed = now();
      }
    },

    async cardStatus(grantId) {
      const entry = entries.get(grantId);
      if (!entry) return { status: "unknown", announce: false, final: true };
      entry.lastUsed = now();
      let answer: R;
      try {
        answer = await hold(entry, CARD_HOLD_MS);
      } catch {
        return { status: "pending", announce: false, final: false }; // a failed read: the card asks again
      }
      const status = { status: answer.status, ...(answer.trustLevel ? { trustLevel: answer.trustLevel } : {}) };
      if (answer.status !== "authorized") return { ...status, announce: false, final: answer.status !== "pending" };
      // Signed. While the model is waiting in its turn it will see the signature itself: stay quiet.
      const until = now() + modelGraceMs;
      while (!entry.told && modelIsWaiting(entry) && now() < until) await sleep(GRACE_POLL_MS);
      if (entry.told) return { ...status, announce: false, final: true };
      if (modelIsWaiting(entry)) return { ...status, announce: false, final: false }; // the card asks again
      entry.told = true; // the model ended its turn: the card tells the chat, exactly once
      return { ...status, announce: true, final: true };
    },
  };
}
