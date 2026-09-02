// The AP2 layer as the gate actually wires it: the published DID document, the mandate
// bundle a delegated spend hands back (#114), and the honesty axes (#11).
import { describe, expect, it } from "vitest";
import { CredentAgent } from "../client.js";
import { verifyMandate } from "./verify.js";
import { verifyChain } from "./chain.js";
import { digestToken } from "./sdjwt.js";
import { findConstraint, VCT, type OpenPaymentMandate, type PaymentMandate } from "./types.js";
import { resolveSigningKey } from "./keys.js";
import { generateKeyPairSync } from "node:crypto";

const ORIGIN = "https://shop.example";

/** A minimal express-shaped app: enough for mount() to register a route. */
function fakeApp() {
  const routes = new Map<string, (req: unknown, res: FakeRes) => void>();
  return {
    locals: {} as Record<string, unknown>,
    get(path: string, handler: (req: unknown, res: FakeRes) => void) {
      routes.set(path, handler);
    },
    routes,
  };
}
interface FakeRes {
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

describe("did:web publication (spec 013 decision #2)", () => {
  it("mount() serves the gate's public key at /.well-known/did.json", () => {
    const app = fakeApp();
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN });
    credentagent.mount(app);

    const handler = app.routes.get("/.well-known/did.json");
    expect(handler).toBeDefined();

    let body: Record<string, unknown> | undefined;
    handler!({}, { setHeader: () => {}, json: (b) => void (body = b as Record<string, unknown>) });

    expect(body?.id).toBe("did:web:shop.example");
    const vm = (body?.verificationMethod as { id: string; publicKeyJwk: { d?: string; x: string } }[])[0];
    expect(vm.id).toBe("did:web:shop.example#gate-signing-key");
    expect(vm.publicKeyJwk.x).toBe(credentagent.mandateKey.publicJwk.x);
    // The PRIVATE half must never appear in a document served to the world.
    expect(vm.publicKeyJwk.d).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it("mount() publishes both the public key and the issuer for a composed host", () => {
    const app = fakeApp();
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN });
    credentagent.mount(app);
    const locals = app.locals.credentagent as { mandatePublicJwk?: { x: string }; mandateIssuer?: unknown };
    expect(locals.mandatePublicJwk?.x).toBe(credentagent.mandateKey.publicJwk.x);
    // The issuer must be the SAME one the gate verifies against — a host minting under its own
    // key would produce chains this gate refuses on every path.
    expect(locals.mandateIssuer).toBe(credentagent.ap2);
  });
});

describe("signing key resolution (spec 013 decision #1)", () => {
  it("uses an injected key and does not flag it as ephemeral", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
    const credentagent = new CredentAgent({
      walletOrigin: ORIGIN,
      mandateSigningKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    });
    expect(credentagent.mandateKey.ephemeral).toBe(false);
    expect(credentagent.mandateKey.publicJwk.x).toBe(jwk.x);
  });

  it("generates an ephemeral key when none is supplied, and SAYS SO", () => {
    expect(new CredentAgent({ walletOrigin: ORIGIN }).mandateKey.ephemeral).toBe(true);
  });

  it("refuses a public JWK where a private one is required", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    expect(() => resolveSigningKey(ORIGIN, { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: "" }))
      .toThrow(/PRIVATE JWK/);
  });

  it("refuses a curve the suite does not sign with, rather than silently downgrading", () => {
    expect(() => resolveSigningKey(ORIGIN, { kty: "EC", crv: "P-384" as "P-256", x: "a", y: "b", d: "c" }))
      .toThrow(/P-256/);
  });
});

