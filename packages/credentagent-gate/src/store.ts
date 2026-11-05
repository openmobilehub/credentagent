// Per-order verification store. Keyed by order id — NEVER process-global, so one
// shopper's verification can never unlock another's checkout (Security invariant 4).
// Default is in-process; swap in Redis (Upstash) for serverless by implementing
// VerificationStore.

import type { SavedRequirement, VerificationRecord, VerificationSlot, VerificationStore } from "./types.js";
import { upsertProof } from "./ceremony/proofs.js";
import { RESERVED_CREDENTIAL_IDS } from "./credentials.js";

/**
 * Merge one saved part into an order's record: the part's fields replace the record's, except
 * that `verifiedGates` and `proofs` add up (a proof replaces one with the same gate label). How
 * a `VerificationStore` that implements `writePart` builds what `read()` returns.
 */
export function mergeVerificationRecord(record: VerificationRecord, part: VerificationRecord): VerificationRecord {
  const merged: VerificationRecord = { ...record, ...part };
  if (record.verifiedGates && part.verifiedGates) merged.verifiedGates = { ...record.verifiedGates, ...part.verifiedGates };
  if (record.proofs && part.proofs) merged.proofs = part.proofs.reduce(upsertProof, record.proofs);
  return merged;
}

/**
 * Every slot an order's parts can be saved in: the three fixed ones, then `gate:<id>` for each
 * custom credential its saved requirements name. A store that can't list its keys reads these.
 */
export function verificationSlots(requirements?: readonly SavedRequirement[]): VerificationSlot[] {
  const custom = (requirements ?? []).map((r) => r.credential).filter((id) => !RESERVED_CREDENTIAL_IDS.has(id));
  return ["requirements", "age", "membership", ...custom.map((id): VerificationSlot => `gate:${id}`)];
}

/**
 * Save one part of an order's record through `writePart`, or by reading, merging and writing the
 * whole record back, as every write did before #444. The merge is for a store without `writePart`,
 * and for a custom credential's part the order's saved requirements don't name (an order opened
 * from a link without a seal has none): `verificationSlots` doesn't list that slot, so a store that
 * finds its parts that way could never read it back. A store only ever gets the slots it can find.
 */
export async function savePart(store: VerificationStore, orderId: string, slot: VerificationSlot, part: VerificationRecord): Promise<void> {
  const listed = !slot.startsWith("gate:") || verificationSlots((await store.read(orderId))?.requirements).includes(slot);
  if (store.writePart && listed) return store.writePart(orderId, slot, part);
  const prev = (await store.read(orderId)) ?? {};
  await store.write(orderId, mergeVerificationRecord(prev, part));
}

export class MemoryVerificationStore implements VerificationStore {
  private readonly records = new Map<string, VerificationRecord>();
  // Each order's parts by slot. One synchronous Map write each, so no two can interleave.
  private readonly parts = new Map<string, Map<VerificationSlot, VerificationRecord>>();

  read(orderId: string): VerificationRecord | undefined {
    const record = this.records.get(orderId);
    const parts = this.parts.get(orderId);
    return parts ? [...parts.values()].reduce(mergeVerificationRecord, record ?? {}) : record;
  }
  write(orderId: string, record: VerificationRecord): void {
    this.records.set(orderId, record);
  }
  writePart(orderId: string, slot: VerificationSlot, part: VerificationRecord): void {
    const parts = this.parts.get(orderId) ?? new Map<VerificationSlot, VerificationRecord>();
    parts.set(slot, part);
    this.parts.set(orderId, parts);
  }
  clear(orderId: string): void {
    this.records.delete(orderId);
    this.parts.delete(orderId);
  }
}
