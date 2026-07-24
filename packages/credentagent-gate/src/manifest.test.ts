// Contract tests for the code→data boundary, `requirements()` (Principle VI).
// These exercise the load-bearing properties: nothing-but-data on the wire,
// conditional drop, payment-last, required/optional, and the honesty axes.

import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { age, membership, payment, required, optional } from "./credentials.js";
import type { GateOrder } from "./types.js";

const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });

const alcoholOrder: GateOrder = {
  id: "ORD-1",
  total: 12400,
  currency: "USD",
  lines: [{ id: "oak-whiskey", quantity: 1, unitPrice: 12400, minimumAge: 21, category: "Beverages" }],
};
const plainOrder: GateOrder = {
  id: "ORD-2",
  total: 6900,
  currency: "USD",
  lines: [{ id: "drift-mouse", quantity: 1, unitPrice: 6900, category: "Electronics" }],
};

// Grounded in the real catalog: alcohol items carry `minimumAge`, there is no
// "alcohol" category (see catalog.ts).
const hasAlcohol = (o: GateOrder) => o.lines.some((l) => l.minimumAge != null);

const fullPolicy = [
  required(age.over(21).when(hasAlcohol)),
  optional(membership.discount(10)),
  required(payment.in("usd")),
];

describe("CT1 — serialization (no functions on the wire)", () => {
  it("JSON.stringify round-trips deeply equal; no function-valued fields", () => {
    const manifest = credentagent.requirements(alcoholOrder, fullPolicy);
    const round = JSON.parse(JSON.stringify(manifest));
    expect(round).toEqual(manifest);
    for (const entry of manifest) {
      for (const value of Object.values(entry)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });
});

describe("CT8 — honesty axes (Principle VII)", () => {
  it("every entry carries enforcedAt + trust_level", () => {
    const manifest = credentagent.requirements(alcoholOrder, fullPolicy);
    expect(manifest.length).toBeGreaterThan(0);
    for (const entry of manifest) {
      expect(entry.enforcedAt).toBe("checkout"); // consolidated Mode A
      expect(entry.trust_level).toBe("presence-only-demo"); // v0.1 — not a real safety control
    }
  });
});

describe("CT2 — conditional drop (.when)", () => {
  it("non-alcohol cart ⇒ no age entry", () => {
    const manifest = credentagent.requirements(plainOrder, fullPolicy);
    expect(manifest.find((e) => e.credential === "age")).toBeUndefined();
  });

  it("alcohol cart ⇒ age at minAge:21 with an approveUrl bound to THIS order id", () => {
    const manifest = credentagent.requirements(alcoholOrder, fullPolicy);
    const ageEntry = manifest.find((e) => e.credential === "age");
    expect(ageEntry).toBeTruthy();
    expect(ageEntry!.effect).toBe("gate");
    expect(ageEntry!.minAge).toBe(21);
    expect(ageEntry!.approveUrl).toContain("ORD-1");
    expect(ageEntry!.approveUrl).toContain("/credential-gate/age");
  });
});

describe("CT3 — payment settles last", () => {
  it("payment resolves last even when declared first", () => {
    const policy = [
      required(payment.in("usd")), // declared FIRST
      required(age.over(21).when(hasAlcohol)),
      optional(membership.discount(10)),
    ];
    const manifest = credentagent.requirements(alcoholOrder, policy);
    expect(manifest[manifest.length - 1].credential).toBe("payment");
    expect(manifest[manifest.length - 1].effect).toBe("authorize");
  });
});

describe("CT4 — required vs optional", () => {
  it("optional(membership) is present but never required; required(age) is required", () => {
    const manifest = credentagent.requirements(alcoholOrder, fullPolicy);
    const member = manifest.find((e) => e.credential === "membership");
    const ageEntry = manifest.find((e) => e.credential === "age");
    expect(member!.required).toBe(false);
    expect(member!.effect).toBe("discount");
    expect(member!.discountPct).toBe(10);
    expect(ageEntry!.required).toBe(true);
  });
});

// 008 (#88): when a `verifier` seam is wired, the PAYMENT (authorize) approve link resolves
// to the ONE delegated ceremony; identity gates (age) stay on the built-in credential rail —
// the buyer proves age there FIRST, then pays through the delegated ceremony (a two-step flow).
// A discount also stays on the credential rail; without a verifier the links are byte-unchanged.
describe("008 — delegated approve-link routing", () => {
  const minimalCeremony = () => ({
    orderStore: { read: async () => null },
    catalog: { createOrder: (_items: unknown, id: string) => ({ id, lines: [], itemCount: 0, subtotal: 0, discount: 0, total: 0, currency: "USD" }) },
    completion: async () => ({ completed: true as const }),
    signingKey: "stable-test-secret",
  });
  const verifier = {
    buildRequest: async () => ({ reference: "r", handoff: {} }),
    consume: async () => ({ approved: true, trust_level: "presence-only-demo" as const, claims: {}, binding: { amount: 0, currency: "USD", payee: { id: "shop.example" } } }),
  };

  it("routes payment to /credentagent/delegated; age + discount stay on the credential rail (two-step)", () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    // A route-less app is fine: mount() sets the delegated flag from ceremony.verifier
    // regardless of whether the rail's HTTP routes register.
    ca.mount({ locals: {} }, { ...minimalCeremony(), verifier });
    const manifest = ca.requirements(alcoholOrder, fullPolicy);
    const url = (id: string) => manifest.find((e) => e.credential === id)!.approveUrl;
    // Two-step: age is proven on the built-in credential rail FIRST (a real OpenID4VP mdoc
    // step), NOT folded into the delegated ceremony — only the payment goes delegated.
    expect(url("age")).toBe("https://shop.example/credentagent/credential?order=ORD-1&cred=age");
    expect(url("payment")).toBe("https://shop.example/credentagent/delegated?order=ORD-1");
    // A discount is NOT in the delegated presentation — the buyer opts in on the credential rail.
    expect(url("membership")).toBe("https://shop.example/credentagent/credential?order=ORD-1&cred=membership");
  });

  it("WITHOUT a verifier the links are the built-in rails (byte-unchanged)", () => {
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" });
    ca.mount({ locals: {} }, minimalCeremony()); // no verifier
    const manifest = ca.requirements(alcoholOrder, fullPolicy);
    const url = (id: string) => manifest.find((e) => e.credential === id)!.approveUrl;
    expect(url("age")).toBe("https://shop.example/credentagent/credential?order=ORD-1&cred=age");
    expect(url("payment")).toBe("https://shop.example/credentagent/dc-payment?order=ORD-1");
  });
});