describe("#114 — a delegated spend hands back the AP2 mandate bundle", () => {
  async function authorizedGrant() {
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog: { "aurora-headphones": 199 } });
    const grant = await credentagent.grants.create({
      merchant: "Test Shop",
      budget: 500,
      perSpend: 250,
      signing: "page",
      allow: { skus: ["aurora-headphones"] },
    });
    await credentagent.grants._authorize(grant.id);
    return { credentagent, grant: await credentagent.grants.retrieve(grant.id) };
  }

  it("returns a bundle whose Payment Mandate states the amount actually drawn", async () => {
    const { credentagent, grant } = await authorizedGrant();
    const door = await grant!.spend({ idempotencyKey: "k1", items: [{ sku: "aurora-headphones" }] });
    expect(door.ok).toBe(true);
    if (!door.ok) return;

    const bundle = door.mandateBundle;
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const pay = await verifyMandate<PaymentMandate>(bundle.payment, {
      publicJwk: credentagent.mandateKey.publicJwk,
      expect: VCT.payment,
    });
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    // The engine committed in cents; the mandate must state THAT, not a catalog re-read.
    expect(pay.mandate.payment_amount.amount).toBe(Math.round(door.amount * 100));
    expect(pay.mandate.payment_amount.currency).toBe("USD");
    expect(pay.mandate.risk_data).toMatchObject({ authorization: "delegated", grantId: grant!.id });
  });

  it("the bundle's open mandates carry the constraints the human agreed to", async () => {
    const { credentagent, grant } = await authorizedGrant();
    const door = await grant!.spend({ idempotencyKey: "k2", items: [{ sku: "aurora-headphones" }] });
    if (!door.ok || !door.mandateBundle?.openPayment) throw new Error("expected an open payment mandate");

    const open = await verifyMandate<OpenPaymentMandate>(door.mandateBundle.openPayment, {
      publicJwk: credentagent.mandateKey.publicJwk,
      expect: VCT.openPayment,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    // The caps the human approved, in minor units: $250 per purchase, $500 total.
    expect(findConstraint(open.mandate.constraints, "payment.amount_range")).toMatchObject({ max: 25_000, currency: "USD" });
    expect(findConstraint(open.mandate.constraints, "payment.budget")).toMatchObject({ max: 50_000 });
    // `cnf` is the DELEGATE key — the only key that may sign a draw against this grant.
    expect(open.mandate.cnf.jwk.crv).toBe("P-256");
    // …and the payment authority names the checkout authority it belongs to.
    const ref = findConstraint(open.mandate.constraints, "payment.reference");
    expect(ref?.conditional_transaction_id).toBe(digestToken(door.mandateBundle.openCheckout!));
  });

  // The control: the bundle is EVIDENCE, not permission. Every bound was enforced before it
  // was minted, so a bundle must never appear on a refused spend — a downstream processor
  // that saw one would settle a purchase the grant refused.
  it("BYPASS: a refused spend carries no bundle at all", async () => {
    const { grant } = await authorizedGrant();
    const overCap = await grant!.spend({ idempotencyKey: "k3", items: [{ sku: "aurora-headphones", qty: 99 }] });
    expect(overCap.ok).toBe(false);
    expect((overCap as { mandateBundle?: unknown }).mandateBundle).toBeUndefined();

    const notAllowed = await grant!.spend({ idempotencyKey: "k4", items: [{ sku: "oak-whiskey" }] });
    expect(notAllowed.ok).toBe(false);
    expect((notAllowed as { mandateBundle?: unknown }).mandateBundle).toBeUndefined();
  });

  it("the whole bundle verifies as one chain", async () => {
    const { credentagent, grant } = await authorizedGrant();
    const door = await grant!.spend({ idempotencyKey: "k5", items: [{ sku: "aurora-headphones" }] });
    if (!door.ok || !door.mandateBundle) throw new Error("expected a bundle");
    // Checkout + Payment verify together; the open mandates here are issuer-signed but not yet
    // key-bound presentations (that leg is the wallet's — see MIGRATING.md), so the chain is
    // checked without an audience/nonce.
    const r = await verifyChain(
      { checkout: door.mandateBundle.checkout, payment: door.mandateBundle.payment },
      { publicJwk: credentagent.mandateKey.publicJwk },
    );
    expect(r.ok).toBe(true);
  });
});
