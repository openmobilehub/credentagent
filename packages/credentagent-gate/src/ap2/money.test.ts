import { describe, expect, it } from "vitest";
import { amountFrom, amountsEqual, exponentFor, formatAmount, sumAmounts, toMajorUnits, toMinorUnits } from "./money.js";

describe("minor-unit conversion", () => {
  it("converts the prices a catalog actually holds, exactly", () => {
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(279.99, "USD")).toBe(27999);
    expect(toMinorUnits(0, "USD")).toBe(0);
    expect(toMinorUnits(1, "USD")).toBe(100);
  });

  // The reason this file exists: `Math.round(v * 100)` gets these wrong, because the
  // multiplication is done in binary floating point (1.13 * 100 === 112.99999999999999).
  it("survives the floats that naive multiplication rounds the wrong way", () => {
    for (const [major, minor] of [[1.13, 113], [8.87, 887], [1.005, 100], [1234.56, 123456]] as const) {
      expect(toMinorUnits(major, "USD"), `${major} USD`).toBe(minor);
    }
  });

  it("honours non-2 ISO-4217 exponents", () => {
    expect(exponentFor("JPY")).toBe(0);
    expect(exponentFor("KWD")).toBe(3);
    expect(exponentFor("usd")).toBe(2);
    expect(exponentFor("ZZZ")).toBe(2);
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("round-trips back to major units", () => {
    for (const major of [19.99, 0.01, 1234.56, 0]) {
      expect(toMajorUnits(toMinorUnits(major, "USD"), "USD")).toBe(major);
    }
    expect(toMajorUnits(toMinorUnits(500, "JPY"), "JPY")).toBe(500);
  });

  it("refuses values it cannot represent rather than guessing", () => {
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(1e17, "USD")).toThrow(RangeError);
  });

  it("normalises currency case into the Amount", () => {
    expect(amountFrom(19.99, "usd")).toEqual({ amount: 1999, currency: "USD" });
  });
});

describe("amount comparison", () => {
  it("is currency-strict", () => {
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 1999, currency: "USD" })).toBe(true);
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 1999, currency: "EUR" })).toBe(false);
    expect(amountsEqual({ amount: 1999, currency: "USD" }, { amount: 2000, currency: "USD" })).toBe(false);
  });

  it("sums in one currency and refuses a mixed sum", () => {
    expect(sumAmounts([{ amount: 1999, currency: "USD" }, { amount: 1, currency: "USD" }], "USD"))
      .toEqual({ amount: 2000, currency: "USD" });
    expect(() => sumAmounts([{ amount: 1, currency: "EUR" }], "USD")).toThrow(RangeError);
  });
});

describe("formatting", () => {
  it("renders minor units for humans", () => {
    expect(formatAmount({ amount: 27999, currency: "USD" })).toBe("279.99 USD");
    expect(formatAmount({ amount: 5, currency: "USD" })).toBe("0.05 USD");
    expect(formatAmount({ amount: 500, currency: "JPY" })).toBe("500 JPY");
    expect(formatAmount({ amount: -1999, currency: "USD" })).toBe("-19.99 USD");
  });
});
