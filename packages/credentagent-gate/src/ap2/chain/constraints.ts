// Evaluate an open mandate's limits against what the agent actually did — AP2's processing
// rules 2 and 3, as spec 014 restates them:
//
//   2. the closed content keeps every claim the open content fixed, unchanged;
//   3. every constraint is evaluated, and ANY UNKNOWN CONSTRAINT FAILS.
//
// Rule 3 is the one that keeps the vocabulary safe to grow. A newer wallet may sign a limit this
// code has never heard of; skipping it would enforce a permission broader than the one the person
// gave. So an unrecognised `type` is a violation, never a no-op.
//
// The result is a list of violations, empty when the purchase is inside the permission. Nothing
// here re-prices the cart: whether the amounts are TRUE is the catalog's answer (invariant 2).
import { createHash } from "node:crypto";
import { canonical } from "../../ceremony/mandate.js";
import type {
  CheckoutConstraint,
  LineItemRequirement,
  Merchant,
  OpenCheckoutMandate,
  OpenPaymentMandate,
  PaymentConstraint,
  PaymentMandate,
  UcpCheckout,
} from "../types.js";

export interface Violation {
  /** `constraint`: a known limit was exceeded. `preset`: a fixed claim was changed. */
  code: "constraint" | "preset" | "unknown-constraint";
  /** The constraint `type` that refused, when one did. */
  constraint?: string;
  detail: string;
}

/** What has already been spent under this permission — budget and recurrence are stateful. */
export interface Spent {
  /** Minor units, in the budget's currency, across every earlier payment under this mandate. */
  amount: number;
  /** Earlier payments under this mandate. */
  uses: number;
}

/**
 * The digest an Open Payment Mandate's `payment.reference` names: sha-256 over the canonical
 * encoding of the Open Checkout Mandate's content. The intent-sign rail mints it this way, so this
 * is the one definition both sides use.
 */
export function mandateContentDigest(content: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(content)).digest("base64url");
}

const violation = (code: Violation["code"], detail: string, constraint?: string): Violation => ({
  code,
  detail,
  ...(constraint ? { constraint } : {}),
});

/** AP2's merchant match: by `id` when both carry one, else by `name` and `website` together. */
function merchantMatches(candidate: Merchant | undefined, target: Merchant | undefined): boolean {
  if (!candidate || !target) return false;
  if (candidate.id && target.id) return candidate.id === target.id;
  return Boolean(candidate.name && candidate.website) && candidate.name === target.name && candidate.website === target.website;
}

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

// ── checkout ──────────────────────────────────────────────────────────────

/**
 * Can every unit in the cart be assigned to a requirement that accepts it, within that
 * requirement's quantity? A bipartite max-flow, because an item several requirements accept must
 * go wherever capacity remains — first-fit refuses carts the mandate allows. Carts are small, so
 * a plain augmenting-path search is enough.
 */
function lineItemsFit(checkout: UcpCheckout, requirements: LineItemRequirement[]): string | undefined {
  const qty = new Map<string, number>();
  for (const line of checkout.line_items) qty.set(line.item.id, (qty.get(line.item.id) ?? 0) + line.quantity);
  if ([...qty.values()].every((q) => q <= 0)) return "an empty cart does not satisfy a line_items constraint";

  const accepts = (r: LineItemRequirement, sku: string) => r.acceptable_items.length === 0 || r.acceptable_items.some((i) => i.id === sku);
  const unacceptable = [...qty.keys()].filter((sku) => !requirements.some((r) => accepts(r, sku)));
  if (unacceptable.length) return `${unacceptable.join(", ")} not accepted by any requirement`;

  // Units, one at a time: each unit of each sku looks for a requirement with room, re-routing
  // earlier assignments when it has to (Kuhn's augmenting path, on unit capacities).
  const room = requirements.map((r) => r.quantity);
  const holders: string[][] = requirements.map(() => []);
  const place = (sku: string, seen: Set<number>): boolean => {
    for (let j = 0; j < requirements.length; j++) {
      if (seen.has(j) || !accepts(requirements[j], sku)) continue;
      seen.add(j);
      if (room[j] > 0) {
        room[j]--;
        holders[j].push(sku);
        return true;
      }
      for (let k = 0; k < holders[j].length; k++) {
        const moved = holders[j][k];
        if (place(moved, seen)) {
          holders[j][k] = sku;
          return true;
        }
      }
    }
    return false;
  };
  const unplaced: string[] = [];
  for (const [sku, n] of qty) for (let u = 0; u < n; u++) if (!place(sku, new Set())) unplaced.push(sku);
  return unplaced.length ? `no requirement has room for ${unplaced.join(", ")}` : undefined;
}

/** Violations of an Open Checkout Mandate by the checkout the agent signed for. */
export function evaluateCheckout(open: OpenCheckoutMandate, checkout: UcpCheckout): Violation[] {
  const out: Violation[] = [];
  // AP2's schema: an open checkout MUST contain a line_items constraint. Without one it bounds
  // nothing at all, so it is refused rather than read as "anything goes".
  if (!open.constraints.some((c) => c.type === "checkout.line_items")) {
    out.push(violation("constraint", "an open checkout mandate must contain checkout.line_items", "checkout.line_items"));
  }
  for (const c of open.constraints as CheckoutConstraint[]) {
    switch (c.type) {
      case "checkout.allowed_merchants":
        if (!c.allowed.some((m) => merchantMatches(m, checkout.merchant))) {
          out.push(violation("constraint", `merchant ${checkout.merchant?.id ?? "∅"} is not allowed`, c.type));
        }
        break;
      case "checkout.line_items": {
        const problem = lineItemsFit(checkout, c.items);
        if (problem) out.push(violation("constraint", problem, c.type));
        break;
      }
      default:
        out.push(violation("unknown-constraint", "this verifier does not know the constraint, so it cannot pass it", (c as { type: string }).type));
    }
  }
  return out;
}

