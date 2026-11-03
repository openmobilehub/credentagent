// An order's requirements, saved in its verification record (#444), so a step on any server can
// read what the order needs instead of guessing from item tags or this process's memory.
//
// `requirements()` works them out in the tool context and stays synchronous, but a write to a
// shared store is not. So it SEALS them into every approve link it emits (HMAC under the mounted
// signing key, bound to the order id), and the first page that opens a link saves them, once. A
// forged or altered seal, one for another order, or one under another server's key saves nothing.
// The amounts are not in it: they are still re-derived from the catalog (invariant 2).
//
// Nothing reads them yet: completion (#445) and the pages (#446) move onto them next.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CeremonyContext } from "./mount.js";
import type { GateOrder, SavedRequirement, VerificationManifestEntry } from "../types.js";
import { savePart } from "../store.js";

/** The approve-link query parameter that carries the seal. */
export const REQUIREMENTS_PARAM = "requirements";

const positive = (n: unknown): number => (typeof n === "number" && n > 0 ? n : 0);

/**
 * The requirements to save for an order, from its resolved manifest entries. Age is ONE entry:
 * the stricter of the policy's `age.over(n)` and the order's highest `minimumAge` tag, so a
 * policy can't lower an item's legal age, and a tagged item with no age in the policy is still
 * recorded as needing one (completion enforces the tag today).
 */
export function savedRequirementsFor(order: GateOrder, entries: readonly VerificationManifestEntry[]): SavedRequirement[] {
  const tagAge = Math.max(0, ...order.lines.map((l) => positive(l.minimumAge)));
  const ages = entries.filter((e) => e.credential === "age");
  const saved: SavedRequirement[] = [];
  if (ages.length > 0 || tagAge > 0) {
    const minAge = Math.max(tagAge, ...ages.map((e) => positive(e.minAge)));
    saved.push({ credential: "age", required: tagAge > 0 || ages.some((e) => e.required), effect: "gate", minAge });
  }
  for (const e of entries) {
    if (e.credential === "age") continue;
    saved.push({ credential: e.credential, required: e.required, effect: e.effect, ...(e.discountPct != null ? { discountPct: e.discountPct } : {}) });
  }
  return saved;
}

// Domain-separated from the gate's other HMACs under the same key (challenge, cart mandate,
// reference token): none of their inputs can contain "|" followed by this label.
const sign = (key: string, orderId: string, payload: string): string =>
  createHmac("sha256", key).update(`credentagent.requirements.v1|${orderId}|${payload}`).digest("base64url");

/** Seal an order's requirements for its approve links: `<base64url JSON>.<HMAC>`, bound to the order id. */
export function sealRequirements(orderId: string, requirements: readonly SavedRequirement[], key: string): string {
  const payload = Buffer.from(JSON.stringify(requirements)).toString("base64url");
  return `${payload}.${sign(key, orderId, payload)}`;
}

/** Open a seal for THIS order, or `null` when it is malformed, altered, sealed for another order,
 *  or sealed under another key. */
export function openRequirements(seal: string, orderId: string, key: string): SavedRequirement[] | null {
  const parts = seal.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(key, orderId, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const list: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Array.isArray(list) ? (list as SavedRequirement[]) : null;
  } catch {
    return null;
  }
}

/**
 * Save the requirements sealed on an approve link, once: a record that already holds
 * requirements keeps them (a changed cart is a new order, #443). Every page an approve link
 * opens calls this before it renders. A missing or bad seal saves nothing and the page opens.
 */
export async function saveSealedRequirements(ctx: CeremonyContext, orderId: string, seal: unknown): Promise<void> {
  if (typeof seal !== "string") return;
  const requirements = openRequirements(seal, orderId, ctx.signingKey);
  if (!requirements) return;
  if ((await ctx.verificationStore.read(orderId))?.requirements) return;
  await savePart(ctx.verificationStore, orderId, "requirements", { requirements });
}
