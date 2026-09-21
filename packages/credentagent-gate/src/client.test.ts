// The CredentAgent client — construction guards (origin binding is security-relevant)
// and the mount() store seam (per-order, never process-global).

import { describe, it, expect, vi } from "vitest";
import { CredentAgent } from "./client.js";
import { age, required, defineCredential, dcql, gate } from "./credentials.js";
import type { Credential, GateOrder } from "./types.js";
import { generateKeyPairSync } from "node:crypto";
import type { PrivateJwkP256, PublicJwkP256 } from "./ap2/keys.js";
import { verifyMandate } from "./ap2/verify.js";

const order: GateOrder = {
  id: "ORD-9",
  total: 12400,
  currency: "USD",
  lines: [{ id: "oak-whiskey", quantity: 1, unitPrice: 12400, minimumAge: 21 }],
};

describe("CredentAgent constructor", () => {
  it("works with no config — defaults walletOrigin to localhost", () => {
    const a = new CredentAgent();
    expect(a.walletOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    // empty string is treated as unset → same default
    expect(new CredentAgent({ walletOrigin: "" }).walletOrigin).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("warns (does NOT throw) on a non-absolute walletOrigin and falls back to the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new CredentAgent({ walletOrigin: "shop.example" }); // missing scheme
    expect(warn).toHaveBeenCalled();
    expect(a.walletOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    warn.mockRestore();
  });

  it("warns (does NOT throw) on a localhost origin in production, but still uses it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const a = new CredentAgent({ walletOrigin: "http://localhost:3001" });
      expect(a.walletOrigin).toBe("http://localhost:3001");
      expect(warn).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
      warn.mockRestore();
    }
  });

  it("accepts an absolute origin and trims a trailing slash", () => {
    const a = new CredentAgent({ walletOrigin: "https://shop.example/" });
    expect(a.walletOrigin).toBe("https://shop.example");
  });

  it("delegates requirements() to the resolver (bound to its walletOrigin)", () => {
    const a = new CredentAgent({ walletOrigin: "https://shop.example" });
    const m = a.requirements(order, [required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null)))]);
    const ageEntry = m.find((e) => e.credential === "age");
    expect(ageEntry?.approveUrl).toContain("https://shop.example/credential-gate/age");
    expect(ageEntry?.approveUrl).toContain("ORD-9");
  });
});

describe("CredentAgent.mount", () => {
  it("exposes the per-order store on app.locals and is idempotent", () => {
    const a = new CredentAgent({ walletOrigin: "https://shop.example" });
    const app = { locals: {} as Record<string, unknown> };
    a.mount(app);
    a.mount(app); // idempotent — no throw, same store
    expect((app.locals.credentagent as { store?: unknown }).store).toBe(a.store);
  });

  it("two clients keep distinct stores (no cross-instance bleed)", () => {
    const a = new CredentAgent({ walletOrigin: "https://a.example" });
    const b = new CredentAgent({ walletOrigin: "https://b.example" });
    expect(a.store).not.toBe(b.store);
  });
});

// Regression (PR #42 review — item 5). register-on-resolve populates the credential registry
// only when requirements() runs. A serverless / multi-worker completion instance may never run
// it (checkout ran elsewhere), leaving the registry empty so the completion sweep no-ops — an
// applicable custom gate() checks out UNPROVEN (fail-OPEN). Declaring credentials up front
// populates the registry at construction, so EVERY instance enforces the gate from boot.
describe("CredentAgent — eager credential registration (item 5, cold-instance fail-open)", () => {
  const prescription = defineCredential({
    id: "prescription",
    request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
    verify: (c) => c.rx_valid === true,
    effect: gate(),
    ui: { label: "Prescription", action: "Verify prescription" },
  });
  const registryOf = (agent: CredentAgent): ReadonlyMap<string, Credential> | undefined => {
    const app = { locals: {} as Record<string, unknown> };
    agent.mount(app); // publishes the registry onto app.locals.credentagent
    return (app.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential> }).credentialRegistry;
  };

  it("registers credentials passed at construction — before any requirements() call", () => {
    const agent = new CredentAgent({ credentials: [prescription] });
    expect(registryOf(agent)?.get("prescription")).toBe(prescription);
  });

  it("without declaring them, a fresh instance's registry has no custom gate until requirements() runs", () => {
    expect(registryOf(new CredentAgent())?.get("prescription")).toBeUndefined();
  });
});

