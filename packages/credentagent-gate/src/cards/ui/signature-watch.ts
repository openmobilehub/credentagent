// The permission card's live status on the page (spec 015 FR-7). It follows each grant's signature
// through the card-only status tool, OUTSIDE React: a host may redraw the card at any time (ChatGPT does,
// on every `openai:set_globals`), and the AP2 demo's card flickered back to "Waiting" and restarted its
// polling when this state lived in the DOM. One follow per grant, however often the card redraws; the
// chat is told only when the server says so.
import { PERMISSION_STATUS_TOOL, type PermissionStatusAnswer } from "../contract";
import type { Bridge } from "./bridge";
import { WAITING, type SignatureState } from "./views/PermissionCard";

export interface SignatureWatch {
  /** Start following a grant's signature — once per grant, however often the card redraws. */
  follow(grantId: string, storeName: string): void;
  state(grantId: string): SignatureState;
  subscribe(listener: () => void): () => void;
}

const isAnswer = (value: unknown): value is PermissionStatusAnswer =>
  value !== null && typeof value === "object" && typeof (value as { status?: unknown }).status === "string";

export function createSignatureWatch(
  bridge: Bridge,
  options: { sleep?: (ms: number) => Promise<void>; retryMs?: number; maxCalls?: number } = {},
): SignatureWatch {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryMs = options.retryMs ?? 3_000;
  const maxCalls = options.maxCalls ?? 60;
  const states = new Map<string, SignatureState>();
  const following = new Set<string>(); // a follow in flight — one per grant
  const finished = new Set<string>(); // a final answer reached — a redraw never starts another
  const listeners = new Set<() => void>();
  const set = (grantId: string, state: SignatureState): void => {
    states.set(grantId, state);
    for (const listener of listeners) listener();
  };

  async function run(grantId: string, storeName: string): Promise<void> {
    for (let call = 0; call < maxCalls; call++) {
      let answer: unknown;
      try {
        answer = await bridge.call(PERMISSION_STATUS_TOOL, { grantId });
      } catch {
        answer = null;
      }
      if (!isAnswer(answer)) {
        if (bridge.host === "preview") return; // no server behind the preview
        await sleep(retryMs);
        continue;
      }
      if (answer.status === "authorized") {
        if (states.get(grantId)?.kind !== "signed") set(grantId, { kind: "signed", ...(answer.trustLevel ? { trustLevel: answer.trustLevel } : {}) });
        if (answer.announce) {
          try {
            await bridge.tell(`I signed the permission for ${storeName} on my phone (${grantId}). Please go ahead with the purchase.`);
          } catch {
            /* a bridge that cannot post must not break the follow — the card's "Signed" is the signal */
          }
        }
        if (answer.final) {
          finished.add(grantId);
          return;
        }
        continue; // signed, but the model may still be waiting for it in its turn — ask again
      }
      if (answer.status !== "pending") {
        set(grantId, { kind: "not-signed", status: answer.status });
        finished.add(grantId);
        return;
      }
    }
  }

  return {
    follow(grantId, storeName) {
      if (following.has(grantId) || finished.has(grantId)) return;
      following.add(grantId);
      void run(grantId, storeName).finally(() => following.delete(grantId));
    },
    state: (grantId) => states.get(grantId) ?? WAITING,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
