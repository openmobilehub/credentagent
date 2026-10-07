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
import { canonical } from "../../ceremony/mandate.js";
import { mandateContentDigest } from "../digest.js";
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
  /** `constraint`: a known limit was exceeded. `preset`: a fixed claim was changed. `malformed`: a
   *  limit is missing a field it needs, so it cannot be evaluated — refused, never thrown. */
  code: "constraint" | "preset" | "unknown-constraint" | "malformed";
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

const violation = (code: Violation["code"], detail: string, constraint?: string): Violation => ({
  code,
  detail,
  ...(constraint ? { constraint } : {}),
});

/** AP2's merchant match: by `id` when both carry one, else by `name` and `website` together. */
export function merchantMatches(candidate: Merchant | undefined, target: Merchant | undefined): boolean {
  if (!candidate || !target) return false;
  if (candidate.id && target.id) return candidate.id === target.id;
  return Boolean(candidate.name && candidate.website) && candidate.name === target.name && candidate.website === target.website;
}

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

// ── shape ────────────────────────────────────────────────────────────────
//
// A signed limit is still untrusted input: the wallet signed whatever bytes it was given. Each
// known type names the fields it needs, and a limit missing one is refused as `malformed` rather
// than read — a `TypeError` halfway through would still fail closed, but as an exception, not as
// the `{ ok: false }` every caller of this module handles.

const isInt = (v: unknown): boolean => Number.isSafeInteger(v);
const isStr = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const isList = (v: unknown): boolean => Array.isArray(v);
const optional = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v);
const isObj = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
/** A list whose every element is an object — `[null]` is a list, and reading `null.id` throws. */
const objects = (v: unknown, each: (o: Record<string, unknown>) => boolean = () => true): boolean =>
  isList(v) && (v as unknown[]).every((o) => isObj(o) && each(o as Record<string, unknown>));
const withId = (o: Record<string, unknown>): boolean => isStr(o.id);

const SHAPES: Record<string, (c: Record<string, unknown>) => boolean> = {
  "checkout.allowed_merchants": (c) => objects(c.allowed),
  "checkout.line_items": (c) => objects(c.items, (r) => objects(r.acceptable_items, withId) && isInt(r.quantity) && (r.quantity as number) >= 0),
  "payment.reference": (c) => isStr(c.conditional_transaction_id),
  "payment.amount_range": (c) => isStr(c.currency) && isInt(c.max) && optional(c.min, isInt),
  "payment.budget": (c) => isStr(c.currency) && isInt(c.max),
  "payment.agent_recurrence": (c) => isStr(c.frequency) && optional(c.max_occurrences, isInt),
  "payment.allowed_payees": (c) => objects(c.allowed),
  "payment.allowed_payment_instruments": (c) => objects(c.allowed, withId),
  "payment.allowed_pisps": (c) => objects(c.allowed),
  "payment.execution_date": (c) => optional(c.not_before, isStr) && optional(c.not_after, isStr),
};

/**
 * The constraints of an open mandate, each either well-formed or reported. An unknown `type` is
 * left for the evaluator, which refuses it as `unknown-constraint`.
 */
function wellFormed<C extends { type: string }>(constraints: unknown, out: Violation[]): C[] {
  if (!Array.isArray(constraints)) {
    out.push(violation("malformed", "the open mandate carries no constraints list"));
    return [];
  }
  return constraints.filter((c): c is C => {
    if (c === null || typeof c !== "object" || typeof (c as { type?: unknown }).type !== "string") {
      out.push(violation("malformed", "a constraint with no type"));
      return false;
    }
    const shape = SHAPES[(c as { type: string }).type];
    if (shape && !shape(c as Record<string, unknown>)) {
      out.push(violation("malformed", "a field this limit needs is missing or of the wrong type", (c as { type: string }).type));
      return false;
    }
    return true;
  });
}

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
  const constraints = wellFormed<CheckoutConstraint>(open?.constraints, out);
  // AP2's schema: an open checkout MUST contain a line_items constraint. Without one it bounds
  // nothing at all, so it is refused rather than read as "anything goes".
  if (!constraints.some((c) => c.type === "checkout.line_items")) {
    out.push(violation("constraint", "an open checkout mandate must contain checkout.line_items", "checkout.line_items"));
  }
  for (const c of constraints) {
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
  /** Epoch ms — the moment a payment that names no `execution_date` executes. Defaults to now. */
  nowMs?: number;
}

