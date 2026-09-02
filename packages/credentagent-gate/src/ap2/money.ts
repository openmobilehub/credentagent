// The ONE conversion between the gate's historical float-major-units numbers and the
// integer minor units AP2 requires. Every other file in `ap2/` deals in integers only.
//
// Why this matters for security invariant 3 (the line sum, the order total and the signed
// amount must agree on EVERY payment path): once both sides of a comparison are integers,
// they either match or they do not. A float comparison can disagree by a representation
// error no test would reliably catch, and an amount binding that is occasionally wrong is
// worse than one that is always wrong.
import type { Amount } from "./types.js";

/**
 * ISO-4217 minor-unit exponents that are NOT 2. Anything absent uses 2.
 *
 * Deliberately short: these are the exponents that actually change an amount's meaning by a
 * factor of 100, so getting one wrong is a real-money bug. Currencies with exponent 2 are
 * the default and need no entry.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** Minor-unit exponent for an ISO-4217 code. Unknown codes get the 2 that most use. */
export function exponentFor(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Major units (19.99) → minor units (1999).
 *
 * Routes through a fixed-decimal STRING rather than `Math.round(v * 100)`: the
 * multiplication introduces binary-float error that rounds the wrong way for values
 * a catalog really holds (`1.13 * 100 === 112.99999999999999`). Formatting first makes
 * the conversion exact for every value a price can actually be.
 */
export function toMinorUnits(major: number, currency: string): number {
  if (!Number.isFinite(major)) throw new RangeError(`amount is not a finite number: ${major}`);
  const exp = exponentFor(currency);
  const [whole, frac = ""] = Math.abs(major).toFixed(exp).split(".");
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "");
  const magnitude = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(magnitude)) throw new RangeError(`amount overflows a safe integer: ${major} ${currency}`);
  return major < 0 ? -magnitude : magnitude;
}

/** Minor units (1999) → major units (19.99). For DISPLAY and legacy interop only. */
export function toMajorUnits(minor: number, currency: string): number {
  const exp = exponentFor(currency);
  return exp === 0 ? minor : Number((minor / 10 ** exp).toFixed(exp));
}

/** Build an AP2 `Amount` from the gate's historical float. Currency is normalised upper-case. */
export function amountFrom(major: number, currency: string): Amount {
  const iso = currency.toUpperCase();
  return { amount: toMinorUnits(major, iso), currency: iso };
}

/** An AP2 `Amount` straight from minor units — no conversion, for values already integral. */
export function amountOfMinor(minor: number, currency: string): Amount {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`minor units must be a safe integer: ${minor}`);
  return { amount: minor, currency: currency.toUpperCase() };
}

/**
 * Do two amounts denote the same money? Currency-strict: a USD amount and a EUR amount
 * with equal integers are NOT equal, and comparing them is a bug worth surfacing rather
 * than silently answering `false`.
 */
export function amountsEqual(a: Amount, b: Amount): boolean {
  if (a.currency !== b.currency) return false;
  return a.amount === b.amount;
}

/** Sum amounts in a single currency. Throws on a mixed-currency sum rather than guessing. */
export function sumAmounts(amounts: ReadonlyArray<Amount>, currency: string): Amount {
  const iso = currency.toUpperCase();
  let total = 0;
  for (const a of amounts) {
    if (a.currency !== iso) throw new RangeError(`cannot sum ${a.currency} into a ${iso} total`);
    total += a.amount;
  }
  return { amount: total, currency: iso };
}

/** Human-readable, for pages and refusal messages. Never used in a comparison. */
export function formatAmount(a: Amount): string {
  const exp = exponentFor(a.currency);
  const sign = a.amount < 0 ? "-" : "";
  const digits = String(Math.abs(a.amount)).padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp) || "0";
  return exp === 0 ? `${sign}${whole} ${a.currency}` : `${sign}${whole}.${digits.slice(digits.length - exp)} ${a.currency}`;
}