// The AP2 mandate-signing key and its publication (spec 013). Without a published public key
// the signature is checkable only by us, which would make "real signatures" a hollow claim.
describe("the published mandate key", () => {
  function p256Jwk(): PrivateJwkP256 {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;
  }

  /** A minimal Express stand-in that records the GET routes something registers on it. */
  function appWithRoutes() {
    const routes = new Map<string, (req: unknown, res: { json: (b: unknown) => void }) => void>();
    return {
      locals: {} as Record<string, unknown>,
      get: (path: string, handler: (req: unknown, res: { json: (b: unknown) => void }) => void) => routes.set(path, handler),
      routes,
    };
  }

  function bodyOf(app: ReturnType<typeof appWithRoutes>, path: string): Record<string, unknown> | undefined {
    const handler = app.routes.get(path);
    if (!handler) return undefined;
    let body: Record<string, unknown> | undefined;
    handler({}, { json: (b) => (body = b as Record<string, unknown>) });
    return body;
  }

  it("serves a DID document whose id matches the issuer, and never the private half", () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example", mandateSigningKey: p256Jwk() });
    const app = appWithRoutes();
    credentagent.mount(app as never);

    const doc = bodyOf(app, "/.well-known/did.json");
    expect(doc, "mount() must serve /.well-known/did.json").toBeDefined();
    expect(doc?.id).toBe("did:web:shop.example");
    expect(credentagent.ap2.issuer).toBe("did:web:shop.example");
    expect(JSON.stringify(doc)).not.toContain('"d"');
  });

  // mount() has three branches (seams, composed-host, legacy) and every one of them must publish
  // the key — a mandate whose key is unreachable on two of three mounting styles is not verifiable.
  it("publishes the key on the composed-host branch too", () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example", mandateSigningKey: p256Jwk() });
    const app = appWithRoutes();
    app.locals.credentagent = { orderStore: {}, catalog: {}, completion: () => {}, signingKey: "s".repeat(32) };
    credentagent.mount(app as never);
    expect(bodyOf(app, "/.well-known/did.json")?.id).toBe("did:web:shop.example");
  });

  it("mints with the key it published, and that mandate verifies against it", async () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example", mandateSigningKey: p256Jwk() });
    const minted = await credentagent.ap2.payment({
      transactionId: "tx-1",
      payee: { name: "Shop", merchant_id: "shop-1" },
      amount: { amount: 12400, currency: "USD" },
      instrument: { type: "card", display_name: "Visa ••4242" },
    });
    const app = appWithRoutes();
    credentagent.mount(app as never);

    const doc = bodyOf(app, "/.well-known/did.json") as { verificationMethod: Array<{ publicKeyJwk: PublicJwkP256 }> };
    const published = doc.verificationMethod[0].publicKeyJwk;
    const verdict = await verifyMandate(minted.token, { publicJwk: published });
    expect(verdict.ok, "a mandate must verify against the key the gate publishes").toBe(true);
  });
});

// The public surface is a boundary, not a convenience. A caller that can reach the raw signer
// or the SD-JWT instance can build a second verification door — which is the exact shape
// `verifyMandate` replaced, and the one that failed open because nobody re-read it.
describe("the AP2 public surface", () => {
  it("publishes mint-and-verify but not the crypto layer under it", async () => {
    const api = await import("./index.js");

    expect(api).toHaveProperty("Ap2Issuer");
    expect(api).toHaveProperty("verifyMandate");
    expect(api).toHaveProperty("openCheckoutPayload");
    expect(api).toHaveProperty("toMinorUnits");
    expect(api).toHaveProperty("didDocument");

    for (const internal of ["sdJwtInstance", "es256Signer", "es256Verifier", "es256Verify", "cnfKbVerifier", "signCompactJwt", "verifyCompactJwt", "digestToken"]) {
      expect(api, `${internal} must stay internal`).not.toHaveProperty(internal);
    }
  });
});
