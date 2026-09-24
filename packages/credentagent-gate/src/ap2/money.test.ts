import { describe, expect, it } from "vitest";
import {
  AmountError,
  amountFrom,
  amountOfMinor,
  amountsEqual,
  exponentFor,
  formatAmount,
  sumAmounts,
  toMajorUnits,
  toMinorUnits,
} from "./money.js";

describe("minor-unit conversion", () => {
  it("converts the prices a catalog actually holds, exactly", () => {
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(279.99, "USD")).toBe(27999);
    expect(toMinorUnits(0, "USD")).toBe(0);
    expect(toMinorUnits(1, "USD")).toBe(100);
    expect(toMinorUnits(-19.99, "USD")).toBe(-1999);
  });

  // The reason this file exists: `Math.round(v * 100)` gets these wrong, because the
  // multiplication is done in binary floating point (1.13 * 100 === 112.99999999999999).
  it("survives the floats that naive multiplication rounds the wrong way", () => {
    for (const [major, minor] of [[1.13, 113], [8.87, 887], [4.9, 490], [1234.56, 123456]] as const) {
      expect(toMinorUnits(major, "USD"), `${major} USD`).toBe(minor);
    }
  });

  it("honours non-2 ISO-4217 exponents", () => {
    expect(exponentFor("JPY")).toBe(0);
    expect(exponentFor("KWD")).toBe(3);
    expect(exponentFor("usd")).toBe(2);
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("round-trips back to major units", () => {
    for (const major of [19.99, 0.01, 1234.56, 0]) {
      expect(toMajorUnits(toMinorUnits(major, "USD"), "USD")).toBe(major);
    }
    expect(toMajorUnits(toMinorUnits(500, "JPY"), "JPY")).toBe(500);
  });
});

// Each case below is a DIFFERENT wrong number that the obvious implementation returns
// happily. Delete the guard named in the comment and the case stops throwing and starts
// returning that number — which is the whole reason the guard is there.
describe("minor-unit conversion refuses what it cannot convert exactly", () => {
  it("refuses a value that is not a finite number", () => {
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(AmountError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "USD")).toThrow(AmountError);
  });

  // BYPASS: one guard, two different wrong answers behind it. Raise `MAX_CONVERTIBLE` back to
  // `Number.MAX_SAFE_INTEGER` and every case in this test starts returning a number instead of
  // throwing — each one a different way of being wrong, listed beside it.
  it("BYPASS: refuses amounts above the point where whole cents stop being exact", () => {
    const rounded = [
      // The noise tolerance grows with the amount; past the ceiling it is wider than the
      // fraction it is meant to catch, so a real sub-cent value is absorbed.
      [1_056_566_563_246.109, 105_656_656_324_611],
      [6_000_000_000_000.005, 600_000_000_000_000],
      [50_000_000_000_000.005, 5_000_000_000_000_001],
      // Past ~$70tn a double cannot tell neighbouring cents apart, so even a VALID amount
      // comes back a cent off.
      [74_974_672_251_518.07, 7_497_467_225_151_806],
      // And from 1e21 up, `toFixed` returns "1e+21", which `parseInt` reads as 1 — a trillion
      // dollars signed as one cent.
      [1e21, 1],
      [1.5e21, 15],
      [-1e21, -1],
    ] as const;
    for (const [major] of rounded) {
      expect(() => toMinorUnits(major, "USD"), `${major} USD`).toThrow(/too large to convert/);
    }
    // The ceiling is a ceiling, not a blanket refusal: $1tn exactly is the largest amount that
    // still converts, and everything ordinary is far below it.
    expect(toMinorUnits(1_000_000_000_000, "USD")).toBe(100_000_000_000_000);
    expect(toMinorUnits(1_000_000_000, "USD")).toBe(100_000_000_000);
  });

  // BYPASS: the amount a human authorizes must be the amount that gets signed. Rounding
  // $1.005 to $1.00 changes it. Remove the sub-unit check and these return 100 and 0.
  it("BYPASS: refuses a value finer than the currency's smallest unit rather than rounding it", () => {
    expect(() => toMinorUnits(1.005, "USD")).toThrow(/finer than the smallest USD unit/);
    expect(() => toMinorUnits(1e-7, "USD")).toThrow(/finer than the smallest USD unit/);
    expect(() => toMinorUnits(0.006, "USD")).toThrow(AmountError);
    expect(() => toMinorUnits(1.5, "JPY")).toThrow(/finer than the smallest JPY unit/);
    // Still refused right up against the ceiling, which is the point of putting the ceiling
    // where it is rather than at the largest number that happens to fit.
    expect(() => toMinorUnits(999_999_999_999.005, "USD")).toThrow(/finer than the smallest USD unit/);
    expect(() => toMinorUnits(999_999_999_999.109, "USD")).toThrow(/finer than the smallest USD unit/);
    // And the tolerance still absorbs the float noise it exists for, at both ends of the range.
    expect(toMinorUnits(0.1 + 0.2, "USD")).toBe(30);
    expect(toMinorUnits(999_999_999_999.99, "USD")).toBe(99_999_999_999_999);
  });

  // BYPASS: defaulting an unknown code to two decimals reads the typo "JYP" as an ordinary
  // two-decimal currency — but JPY has none, so ¥500 would be signed as ¥5. Remove the
  // `unknown-currency` throw and `exponentFor` answers 2 for all of these.
  it("BYPASS: refuses a currency code it does not know instead of assuming two decimals", () => {
    for (const code of ["JYP", "ZZZ", "US", "usdc", ""]) {
      expect(() => exponentFor(code), code).toThrow(/not a known ISO-4217 currency code/);
    }
    expect(() => toMinorUnits(5, "JYP")).toThrow(AmountError);
    expect(() => amountOfMinor(500, "JYP")).toThrow(AmountError);
    expect(() => formatAmount({ amount: 1, currency: "JYP" })).toThrow(AmountError);
  });

  it("carries a code so a caller can phrase its own message for one case", () => {
    const codes = [
      [() => toMinorUnits(Number.NaN, "USD"), "not-finite"],
      [() => toMinorUnits(5, "JYP"), "unknown-currency"],
      [() => toMinorUnits(1e15, "USD"), "too-large"],
      [() => toMinorUnits(1.005, "USD"), "sub-unit"],
      [() => sumAmounts([{ amount: 1, currency: "EUR" }], "USD"), "currency-mismatch"],
    ] as const;
    for (const [run, code] of codes) {
      expect(() => run()).toThrow(AmountError);
      try {
        run();
      } catch (err) {
        expect((err as AmountError).code, code).toBe(code);
      }
    }
  });
});