/** Clock tolerance on a payment's `execution_date` — the same minute the chain allows on `iat`. */
const EXECUTION_SKEW_MS = 60_000;

/** The claims an open payment mandate may fix, which the closed one must then carry unchanged. */
const PRESET_CLAIMS = ["payment_amount", "payment_instrument", "pisp", "execution_date"] as const;

/** Violations of an Open Payment Mandate by the closed payment the agent signed. */
export function evaluatePayment(open: OpenPaymentMandate, closed: PaymentMandate, ctx: PaymentContext): Violation[] {
  const out: Violation[] = [];
  const constraints = wellFormed<PaymentConstraint>(open?.constraints, out);

  // A preset is a claim the open mandate FIXED. `null` fixes nothing readable, so it is refused
  // rather than skipped as if absent.
  if (open.payee === null) out.push(violation("malformed", "payee is fixed to null"));
  else if (open.payee !== undefined && !merchantMatches(open.payee, closed.payee)) {
    out.push(violation("preset", `payee was fixed to ${open.payee.id} and the payment names ${closed.payee?.id ?? "∅"}`));
  }
  for (const claim of PRESET_CLAIMS) {
    if (open[claim] !== undefined && !sameJson(open[claim], closed[claim])) out.push(violation("preset", `${claim} was fixed by the open mandate and changed`));
  }

  if (!constraints.some((c) => c.type === "payment.reference")) {
    out.push(violation("constraint", "an open payment mandate must contain payment.reference", "payment.reference"));
  }
  if (constraints.some((c) => c.type === "payment.agent_recurrence")) {
    for (const companion of ["payment.amount_range", "payment.budget"] as const) {
      if (!constraints.some((c) => c.type === companion)) out.push(violation("constraint", `agent_recurrence requires ${companion}`, "payment.agent_recurrence"));
    }
  }

  // A payment cannot be dated past the permission it spends: the open mandate's `exp` is the last
  // moment it authorizes anything, whatever window it names — or when it names none.
  if (closed.execution_date !== undefined) {
    const t = Date.parse(closed.execution_date);
    if (Number.isNaN(t)) out.push(violation("malformed", `execution_date ${String(closed.execution_date)} is not a date`));
    else if (typeof open.exp === "number" && t > open.exp * 1000) out.push(violation("constraint", `execution_date ${closed.execution_date} is after the permission expires`));
  }

  const amount = closed.payment_amount;
  for (const c of constraints) {
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
        // A cadence (WEEKLY, MONTHLY…) is a limit this verifier does not enforce yet — enforcing it
        // needs the earlier payments' times, and a rule for what "weekly" bounds. Passing it would
        // let "WEEKLY, 4 times" be spent four times in a minute, so it refuses (rule 3).
        // ON_DEMAND has no cadence: only the count below applies.
        if (c.frequency !== "ON_DEMAND") {
          out.push(violation("constraint", `frequency ${String(c.frequency)} is not enforced by this verifier, so it cannot pass it`, c.type));
        } else if (c.max_occurrences !== undefined) {
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
        // A payment that names no date executes NOW — and now must sit inside the window too.
        // Skipping the check would let an agent leave the window simply by omitting the date.
        const now = ctx.nowMs ?? Date.now();
        const when = closed.execution_date ?? new Date(now).toISOString();
        const t = Date.parse(when);
        // A bound that does not parse would compare false both ways and silently drop out.
        const notBefore = c.not_before === undefined ? undefined : Date.parse(c.not_before);
        const notAfter = c.not_after === undefined ? undefined : Date.parse(c.not_after);
        if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) out.push(violation("constraint", `the window ${c.not_before ?? "…"} – ${c.not_after ?? "…"} is not a pair of dates, so it cannot be checked`, c.type));
        else if (Number.isNaN(t)) out.push(violation("constraint", `execution_date ${when} is not a date`, c.type));
        // A date in the past executes NOW. Dating it inside the window does not put it there, any
        // more than omitting the date does.
        else if (t < now - EXECUTION_SKEW_MS) out.push(violation("constraint", `execution_date ${when} is in the past — the payment would run now, not then`, c.type));
        else if (notBefore !== undefined && t < notBefore) out.push(violation("constraint", `${when} is before ${c.not_before}`, c.type));
        else if (notAfter !== undefined && t > notAfter) out.push(violation("constraint", `${when} is after ${c.not_after}`, c.type));
        break;
      }
      default:
        out.push(violation("unknown-constraint", "this verifier does not know the constraint, so it cannot pass it", (c as { type: string }).type));
    }
  }
  return out;
}
