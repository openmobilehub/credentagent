// Invariant 1 on the spending-grant path (#139): a custom gate() credential a store registers
// must hold when a grant buys, exactly as it does at checkout. A grant spend is a completion
// path; an unattended agent can't present a prescription, so an applicable gate must step up
// to a human — never complete.
import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { DelegatedGate } from "./delegated.js";
import { defineCredential, dcql, gate, required } from "./credentials.js";
import type { Credential, GateOrder } from "./types.js";

// The same prescription rule, written the three ways a store can write it.
const rx = (id: string, appliesTo?: Credential["appliesTo"]) =>
  defineCredential({
    id,
    request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
    verify: (c) => c.rx_valid === true,
    effect: gate(),
    ...(appliesTo ? { appliesTo } : {}),
    ui: { label: "Prescription", action: "Verify prescription" },
  });
const byId = rx("prescription", (o) => o.lines.some((l) => l.id === "amoxicillin"));
const byCategory = rx("prescription", (o) => o.lines.some((l) => l.category === "Pharmacy" && l.id !== "ibuprofen")); // getting-started shape
const byRequiresRx = rx("prescription", (o) => o.lines.some((l) => l.requiresRx === true)); // ARCHITECTURE.md / OrderLine shape
const everyOrder = rx("store_wide_license"); // no appliesTo: applies to every order whose policy names it

const CATALOG = {
  amoxicillin: { price: 42, category: "Pharmacy", requiresRx: true },
  ibuprofen: { price: 8, category: "Pharmacy" },
};
const STEPPED_UP = { ok: false, code: "step-up", retryable: "needs-human", stepUp: "custom-gate" } as const;

async function pharmacyGrant(ca: CredentAgent) {
  const g = await ca.grants.create({ merchant: "pharmacy", budget: 100, perSpend: 50, allow: { categories: ["Pharmacy"] }, signing: "page" });
  await ca.grants._authorize(g.id); // the person's one approval
  return (await ca.grants.retrieve(g.id))!;
}
const store = (credentials?: Credential[]) =>
  new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG, ...(credentials ? { credentials } : {}) });
const rxOrder: GateOrder = { id: "ORD-RX", total: 4200, currency: "USD", lines: [{ id: "amoxicillin", quantity: 1, unitPrice: 4200, requiresRx: true }] };

describe("credentagent.grants — custom gate() credentials hold on a grant spend (#139, invariant 1)", () => {
  it.each([
    ["the product id", byId],
    ["the product's category (the getting-started shape)", byCategory],
    ["the product's requiresRx flag (the ARCHITECTURE.md shape)", byRequiresRx],
  ])("REFUSES a custom-gate bypass: a grant cannot buy a product a declared gate() keyed on %s protects", async (_shape, prescription) => {
    const g = await pharmacyGrant(store([prescription]));

    const door = await g.spend({ idempotencyKey: "rx-1", items: [{ sku: "amoxicillin" }] });

    expect(door).toMatchObject(STEPPED_UP);
    expect(await g.usage()).toMatchObject({ spent: 0, remaining: 100 }); // nothing was drawn
  });

  it("still lets the same grant buy a product the gate does not cover", async () => {
    const g = await pharmacyGrant(store([byRequiresRx]));

    const door = await g.spend({ idempotencyKey: "otc-1", items: [{ sku: "ibuprofen" }] });

    expect(door).toMatchObject({ ok: true, amount: 8 });
  });

  it("REFUSES the bypass for a gate a checkout registered AFTER the grant was created (live registry, not a snapshot)", async () => {
    const ca = store();
    const g = await pharmacyGrant(ca);
    ca.requirements(rxOrder, [required(byRequiresRx)]); // the store's checkout resolves its policy

    const door = await g.spend({ idempotencyKey: "rx-2", items: [{ sku: "amoxicillin" }] });

    expect(door).toMatchObject(STEPPED_UP);
    expect(await g.usage()).toMatchObject({ spent: 0 });
  });

  it("a DECLARED gate with no appliesTo is store-wide: it steps up every grant spend", async () => {
    const g = await pharmacyGrant(store([everyOrder]));

    expect(await g.spend({ idempotencyKey: "otc-2", items: [{ sku: "ibuprofen" }] })).toMatchObject(STEPPED_UP);
  });

  it("REFUSES a declared gate's bypass even when a later checkout registers a narrower copy under the same id", async () => {
    const ca = store([byRequiresRx]);
    const g = await pharmacyGrant(ca);
    // `.when()` keeps the id, so this would replace the declared rule in the shared registry.
    ca.requirements(rxOrder, [required(byRequiresRx.when((o) => o.id.startsWith("ORD-")))]);

    expect(await g.spend({ idempotencyKey: "rx-4", items: [{ sku: "amoxicillin" }] })).toMatchObject(STEPPED_UP);
  });

  it("labels an age step-up `stepUp: \"age\"`, so an agent can tell it from a prescription", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: { wine: { price: 21, minAge: 21, category: "Pharmacy" } } });
    const g = await pharmacyGrant(ca);

    expect(await g.spend({ idempotencyKey: "wine-1", items: [{ sku: "wine" }] })).toMatchObject({ ok: false, code: "step-up", stepUp: "age" });
  });

  it("REFUSES a re-pricing bypass: catalog attributes can't override the price, quantity or id the engine sets", async () => {
    const hostile = { amoxicillin: { price: 42, category: "Pharmacy", requiresRx: true, unitPrice: 1, lineTotal: 1, quantity: 999, id: "ibuprofen", currency: "EUR" } };
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: hostile, credentials: [byId] });
    const g = await pharmacyGrant(ca);

    // Priced at $42 (not $0.01) and still the amoxicillin line, so the id-keyed rule fires.
    expect(await g.spend({ idempotencyKey: "rx-5", items: [{ sku: "amoxicillin" }] })).toMatchObject(STEPPED_UP);
    const open = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: hostile });
    const g2 = await pharmacyGrant(open);
    expect(await g2.spend({ idempotencyKey: "rx-6", items: [{ sku: "amoxicillin" }] })).toMatchObject({ ok: true, amount: 42 });
  });

  it("a gate with no appliesTo that only ONE checkout's policy named does not block other grant spends (#59 class)", async () => {
    const ca = store();
    const g = await pharmacyGrant(ca);
    ca.requirements(rxOrder, [required(everyOrder)]); // some shopper's checkout needed a licence

    expect(await g.spend({ idempotencyKey: "otc-3", items: [{ sku: "ibuprofen" }] })).toMatchObject({ ok: true, amount: 8 });
  });
});

describe("DelegatedGate — the `credentials` option (#139)", () => {
  it("REFUSES a custom-gate bypass on a draw when the gate is passed as `credentials`", async () => {
    const gateOnly = new DelegatedGate({ catalog: { amoxicillin: { price: 4200, requiresRx: true } }, credentials: [byRequiresRx] });
    const grant = await gateOnly.preApprove({ merchant: "pharmacy", perOrder: 5000, total: 10000 });

    const r = await grant.spend({ idempotencyKey: "rx-3", item: "amoxicillin" });

    expect(r).toMatchObject({ ok: false, reason: "step-up", stepUp: "custom-gate" });
  });
});
