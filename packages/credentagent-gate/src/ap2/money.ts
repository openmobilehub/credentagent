// The ONE money conversion in the package: the gate's historical float major units (19.99)
// into the integer minor units AP2 requires (1999). `grants.ts` routes through it too, so
// there is exactly one set of rules about what an amount is allowed to be.
//
// Why one converter and not two — security invariant 3 (the line sum, the order total and
// the signed amount must agree on EVERY payment path). Once both sides of a comparison are
// integers they either match or they do not; a float comparison can disagree by a
// representation error no test reliably catches. Two converters with DIFFERENT rules are
// that same failure one level up: one path accepts an amount the other refuses.
//
// The rules, all of them:
//   - the currency must be a KNOWN ISO-4217 code. An unknown code is refused, not assumed
//     to have two decimals: guessing wrong moves the decimal point by a factor of 100 or
//     1000, which is exactly the error the table exists to prevent.
//   - the value must be finite, and must be small enough that cents are still exact — see
//     `MAX_CONVERTIBLE` below. This is a much lower ceiling than a safe integer.
//   - within that range, the value must be exactly representable in that currency's minor
//     units. A finer value is REFUSED, never rounded — silently turning $1.005 into $1.00
//     changes the amount a human is about to authorize.
import type { Amount } from "./types.js";

/** Why an amount was refused. Lets one caller phrase its own message for one case without
 *  re-deriving the arithmetic (`grants.ts` does this for its sub-cent wording). */
export type AmountErrorCode = "not-finite" | "unknown-currency" | "currency-mismatch" | "too-large" | "sub-unit";

/** A refused amount. `RangeError` so existing `toThrow(RangeError)` callers keep working. */
export class AmountError extends RangeError {
  constructor(
    readonly code: AmountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AmountError";
  }
}

/**
 * Active ISO-4217 codes grouped by minor-unit exponent. A code in none of these groups is
 * UNKNOWN and is refused by `exponentFor`.
 *
 * Grouped rather than one entry per line so the three short non-2 groups — the ones where a
 * wrong exponent moves a decimal point — stay auditable at a glance, while the long
 * exponent-2 group carries its only real job: saying which codes exist at all.
 */
const BY_EXPONENT: ReadonlyArray<readonly [number, string]> = [
  [0, "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"],
  [3, "BHD IQD JOD KWD LYD OMR TND"],
  [4, "CLF UYW"],
  [2, [
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN",
    "BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB",
    "EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS",
    "KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN",
    "MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD",
    "SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS",
    "UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG",
  ].join(" ")],
];

const EXPONENTS: ReadonlyMap<string, number> = new Map(
  BY_EXPONENT.flatMap(([exp, codes]) => codes.split(" ").map((code) => [code, exp] as const)),
);

/**
 * Minor-unit exponent for an ISO-4217 code (USD → 2, JPY → 0, KWD → 3).
 *
 * Throws on a code it does not know. Defaulting an unrecognised code to 2 reads a typo
 * (`"JYP"`) as an ordinary two-decimal currency — a 100× error for JPY, which is precisely
 * the case the table is here to catch.
 */
export function exponentFor(currency: string): number {
  const exp = EXPONENTS.get(currency.toUpperCase());
  if (exp === undefined) {
    throw new AmountError("unknown-currency", `not a known ISO-4217 currency code: ${currency}`);
  }
  return exp;
}

/**
 * The largest amount this conversion will accept, in MINOR units: 1e14, which is $1tn, ¥100tn,
 * or 100bn KWD.
 *
 * It is not "the largest number that fits". It is the largest one where "refused, never
 * rounded" is still TRUE, and that is a much smaller number. The tolerance below has to grow
 * with the amount to absorb float noise, and once it grows past a tenth of a minor unit it
 * starts absorbing real fractions instead: `1056566563246.109 USD` would convert to a flat
 * $1,056,566,563,246.11 rather than being refused. That crossover is at about 1.13e14 minor
 * units, so the ceiling sits below it with room to spare.
 *
 * Above the ceiling an ordinary JavaScript number stops being able to tell neighbouring cent
 * values apart at all, so nothing here could be made correct by being cleverer — the honest
 * answer is to refuse. `amountOfMinor` has no such limit, because an integer already IS the
 * minor-unit value and nothing is being converted.
 */
const MAX_CONVERTIBLE = 1e14;