// ── payment ───────────────────────────────────────────────────────────────

export interface PaymentContext {
  /** The open checkout mandate disclosed beside this payment — what `payment.reference` names. */
  openCheckout: OpenCheckoutMandate;
  /** Usage so far. Required by `payment.budget` and `payment.agent_recurrence`; absent ⇒ refused. */
  spent?: Spent;
}

/** The claims an open payment mandate may fix, which the closed one must then carry unchanged. */
const PRESET_CLAIMS = ["payment_amount", "payment_instrument", "pisp", "execution_date"] as const;

/** Violations of an Open Payment Mandate by the closed payment the agent signed. */
export function evaluatePayment(open: OpenPaymentMandate, closed: PaymentMandate, ctx: PaymentContext): Violation[] {
  const out: Violation[] = [];

  if (open.payee !== undefined && !merchantMatches(open.payee, closed.payee)) {
    out.push(violation("preset", `payee was fixed to ${open.payee.id} and the payment names ${closed.payee?.id ?? "∅"}`));
  }
  for (const claim of PRESET_CLAIMS) {
    if (open[claim] !== undefined && !sameJson(open[claim], closed[claim])) out.push(violation("preset", `${claim} was fixed by the open mandate and changed`));
  }

  if (!open.constraints.some((c) => c.type === "payment.reference")) {
    out.push(violation("constraint", "an open payment mandate must contain payment.reference", "payment.reference"));
  }
  if (open.constraints.some((c) => c.type === "payment.agent_recurrence")) {
    for (const companion of ["payment.amount_range", "payment.budget"] as const) {
      if (!open.constraints.some((c) => c.type === companion)) out.push(violation("constraint", `agent_recurrence requires ${companion}`, "payment.agent_recurrence"));
    }
  }

  const amount = closed.payment_amount;
  for (const c of open.constraints as PaymentConstraint[]) {
    switch (c.type) {
      case "payment.reference":
        if (c.conditional_transaction_id !== mandateContentDigest(ctx.openCheckout as never)) {
          out.push(violation("constraint", "names a different open checkout mandate than the one presented", c.type));
        }
        break;
      case "payment.amount_range":
        if (amount.currency !== c.currency.toUpperCase()) out.push(violation("constraint", `currency ${amount.currency} is not ${c.currency}`, c.type));
        else if (amount.amount > c.max) out.push(violation("constraint", `amount ${amount.amount} exceeds max ${c.max}`, c.type));
        else if (c.min !== undefined && amount.amount < c.min) out.push(violation("constraint", `amount ${amount.amount} is below min ${c.min}`, c.type));
        break;
      case "payment.budget":
        if (amount.currency !== c.currency.toUpperCase()) out.push(violation("constraint", `currency ${amount.currency} is not ${c.currency}`, c.type));
        else if (!ctx.spent) out.push(violation("constraint", "a budget cannot be checked without `spent` — what was already spent under this mandate", c.type));
        else if (ctx.spent.amount + amount.amount > c.max) {
          out.push(violation("constraint", `cumulative ${ctx.spent.amount + amount.amount} exceeds budget ${c.max}`, c.type));
        }
        break;
      case "payment.agent_recurrence":
        if (c.max_occurrences !== undefined) {
          if (!ctx.spent) out.push(violation("constraint", "recurrence cannot be checked without `spent.uses`", c.type));
          else if (ctx.spent.uses >= c.max_occurrences) out.push(violation("constraint", `${ctx.spent.uses} uses already — max_occurrences is ${c.max_occurrences}`, c.type));
        }
        break;
      case "payment.allowed_payees":
        if (!c.allowed.some((m) => merchantMatches(m, closed.payee))) out.push(violation("constraint", `payee ${closed.payee?.id ?? "∅"} is not allowed`, c.type));
        break;
      case "payment.allowed_payment_instruments":
        if (!c.allowed.some((i) => i.id === closed.payment_instrument?.id)) out.push(violation("constraint", `instrument ${closed.payment_instrument?.id ?? "∅"} is not allowed`, c.type));
        break;
      case "payment.allowed_pisps":
        if (!closed.pisp || !c.allowed.some((p) => sameJson(p, closed.pisp))) out.push(violation("constraint", "the payment names no allowed PISP", c.type));
        break;
      case "payment.execution_date": {
        const when = closed.execution_date;
        if (when !== undefined) {
          const t = Date.parse(when);
          if (Number.isNaN(t)) out.push(violation("constraint", `execution_date ${when} is not a date`, c.type));
          else if (c.not_before && t < Date.parse(c.not_before)) out.push(violation("constraint", `${when} is before ${c.not_before}`, c.type));
          else if (c.not_after && t > Date.parse(c.not_after)) out.push(violation("constraint", `${when} is after ${c.not_after}`, c.type));
        }
        break;
      }
      default:
        out.push(violation("unknown-constraint", "this verifier does not know the constraint, so it cannot pass it", (c as { type: string }).type));
    }
  }
  return out;
}
