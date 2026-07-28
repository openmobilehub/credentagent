// Bypass/contract tests for the GENERALIZED credential rail (007, US1): a CUSTOM
// credential defined by `defineCredential` completes on the mounted ceremony with no
// new code path. Every assertion pins a control and FAILS if that control is removed:
//   • the signed request embeds the credential's OWN doctype + claim (not age/membership);
//   • verify runs the credential's OWN `verify` (explicit positive claim — invariant 5)
//     and records `verifiedGates[id]` per order (invariant 4); a negative claim records
//     nothing;
//   • an unregistered / reserved id is refused (404 — FR-013), never served;
//   • every custom surface states trust_level "presence-only-demo" (Principle VII / F4).
//
// The verify path exercised is the instant-demo claims path (the acceptance bar); the
// real OpenID4VP/mdoc presentation shares the same `verify` and is threaded the credential.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { mountCeremony, type CeremonySeams } from "../mount.js";
import { MemoryVerificationStore } from "../../store.js";
import type { Credential } from "../../types.js";
import { defineCredential, dcql, gate } from "../../credentials.js";
import { professionalLicense } from "./__fixtures__/customCredential.js";
import type { CeremonyCatalog, CeremonyOrder } from "../types.js";

// A Licensed line makes the custom gate applicable; headphones is unrestricted.
const PRODUCTS: Record<string, { price: number; category?: string }> = {
  "contractor-drill": { price: 150, category: "Licensed" },
  "aurora-headphones": { price: 199 },
};

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return {
        id: it.productId,
        name: it.productId,
        unitPrice: p.price,
        currency: "USD",
        quantity: it.quantity,
        lineTotal: p.price * it.quantity,
        ...(p.category ? { category: p.category } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount: 0, total: subtotal, currency: "USD", createdAt: new Date().toISOString() };
  },
};

// The worked pack (professional-license gate()) comes from the shared fixture (T002).
function harness(extra: Credential[] = []) {
  const verificationStore = new MemoryVerificationStore();
  const orders = new Map<string, CeremonyOrder>();
  const registry = new Map<string, Credential>([[professionalLicense.id, professionalLicense], ...extra.map((c) => [c.id, c] as const)]);
  const seams: CeremonySeams = {
    verificationStore,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: "stable-test-secret",
    credentialRegistry: registry,
  };
  const app = express();
  mountCeremony(app as never, seams);
  const seed = (id: string, items: { id: string; quantity: number }[]): void => {
    orders.set(id, catalog.createOrder(items.map((i) => ({ productId: i.id, quantity: i.quantity })), id));
  };
  return { app, verificationStore, seed };
}

describe("US1 — the ceremony serves a custom credential's own request (no new code path)", () => {
  it("the signed request embeds the credential's OWN doctype + claim (not an age/membership shape)", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential/request").query({ order: "ORD-L", cred: "professional_license" });
    expect(res.status).toBe(200);
    // The OpenID4VP DCQL is the credential's own request — its doctype + claim leaf.
    expect(res.body.dcql_query.credentials[0].meta.doctype_value).toBe("org.example.license.1");
    const paths = res.body.dcql_query.credentials[0].claims.map((c: { path: string[] }) => c.path[c.path.length - 1]);
    expect(paths).toContain("license_active");
    // Both wallet protocols offered, fenced presence-only-demo (F4).
    expect(res.body.requests.map((r: { protocol: string }) => r.protocol)).toContain("org-iso-mdoc");
    expect(res.body.trust_level).toBe("presence-only-demo");
  });

  it("renders the gate page from the credential's ui, fenced presence-only-demo", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "professional_license" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Professional license");
    expect(res.text).toContain("presence-only-demo");
  });
});

describe("US1 — verify runs the credential's OWN verify and records verifiedGates (invariants 4/5)", () => {
  it("an explicit positive claim verifies and writes verifiedGates[id] for THIS order", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-L", cred: "professional_license", claims: { license_active: true } });
    expect(res.body.verified).toBe(true);
    expect(res.body.trust_level).toBe("presence-only-demo"); // F4
    expect((await h.verificationStore.read("ORD-L"))?.verifiedGates?.professional_license).toBe(true);
  });

  it("a NEGATIVE claim does not verify and records NOTHING (control fails if verify accepted mere presence)", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-L", cred: "professional_license", claims: { license_active: false } });
    expect(res.body.verified).toBe(false);
    expect((await h.verificationStore.read("ORD-L"))?.verifiedGates?.professional_license).toBeUndefined();
  });

  it("an absent claim (a bare token) does not pass", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-L", cred: "professional_license", claims: { some_unrelated: "x" } });
    expect(res.body.verified).toBe(false);
  });
});

// #59 finding 5 (DX): the instant-demo button synthesizes boolean-`true` for every requested claim
// leaf, so it can only prove a credential whose `verify` accepts that. For a credential whose verify
// checks a NON-boolean claim, the demo silently failed with a bare "not verified". The fix fences the
// button off and explains why, so the buyer reaches for the real wallet instead of a broken tap.
describe("US1 — finding 5: the instant-demo is fenced when a credential needs a non-boolean claim", () => {
  const stringLicense = defineCredential({
    id: "string_license",
    request: dcql({ docType: "org.example.license.2", claims: ["license_no"] }),
    verify: (c) => typeof c.license_no === "string" && c.license_no.length > 0, // NON-boolean claim
    effect: gate(),
    appliesTo: (order) => order.lines.some((l) => l.category === "Licensed"),
    ui: { label: "License number", action: "Enter your license number" },
  });

  it("disables the demo button with a clear note (a boolean demo can't synthesize a string claim)", async () => {
    const h = harness([stringLicense]);
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "string_license" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/id="go"[^>]*disabled/); // the instant-demo button is disabled…
    expect(res.text).toContain("instant demo isn't available"); // …and the page says why
  });

  it("control: a boolean-claim credential keeps its working instant-demo button (not over-fenced)", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "professional_license" });
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/id="go"[^>]*disabled/); // professional_license verifies boolean true → demo works
  });

  // PR #131 review (P2): when the demo is fenced AND the browser lacks the Digital Credentials API,
  // both buttons are disabled — the page must NOT tell the user to use the other (disabled) button.
  // The unsupported-browser guidance is driven by DEMO_AVAILABLE, which the page wires per credential.
  it("#131: the demo-fenced page wires DEMO_AVAILABLE=false so an unsupported browser gets a coherent path", async () => {
    const h = harness([stringLicense]);
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "string_license" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("const DEMO_AVAILABLE = false"); // drives the no-wallet + no-demo branch
    // The coherent recovery message points at a supported DEVICE, never at the disabled demo button.
    expect(res.text).toContain("Open this page on a supported device");
  });

  it("control: a boolean-claim credential wires DEMO_AVAILABLE=true (the demo stays a valid fallback)", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "professional_license" });
    expect(res.text).toContain("const DEMO_AVAILABLE = true");
  });
});

describe("US1 — an unregistered or reserved credential id is refused (FR-013)", () => {
  it("the page + request routes 404 an unknown id", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    expect((await request(h.app).get("/credentagent/credential").query({ order: "ORD-L", cred: "not_registered" })).status).toBe(404);
    expect((await request(h.app).get("/credentagent/credential/request").query({ order: "ORD-L", cred: "not_registered" })).status).toBe(404);
  });

  it("the verify route refuses an unknown id (404), recording nothing", async () => {
    const h = harness();
    h.seed("ORD-L", [{ id: "contractor-drill", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-L", cred: "not_registered", claims: { license_active: true } });
    expect(res.status).toBe(404);
    expect(res.body.verified).toBe(false);
  });
});