/**
 * Major units (19.99) → minor units (1999). Refuses anything it cannot convert exactly.
 *
 * The conversion runs through a fixed-decimal STRING rather than `Math.round(v * 100)`,
 * because that multiplication is wrong for values a catalog really holds
 * (`1.13 * 100 === 112.99999999999999`). Formatting first makes it exact.
 */
export function toMinorUnits(major: number, currency: string): number {
  if (!Number.isFinite(major)) {
    throw new AmountError("not-finite", `amount is not a finite number: ${major}`);
  }
  const exp = exponentFor(currency);
  const scaled = Math.abs(major) * 10 ** exp;

  // Checked BEFORE `toFixed`, not after. Two different things go wrong above this ceiling and
  // this one line stops both: cents stop being exact (see `MAX_CONVERTIBLE`), and from 1e21
  // upward `toFixed` returns exponential notation ("1e+21"), which `parseInt` reads as 1 — so
  // 1e21 USD would convert to one cent and pass a safe-integer check on the way out.
  if (scaled > MAX_CONVERTIBLE) {
    throw new AmountError(
      "too-large",
      `amount ${major} ${currency} is too large to convert to exact minor units (the ceiling is ${MAX_CONVERTIBLE} minor units)`,
    );
  }

  // Tolerance absorbs the float noise `× 10**exp` introduces on values that ARE representable
  // (4.9 × 100 === 490.00000000000006, and 0.1 + 0.2 === 0.30000000000000004). It grows with
  // the magnitude because the gap between adjacent doubles does, so a fixed 1e-6 would start
  // refusing legitimate large amounts. `MAX_CONVERTIBLE` is what keeps it from growing wide
  // enough to swallow a real fraction: at the ceiling it is 0.09, well under the 0.1 that the
  // smallest sub-unit fraction a caller can write is away from a whole unit.
  const slack = Math.max(1e-6, scaled * Number.EPSILON * 4);
  if (Math.abs(scaled - Math.round(scaled)) > slack) {
    throw new AmountError(
      "sub-unit",
      `amount ${major} ${currency} is finer than the smallest ${currency} unit (1e-${exp}); round it, or pass whole minor units`,
    );
  }

  const [whole, frac = ""] = Math.abs(major).toFixed(exp).split(".");
  const magnitude = Number.parseInt(`${whole}${frac}`, 10);
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

/** An AP2 `Amount` straight from minor units — no conversion, for values already integral.
 *  No `MAX_CONVERTIBLE` ceiling here: an integer already IS the minor-unit value, so it is
 *  exact anywhere a safe integer is. */
export function amountOfMinor(minor: number, currency: string): Amount {
  const iso = currency.toUpperCase();
  exponentFor(iso); // refuse an unknown code here too, so every Amount carries a real currency
  if (!Number.isSafeInteger(minor)) {
    throw new AmountError("too-large", `minor units must be a safe integer: ${minor}`);
  }
  return { amount: minor, currency: iso };
}

/**
 * Do two amounts denote the same money? Currency-strict: a USD amount and a EUR amount with
 * equal integers are NOT equal.
 *
 * A mismatch answers `false` rather than throwing, and that is deliberate: this predicate
 * guards amount binding, where the amount being compared can come off the wire. Throwing
 * would turn an attacker-chosen currency into a 500 instead of a clean refusal, so the
 * currency check fails CLOSED. `sumAmounts` throws instead, because a mixed-currency sum has
 * no fail-closed answer to give.
 */
export function amountsEqual(a: Amount, b: Amount): boolean {
  if (a.currency !== b.currency) return false;
  return a.amount === b.amount;
}

/**
 * Sum amounts in a single currency.
 *
 * Throws on a mixed-currency sum rather than guessing, on a non-integer member (a float here
 * means someone skipped `toMinorUnits`, and invariant 3's whole point is that these
 * comparisons are integer), and on a running total that leaves the safe-integer range.
 */
export function sumAmounts(amounts: ReadonlyArray<Amount>, currency: string): Amount {
  const iso = currency.toUpperCase();
  exponentFor(iso);
  let total = 0;
  for (const a of amounts) {
    if (a.currency !== iso) throw new AmountError("currency-mismatch", `cannot sum ${a.currency} into a ${iso} total`);
    if (!Number.isSafeInteger(a.amount)) {
      throw new AmountError("too-large", `amount is not an integer number of minor units: ${a.amount} ${a.currency}`);
    }
    total += a.amount;
    if (!Number.isSafeInteger(total)) {
      throw new AmountError("too-large", `sum overflows a safe integer at ${a.amount} ${iso}`);
    }
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
