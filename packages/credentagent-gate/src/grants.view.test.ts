// grantView(grant, { product? }) — the ONE place a live grant becomes the plain data a card renders
// (spec 015). It moved here from the storefront so any MCP server can write
//   cards.grant(await grantView(await credentagent.grants.retrieve(id)))
// without a projection of its own. Each test pins one control: delete the control → red.
import { describe, it, expect } from "vitest";
import { CredentAgent } from "./client.js";
import { grantView } from "./grants.js";
import { GRANT_VIEW_KIND } from "./cards/grant-view.js";
import { AgentKey } from "./agent.js";
import type { Grant } from "./grants.js";

const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages" },
};
const client = () => new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG });

async function authorized(ca: CredentAgent, allow?: { skus?: string[]; categories?: string[] }): Promise<Grant> {
  const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, ...(allow ? { allow } : {}), signing: "page" });
  await ca.grants._authorize(g.id);
  return (await ca.grants.retrieve(g.id))!;
}

describe("grantView — a live grant as plain card data", () => {
  it("reads the grant's money, lifecycle and bounds from the grant itself", async () => {
    const ca = client();
    const view = await grantView(await authorized(ca, { categories: ["Beverages"] }));
    expect(view).toMatchObject({
      kind: GRANT_VIEW_KIND,
      merchant: "utopia",
      status: "authorized",
      lifecycle: "active",
      budget: 100,
      spent: 0,
      remaining: 100,
      perSpend: 30,
      allow: { skus: [], categories: ["Beverages"] },
    });
  });

  // BYPASS (display-only by construction): a view with a method on it could call spend()/revoke().
  // Spread the live grant into the view instead of copying fields → red.
  it("BYPASS: the view is inert plain data — no function anywhere, none of the live handle's methods", async () => {
    const ca = client();
    const view = await grantView(await authorized(ca, { skus: ["coffee"] }));
    const assertInert = (o: unknown, path = "$"): void => {
      expect(typeof o, `${path} must not be a function`).not.toBe("function");
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) assertInert(v, `${path}.${k}`);
    };
    assertInert(view);
    const asRecord = view as unknown as Record<string, unknown>;
    for (const method of ["spend", "revoke", "usage"]) expect(asRecord[method]).toBeUndefined();
  });

  // The lifecycle is derived once, from the live money read. Compute it from status alone → red.
  it("derives lifecycle from the live money: spent down reads low, revoked reads revoked", async () => {
    const ca = client();
    const created = await ca.grants.create({ merchant: "utopia", budget: 20, perSpend: 20, allow: { skus: ["coffee"] }, signing: "page" });
    await ca.grants._authorize(created.id);
    const g = (await ca.grants.retrieve(created.id))!;
    expect((await grantView(g)).lifecycle).toBe("active");
    expect(await g.spend({ idempotencyKey: "s1", items: [{ sku: "coffee" }] })).toMatchObject({ ok: true });
    expect(await grantView((await ca.grants.retrieve(g.id))!)).toMatchObject({ lifecycle: "low", spent: 18, remaining: 2 });
    await g.revoke();
    expect((await grantView((await ca.grants.retrieve(g.id))!)).lifecycle).toBe("revoked");
  });

  // The card's revoked text reads this: say "no further purchases" for a grant whose permission the
  // agent holds and the card lies (GLOSSARY.md, Revoke). Drop the field → red.
  it("BYPASS: agentHeld says whether revoking recalls the grant", async () => {
    const ca = client();
    const served = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" });
    const held = await ca.grants.create({
      merchant: "utopia", budget: 100, perSpend: 30, signing: "device", agentKey: AgentKey.generate().publicJwk,
    });
    expect((await grantView((await ca.grants.retrieve(served.id))!)).agentHeld).toBe(false);
    expect((await grantView((await ca.grants.retrieve(held.id))!)).agentHeld).toBe(true);
  });

  // An agent must read "no age proof" as a fact, not infer it from a missing key (#172). Make the
  // field optional and an unproved grant loses the key → red.
  it("BYPASS: credentials is always present, null when nothing was proved", async () => {
    const ca = client();
    const view = await grantView(await authorized(ca, { skus: ["coffee"] }));
    expect(view.credentials).toEqual({ ageVerified: null, loyaltyDiscountPct: null });
  });

  it("reads what the person proved: the age and the loyalty rate", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:4000", catalog: CATALOG, loyaltyDiscountPct: 10 });
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { skus: ["wine"] }, signing: "page" });
    await ca.grants._recordAgeProof(g.id, { provenAge: 21 });
    await ca.grants._recordMembershipProof(g.id, { membershipNumber: "GOLD-0001" });
    await ca.grants._authorize(g.id);
    const view = await grantView((await ca.grants.retrieve(g.id))!);
    expect(view.credentials).toMatchObject({ ageVerified: 21, loyaltyDiscountPct: 10, trustLevel: "presence-only-demo" });
  });

  it("carries the product the caller resolved, and only that", async () => {
    const ca = client();
    const grant = await authorized(ca, { skus: ["coffee"] });
    const product = { id: "coffee", name: "Coffee", price: 18, currency: "USD", category: "Beverages" };
    expect((await grantView(grant, { product })).product).toEqual(product);
    expect("product" in (await grantView(grant))).toBe(false);
  });

  it("names the grant's merchant, approve link and trust level as the grant holds them", async () => {
    const ca = client();
    const grant = await authorized(ca);
    const view = await grantView(grant);
    expect(view).toMatchObject({ id: grant.id, approveUrl: grant.approveUrl, presence: grant.presence, trustLevel: grant.trustLevel });
  });
});
