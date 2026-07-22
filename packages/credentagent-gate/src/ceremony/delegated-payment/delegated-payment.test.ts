// Bypass tests for the delegated rail's request half (008, #86).
//
// The load-bearing ones are the reference-token tests: the browser carries that token
// between /request and the (future) /verify, so if it were not bound to its order and
// tamper-evident, one buyer's verification would redeem another's checkout (invariant 4).
// Each refusal test is paired with a control asserting the UNMODIFIED token still opens,
// so a passing test proves the specific check fired — not that everything is broken.
//
// Delete the order-id comparison in openReference and "refuses a token minted for a
// DIFFERENT order" goes red. Delete the timingSafeEqual signature check and the tamper
// tests go red.

import { describe, it, expect, vi } from "vitest";
import { MemoryVerificationStore } from "../../store.js";
import { age, payment, membership, defineCredential, gate, dcql } from "../../credentials.js";
import type { Credential } from "../../types.js";
import { mountCeremony, type CeremonyApp, type CeremonySeams } from "../mount.js";
import type { CeremonyCatalog, DelegatedVerifier } from "../types.js";
import { sealReference, openReference } from "./referenceToken.js";
import { mergeDelegatedDcql, delegatedPolicyEntries } from "./dcql.js";

const SECRET = "stable-test-secret";

// ── Fixtures ────────────────────────────────────────────────────────────────