describe("Amount construction", () => {
  it("normalises currency case into the Amount", () => {
    expect(amountFrom(19.99, "usd")).toEqual({ amount: 1999, currency: "USD" });
    expect(amountOfMinor(1999, "usd")).toEqual({ amount: 1999, currency: "USD" });
  });

  it("refuses minor units that are not a safe integer", () => {
    expect(() => amountOfMinor(19.99, "USD")).toThrow(AmountError);
    expect(() => amountOfMinor(2 ** 53, "USD")).toThrow(AmountError);
  });
});

describe("amount comparison", () => {
  // Fails CLOSED on a currency mismatch rather than throwing: the amount on the other side of
  // this comparison can come off the wire, and an attacker-chosen currency should be a clean
  // refusal, not a 500.
  it("is currency-strict", () => {
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 1999, currency: "USD" })).toBe(true);
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 1999, currency: "EUR" })).toBe(false);
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 2000, currency: "USD" })).toBe(false);
  });

  it("sums in one currency and refuses a mixed sum", () => {
    expect(sumAmounts([{ amount: 1999, currency: "USD" }, { amount: 1, currency: "USD" }], "USD"))
      .toEqual({ amount: 2000, currency: "USD" });
    expect(sumAmounts([], "USD")).toEqual({ amount: 0, currency: "USD" });
    expect(() => sumAmounts([{ amount: 1, currency: "EUR" }], "USD")).toThrow(AmountError);
    expect(() => sumAmounts([{ amount: 1, currency: "USD" }], "ZZZ")).toThrow(AmountError);
  });

  // BYPASS: a line sum that leaves the safe-integer range stops being exact, and invariant 3
  // compares it against a signed amount. Remove the two `isSafeInteger` checks in `sumAmounts`
  // and the first of these returns a total that is quietly off, the second a float total.
  it("BYPASS: refuses a sum that overflows, and a member that is not whole minor units", () => {
    const big = { amount: Number.MAX_SAFE_INTEGER, currency: "USD" };
    expect(() => sumAmounts([big, { amount: 2, currency: "USD" }], "USD")).toThrow(/overflows a safe integer/);
    expect(() => sumAmounts([{ amount: 19.99, currency: "USD" }], "USD")).toThrow(/not an integer number of minor units/);
  });
});

describe("formatting", () => {
  it("renders minor units for humans", () => {
    expect(formatAmount({ amount: 27999, currency: "USD" })).toBe("279.99 USD");
    expect(formatAmount({ amount: 5, currency: "USD" })).toBe("0.05 USD");
    expect(formatAmount({ amount: 500, currency: "JPY" })).toBe("500 JPY");
    expect(formatAmount({ amount: -1999, currency: "USD" })).toBe("-19.99 USD");
    expect(formatAmount({ amount: 1234, currency: "KWD" })).toBe("1.234 KWD");
  });
});
