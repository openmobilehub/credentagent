// Extensibility contract (CT5): a custom credential defined with defineCredential
// drops into the same policy and is gated by its own `appliesTo` — proving the
// "gate ANY credential" promise (Principle V), not just the three built-ins.

import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { defineCredential, dcql, gate, required, optional, age, membership, payment } from "./credentials.js";
import type { GateOrder } from "./types.js";

const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,
  effect: gate(),
  appliesTo: (order) => order.lines.some((l) => l.requiresRx), // only for Rx items
  ui: { label: "Prescription", action: "Verify prescription" },
});

const rxOrder: GateOrder = {
  id: "ORD-RX",
  total: 4200,
  currency: "USD",
  lines: [{ id: "amoxicillin", quantity: 1, unitPrice: 4200, requiresRx: true }],
};
const otcOrder: GateOrder = {
  id: "ORD-OTC",
  total: 1200,
  currency: "USD",
  lines: [{ id: "bandages", quantity: 1, unitPrice: 1200 }],
};

describe("CT5 — custom credential via defineCredential (appliesTo)", () => {
  it("appears only for an Rx line", () => {
    const manifest = credentagent.requirements(rxOrder, [required(prescription)]);
    const rx = manifest.find((e) => e.credential === "prescription");
    expect(rx).toBeTruthy();
    expect(rx!.effect).toBe("gate");
    expect(rx!.approveUrl).toContain("/credential-gate/prescription");
    expect(rx!.approveUrl).toContain("ORD-RX");
  });

  it("is absent for a non-Rx line", () => {
    const manifest = credentagent.requirements(otcOrder, [required(prescription)]);
    expect(manifest.find((e) => e.credential === "prescription")).toBeUndefined();
  });

  it("dcql sugar expands to the full verifier shape", () => {
    const q = dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] });
    expect(q.credentials[0].meta.doctype_value).toBe("org.hl7.prescription.1");
    expect(q.credentials[0].format).toBe("mso_mdoc");
    expect(q.credentials[0].claims[0].path).toEqual(["org.hl7.prescription.1", "rx_valid"]);
    expect(q.credentials[0].claims[0].intent_to_retain).toBe(false);
  });
});

// Regression (#90). `dcql()` used to derive the credential id from the doctype's LAST
// segment (`docType.split(".").pop()`). mdoc doctypes are version-suffixed by convention,
// so `org.openwallet.payment.1` and `org.multipaz.loyalty.1` both collapsed to "1" — the
// DEFAULT collided across essentially every credential. The id is the key
// `credential_sets` references and the key a wallet echoes each presentation back under,
// so a collision makes any query containing both credentials ambiguous. The fix derives
// the id from the FULL doctype (sanitized to DCQL's `[A-Za-z0-9_-]`), with an optional
// caller-supplied `id` override.
describe("dcql() derives a unique credential id per doctype (#90)", () => {
  it("two dcql() credentials with different doctypes never share an id", () => {
    // Under the reverted `docType.split(".").pop()` derivation these version-suffixed
    // doctypes ALL collapse to "1" — this assertion then fails (Set size 1, not 4).
    const doctypes = [
      "org.openwallet.payment.1", // payment built-in
      "org.multipaz.loyalty.1", // membership built-in
      "org.hl7.prescription.1", // custom
      "com.acme.license.1", // custom
    ];
    const ids = doctypes.map((docType) => dcql({ docType, claims: ["x"] }).credentials[0].id);
    expect(new Set(ids).size).toBe(doctypes.length); // all distinct — no collision
  });

  it("derives from the FULL doctype (dots → underscores), not just the last segment", () => {
    const id = dcql({ docType: "org.openwallet.payment.1", claims: ["account"] }).credentials[0].id;
    expect(id).toBe("org_openwallet_payment_1"); // full doctype, sanitized — not "1"
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/); // DCQL ids are [A-Za-z0-9_-] (OpenID4VP)
  });

  it("accepts an explicit `id` override, and keeps the safe default when omitted", () => {
    const named = dcql({ docType: "org.openwallet.payment.1", claims: ["account"], id: "pay" });
    expect(named.credentials[0].id).toBe("pay");
    const defaulted = dcql({ docType: "org.openwallet.payment.1", claims: ["account"] });
    expect(defaulted.credentials[0].id).toBe("org_openwallet_payment_1");
  });
});

// Regression (PR #42 review — finding 1). A custom credential whose id collides with a reserved
// built-in (age/membership/payment) is silently shadowed: resolveCred routes it to the built-in
// path and the completion sweep skips it (RESERVED_CREDENTIAL_IDS), so a declared hard `gate()`
// becomes a fail-OPEN no-op (an order completes unproven) with no error at define/mount time.
// The fix is to reject a reserved id at construction — fail-fast beats a policy the seam can't honor.
describe("defineCredential rejects a reserved built-in id (finding 1 — fail-open guard)", () => {
  for (const id of ["age", "membership", "payment"]) {
    it(`throws on id="${id}" instead of silently shadowing the built-in`, () => {
      expect(() =>
        defineCredential({
          id,
          request: dcql({ docType: "org.example.x.1", claims: ["ok"] }),
          verify: () => true,
          effect: gate(),
          ui: { label: "Custom", action: "Prove" },
        }),
      ).toThrow(/reserved/i);
    });
  }
});

// Regression (PR #42 review — item 4). required()/optional() must reject a policy the ceremony
// seam cannot honor. optional(gate())/optional(payment) surfaces a BLOCKING credential the
// completion sweep only enforces when required — so an "optional gate" checks out unproven
// (fail-OPEN). required(discount()) asks the seam to block completion on a benefit that never
// blocks. Reject both at construction — fail-fast, same posture as finding 1.
describe("required/optional reject a policy the seam can't honor (item 4)", () => {
  const customGate = defineCredential({
    id: "prescription",
    request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
    verify: (c) => c.rx_valid === true,
    effect: gate(),
    ui: { label: "Prescription", action: "Verify prescription" },
  });

  it("optional(gate()) throws — a hard gate declared optional is surfaced but never enforced (fail-open)", () => {
    expect(() => optional(age.over(21))).toThrow(/must be required/i);
    expect(() => optional(customGate)).toThrow(/must be required/i);
  });

  it("optional(payment) throws — an authorize gate declared optional would never settle", () => {
    expect(() => optional(payment.in("usd"))).toThrow(/must be required/i);
  });

  it("required(discount()) throws — a discount is a benefit, not a blocking requirement", () => {
    expect(() => required(membership.discount(10))).toThrow(/must be optional/i);
  });

  it("still accepts every valid combination (required gate/authorize, optional discount)", () => {
    expect(() => required(age.over(21))).not.toThrow();
    expect(() => required(customGate)).not.toThrow();
    expect(() => required(payment.in("usd"))).not.toThrow();
    expect(() => optional(membership.discount(10))).not.toThrow();
  });
});