const PRICES: Record<string, number> = { "oak-whiskey": 124, "aurora-headphones": 199 };
const MIN_AGE: Record<string, number> = { "oak-whiskey": 21 };

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const unitPrice = PRICES[it.productId] ?? 0;
      return {
        id: it.productId, name: it.productId, unitPrice, currency: "USD",
        quantity: it.quantity, lineTotal: unitPrice * it.quantity,
        ...(MIN_AGE[it.productId] ? { minimumAge: MIN_AGE[it.productId] } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};

/** A verifier stub. Deliberately controllable — that is the point: #87's bypass tests
 *  need to inject one that MISBEHAVES to prove the gate refuses it. */
function stubVerifier(over: Partial<DelegatedVerifier> = {}): DelegatedVerifier {
  return {
    buildRequest: vi.fn(async () => ({ reference: "verifier-ref-1", handoff: { verifierUrl: "https://verifier.example" } })),
    consume: vi.fn(async () => ({
      approved: true, trust_level: "issuer-verified" as const, claims: {},
      binding: { amount: 124, currency: "USD" },
    })),
    ...over,
  };
}

interface RouteApp extends CeremonyApp {
  routes: string[];
  handlers: Map<string, (req: never, res: never) => unknown>;
}

function routeApp(): RouteApp {
  const routes: string[] = [];
  const handlers = new Map<string, (req: never, res: never) => unknown>();
  const record = (verb: string) => (path: string, ...hs: unknown[]) => {
    routes.push(`${verb} ${path}`);
    handlers.set(`${verb} ${path}`, hs[0] as (req: never, res: never) => unknown);
  };
  return { locals: {}, routes, handlers, get: record("GET"), post: record("POST"), use: record("USE") };
}

function seams(over: Partial<CeremonySeams> = {}): CeremonySeams {
  return {
    verificationStore: new MemoryVerificationStore(),
    orderStore: { read: async (id) => ({ id, lines: [{ id: "oak-whiskey", quantity: 1, unitPrice: 124, lineTotal: 124 }], subtotal: 124, discount: 0, total: 124, currency: "USD" }) },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: SECRET,
    ...over,
  };
}

// Minimal res double capturing what a handler sent.
function resDouble() {
  const out: { code: number; body?: unknown; html?: string } = { code: 200 };
  const res = {
    status(c: number) { out.code = c; return res; },
    type() { return res; },
    send(b: string) { out.html = b; return res; },
    json(b: unknown) { out.body = b; return res; },
  };
  return { res, out };
}

// ── Reference token: the load-bearing bypass tests ──────────────────────────

describe("delegated rail — reference token binding (invariant 4)", () => {
  it("opens an unmodified token for the order it was minted for (control)", () => {
    const token = sealReference({ reference: "ref-A", orderId: "ORD-A" }, SECRET);
    expect(openReference(token, "ORD-A", SECRET)).toEqual({ reference: "ref-A", orderId: "ORD-A" });
  });

  it("REFUSES a token minted for a DIFFERENT order (cross-order redemption)", () => {
    const token = sealReference({ reference: "ref-A", orderId: "ORD-A" }, SECRET);
    // The exact bleed this prevents: buyer A's verification unlocking buyer B's checkout.
    expect(() => openReference(token, "ORD-B", SECRET)).toThrow(/not bound to this order/);
    // Control: the same token still opens for its own order, so the refusal above was
    // the order binding — not a malformed token.
    expect(() => openReference(token, "ORD-A", SECRET)).not.toThrow();
  });

  it("REFUSES a tampered payload (order id swapped in the clear)", () => {
    const token = sealReference({ reference: "ref-A", orderId: "ORD-A" }, SECRET);
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.orderId = "ORD-B";
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${sig}`;
    expect(() => openReference(forged, "ORD-B", SECRET)).toThrow(/bad reference signature/);
  });

  it("REFUSES a token sealed under a different signing key", () => {
    const token = sealReference({ reference: "ref-A", orderId: "ORD-A" }, "attacker-secret");
    expect(() => openReference(token, "ORD-A", SECRET)).toThrow(/bad reference signature/);
  });

  it("REFUSES an expired token", () => {
    const token = sealReference({ reference: "ref-A", orderId: "ORD-A" }, SECRET, -1);
    expect(() => openReference(token, "ORD-A", SECRET)).toThrow(/expired/);
  });

  it("REFUSES a malformed token rather than partially trusting it", () => {
    for (const bad of ["", "nodot", "a.b.c"]) {
      expect(() => openReference(bad, "ORD-A", SECRET)).toThrow();
    }
  });
});

// ── DCQL merge ──────────────────────────────────────────────────────────────

describe("delegated rail — combined DCQL merge", () => {
  it("namespaces ids by policy credential, so payment and membership no longer collide (#90)", () => {
    // Both builders derive the DCQL id from the doctype's last segment → "1" for each.
    expect(payment.in("usd").request.credentials[0].id).toBe(membership.discount(10).request.credentials[0].id);

    const merged = mergeDelegatedDcql([
      { credentialId: "payment", query: payment.in("usd").request },
      { credentialId: "membership", query: membership.discount(10).request },
    ]);
    const ids = merged.credentials.map((c) => c.id);
    expect(ids).toEqual(["payment", "membership"]);
    expect(new Set(ids).size).toBe(ids.length); // unique — the property #90 breaks
  });

  it("preserves a source query's alternatives as its own credential_set, remapped", () => {
    // age.over(21) is mDL OR EU-PID — that OR must survive the merge, or the wallet is
    // asked to hold BOTH.
    const merged = mergeDelegatedDcql([
      { credentialId: "age", query: age.over(21).request },
      { credentialId: "payment", query: payment.in("usd").request },
    ]);
    expect(merged.credentials.map((c) => c.id)).toEqual(["age_mdl", "age_eupid", "payment"]);
    expect(merged.credential_sets).toEqual([
      { options: [["age_mdl"], ["age_eupid"]] }, // still an OR
      { options: [["payment"]] },                 // explicit, not implicit AND
    ]);
  });

  it("always emits credential_sets — never leaves the implicit AND-everything default", () => {
    // Without sets, DCQL requires EVERY entry; a merged query that omitted them would
    // silently demand the wallet hold every credential at once.
    const merged = mergeDelegatedDcql([{ credentialId: "payment", query: payment.in("usd").request }]);
    expect(merged.credential_sets).toBeDefined();
    expect(merged.credential_sets!.length).toBeGreaterThan(0);
  });
});

describe("delegated rail — which credentials are presented", () => {
  const order = catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-1");

  function registry(...creds: Credential[]): ReadonlyMap<string, Credential> {
    return new Map(creds.map((c) => [c.id, c]));
  }

  it("includes blocking gate() + authorize() credentials and puts payment last", () => {
    const entries = delegatedPolicyEntries(registry(payment.in("usd"), age.over(21)), order);
    expect(entries.map((e) => e.credentialId)).toEqual(["age", "payment"]);
  });

  it("EXCLUDES a discount credential — a benefit must not become a demand", () => {
    const entries = delegatedPolicyEntries(registry(membership.discount(10), payment.in("usd")), order);
    expect(entries.map((e) => e.credentialId)).toEqual(["payment"]);
  });

  it("drops a custom gate whose appliesTo is false for the RE-PRICED order (invariant 2)", () => {
    const rx = defineCredential({
      id: "prescription",
      request: dcql({ docType: "org.example.rx.1", claims: ["rx_valid"] }),
      verify: (c) => c.rx_valid === true,
      effect: gate(),
      appliesTo: (o) => o.lines.some((l) => l.requiresRx === true),
      ui: { label: "Prescription", action: "Present your prescription" },
    });
    // No line is requiresRx, so it must not be demanded.
    expect(delegatedPolicyEntries(registry(rx), order)).toEqual([]);
  });

  it("returns nothing when no registry was threaded (additive, never throws)", () => {
    expect(delegatedPolicyEntries(undefined, order)).toEqual([]);
  });
});

// ── Rail registration + the request route ───────────────────────────────────

describe("delegated rail — registration is opt-in", () => {
  it("registers NO delegated route when no verifier is configured (byte-unchanged)", () => {
    const app = routeApp();
    mountCeremony(app, seams());
    expect(app.routes.filter((r) => r.includes("/credentagent/delegated"))).toEqual([]);
  });

  it("registers the page + request routes when a verifier IS configured", () => {
    const app = routeApp();
    mountCeremony(app, seams({ verifier: stubVerifier() }));
    expect(app.routes).toContain("GET /credentagent/delegated");
    expect(app.routes).toContain("GET /credentagent/delegated/request");
  });

  it("does NOT register a verify route yet — an unenforcing completion path must not exist (#87)", () => {
    const app = routeApp();
    mountCeremony(app, seams({ verifier: stubVerifier() }));
    // Fail-closed by absence: until the non-delegable re-checks land, a POST /verify
    // that recorded a completion would be a fail-open surface.
    expect(app.routes).not.toContain("POST /credentagent/delegated/verify");
  });
});

describe("delegated rail — GET /request", () => {
  async function callRequest(verifier: DelegatedVerifier, orderId = "ORD-1") {
    const app = routeApp();
    mountCeremony(app, seams({ verifier }));
    const handler = app.handlers.get("GET /credentagent/delegated/request")!;
    const { res, out } = resDouble();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { query: { order: orderId }, headers: { host: "shop.example" }, protocol: "https" },
      res,
    );
    return out;
  }

  it("binds the amount the CATALOG re-derives, not anything the caller supplies", async () => {
    const verifier = stubVerifier();
    await callRequest(verifier);
    const arg = (verifier.buildRequest as unknown as { mock: { calls: [{ binding: { amount: number; currency: string; payee: { id: string } } }][] } }).mock.calls[0][0];
    expect(arg.binding.amount).toBe(124); // oak-whiskey, priced server-side
    expect(arg.binding.currency).toBe("USD");
    // Payee is re-derived from THIS request's origin (invariant 6), not the adapter.
    expect(arg.binding.payee.id).toBe("shop.example");
  });

  it("returns a reference token bound to THIS order", async () => {
    const out = await callRequest(stubVerifier());
    const body = out.body as { referenceToken: string; protocol: string; handoff: unknown };
    expect(body.protocol).toBe("delegated-openid4vp");
    expect(openReference(body.referenceToken, "ORD-1", SECRET).reference).toBe("verifier-ref-1");
    expect(() => openReference(body.referenceToken, "ORD-OTHER", SECRET)).toThrow();
  });

  it("does not announce a trust level before anything has been verified (Principle VII)", async () => {
    const out = await callRequest(stubVerifier());
    // Trust on this rail is whatever the EXTERNAL verifier reports at /verify. Claiming
    // one here would be unbacked.
    expect(out.body).not.toHaveProperty("trust_level");
  });

  it("404s an unknown order rather than minting a request for it (invariant 2)", async () => {
    const app = routeApp();
    mountCeremony(app, seams({ orderStore: { read: async () => null }, verifier: stubVerifier() }));
    const handler = app.handlers.get("GET /credentagent/delegated/request")!;
    const { res, out } = resDouble();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { query: { order: "NOPE" }, headers: { host: "shop.example" }, protocol: "https" },
      res,
    );
    expect(out.code).toBe(404);
  });
});
