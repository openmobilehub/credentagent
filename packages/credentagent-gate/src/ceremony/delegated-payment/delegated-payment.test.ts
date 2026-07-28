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
import type { CeremonyCatalog, CeremonyOrderStore, CompletionInput, CompletionResult, DelegatedVerdict, DelegatedVerifier } from "../types.js";
import { completeOrder, type CompletedRecord } from "../completion.js";
import { sealReference, openReference } from "./referenceToken.js";
import { mergeDelegatedDcql, delegatedPolicyEntries } from "./dcql.js";
import { issueCartMandate } from "../cartMandate.js";
import { renderDelegatedPage } from "./page.js";
import { buildDelegatedRequest } from "./request.js";

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

    const { query, idMap } = mergeDelegatedDcql([
      { credentialId: "payment", query: payment.in("usd").request },
      { credentialId: "membership", query: membership.discount(10).request },
    ]);
    const ids = query.credentials.map((c) => c.id);
    expect(ids).toEqual(["payment", "membership"]);
    expect(new Set(ids).size).toBe(ids.length); // unique — the property #90 breaks
    // The id map routes each merged id back to its policy credential (used at /verify).
    expect(idMap.get("payment")).toBe("payment");
    expect(idMap.get("membership")).toBe("membership");
  });

  it("preserves a source query's alternatives as its own credential_set, remapped", () => {
    // age.over(21) is mDL OR EU-PID — that OR must survive the merge, or the wallet is
    // asked to hold BOTH.
    const { query, idMap } = mergeDelegatedDcql([
      { credentialId: "age", query: age.over(21).request },
      { credentialId: "payment", query: payment.in("usd").request },
    ]);
    expect(query.credentials.map((c) => c.id)).toEqual(["age_mdl", "age_eupid", "payment"]);
    expect(query.credential_sets).toEqual([
      { options: [["age_mdl"], ["age_eupid"]] }, // still an OR
      { options: [["payment"]] },                 // explicit, not implicit AND
    ]);
    // Both age documents map back to the ONE policy credential `age`.
    expect(idMap.get("age_mdl")).toBe("age");
    expect(idMap.get("age_eupid")).toBe("age");
  });

  it("always emits credential_sets — never leaves the implicit AND-everything default", () => {
    // Without sets, DCQL requires EVERY entry; a merged query that omitted them would
    // silently demand the wallet hold every credential at once.
    const { query } = mergeDelegatedDcql([{ credentialId: "payment", query: payment.in("usd").request }]);
    expect(query.credential_sets).toBeDefined();
    expect(query.credential_sets!.length).toBeGreaterThan(0);
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

  it("registers the page + request + verify routes when a verifier IS configured", () => {
    const app = routeApp();
    mountCeremony(app, seams({ verifier: stubVerifier() }));
    expect(app.routes).toContain("GET /credentagent/delegated");
    expect(app.routes).toContain("GET /credentagent/delegated/request");
    // The verify route now exists (#87) — and carries the non-delegable re-checks below.
    expect(app.routes).toContain("POST /credentagent/delegated/verify");
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

// ── S3 (#87): the completion leg — the non-delegable re-checks ────────────────
//
// These run POST /verify through the REAL `completeOrder`, so the enforcement is the
// production path, not a stand-in. The bypass tests each PROVE the gate refuses a
// MISBEHAVING verifier — which is only expressible because the seam is injectable (a
// correct verifier never returns a wrong-amount approval). Crucially, every refusal also
// asserts `verifier.settle` was NOT called: money must not move when the gate refuses.

/** A verifier whose verdict + settlement are fully controllable, with spies so a test can
 *  assert what the gate did and did NOT call. The default is a valid whiskey verdict. */
function verifierReturning(over: Partial<DelegatedVerdict> = {}, settleImpl?: () => unknown): DelegatedVerifier {
  return {
    buildRequest: vi.fn(async () => ({ reference: "ref-1", handoff: {} })),
    consume: vi.fn(
      async (): Promise<DelegatedVerdict> => ({
        approved: true,
        trust_level: "issuer-verified",
        claims: { age_mdl: { age_over_21: true }, payment: { issuer_name: "Bank", holder_name: "Jo" } },
        binding: { amount: 124, currency: "USD", payee: { id: "shop.example" } },
        ...over,
      }),
    ),
    settle: vi.fn(async () => (settleImpl ? (settleImpl() as { network: string; txId: string; status: string }) : { network: "test-processor", txId: "tx_1", status: "settled" })),
  };
}

const tokenFor = (orderId: string, reference = "ref-1") => sealReference({ reference, orderId }, SECRET);

interface CompletingHarness {
  verify(body: Record<string, unknown>): Promise<{ code: number; body?: unknown }>;
  records: Map<string, CompletedRecord>;
  verification: MemoryVerificationStore;
  verifier: DelegatedVerifier;
}

/** Wire POST /verify to the REAL completeOrder over in-memory stores + the given policy.
 *  `stateless: true` mounts FR-007 mode with an order store that THROWS on read, so any
 *  test that passes also proves the order came from the signed cart mandate alone. */
function harness(
  policy: Credential[],
  verifier: DelegatedVerifier,
  items: { productId: string; quantity: number }[] = [{ productId: "oak-whiskey", quantity: 1 }],
  opts: { stateless?: boolean } = {},
): CompletingHarness {
  const verification = new MemoryVerificationStore();
  const records = new Map<string, CompletedRecord>();
  const registry = new Map(policy.map((c) => [c.id, c] as const));
  const orderStore: CeremonyOrderStore = opts.stateless
    ? { read: async () => { throw new Error("orderStore must NOT be read under statelessOrders"); } }
    : { read: async (id) => catalog.createOrder(items, id) };
  const completion = (input: CompletionInput): Promise<CompletionResult> =>
    completeOrder(input, {
      catalog,
      verificationStore: verification,
      records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) },
      credentialRegistry: registry,
      signingKey: SECRET,
    });
  const app = routeApp();
  mountCeremony(app, { verificationStore: verification, orderStore, catalog, completion, signingKey: SECRET, credentialRegistry: registry, verifier, ...(opts.stateless ? { statelessOrders: true } : {}) });
  const handler = app.handlers.get("POST /credentagent/delegated/verify")!;
  return {
    records,
    verification,
    verifier,
    async verify(body) {
      const { res, out } = resDouble();
      await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
        { query: {}, headers: { host: "shop.example" }, protocol: "https", body },
        res,
      );
      return out;
    },
  };
}

describe("delegated rail — POST /verify happy path", () => {
  it("approved + correct binding + age_over_21 + payment → records, relays trust, settles once", async () => {
    const verifier = verifierReturning();
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    const body = out.body as { completed: boolean; trust_level: string; settlement?: unknown };
    expect(body.completed).toBe(true);
    expect(body.trust_level).toBe("issuer-verified");
    expect(verifier.settle).toHaveBeenCalledTimes(1); // settlement is gate-authorized, and it fired
    const rec = h.records.get("ORD-1")!;
    expect(rec.method).toBe("delegated");
    expect(rec.amount).toBe(124);
    expect(rec.trustLevel).toBe("issuer-verified"); // relayed onto the record (FR-008)
    expect(rec.settlement).toBeTruthy();
    // per-order verification cleared on completion (invariant 4)
    expect(await h.verification.read("ORD-1")).toBeUndefined();
  });
});

describe("delegated rail — POST /verify bypass tests (each refusal must also NOT settle)", () => {
  it("REFUSES a verdict binding the WRONG AMOUNT — money does not move (invariant 2/3)", async () => {
    const verifier = verifierReturning({ binding: { amount: 1, currency: "USD", payee: { id: "shop.example" } } });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean }).completed).toBe(false);
    expect(h.records.get("ORD-1")).toBeUndefined();
    expect(verifier.settle).not.toHaveBeenCalled();
  });

  it("REFUSES a verdict binding a FOREIGN PAYEE (invariant 6)", async () => {
    const verifier = verifierReturning({ binding: { amount: 124, currency: "USD", payee: { id: "attacker.example" } } });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean }).completed).toBe(false);
    expect(verifier.settle).not.toHaveBeenCalled();
  });

  it("REFUSES when the verifier APPROVED but only 18+ was disclosed on a 21+ cart (invariant 1/5)", async () => {
    // The killer case, and the whole reason settlement is gate-authorized: the reference
    // verifier's own age rule passes at 18+, so it can APPROVE what our 21+ policy rejects.
    const verifier = verifierReturning({ approved: true, claims: { age_mdl: { age_over_18: true }, payment: {} } });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    const body = out.body as { completed: boolean; reason?: string };
    expect(body.completed).toBe(false);
    expect(body.reason).toBe("age");
    expect(verifier.settle).not.toHaveBeenCalled(); // refused BEFORE settlement
    // Control: the SAME shape but proving 21+ completes — so the refusal above was the age
    // policy, not an unrelated failure.
    const ok = harness([payment.in("usd"), age.over(21)], verifierReturning());
    expect(((await ok.verify({ order: "ORD-2", referenceToken: tokenFor("ORD-2") })).body as { completed: boolean }).completed).toBe(true);
  });

  it("REFUSES when the verifier did NOT approve", async () => {
    const verifier = verifierReturning({ approved: false, reason: "card not from a trusted issuer" });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean }).completed).toBe(false);
    expect(verifier.settle).not.toHaveBeenCalled();
  });

  // BYPASS (invariant 5 — load-bearing): a REFUSED verdict must write NO verification state.
  // A realistic adapter parses the disclosed claims BEFORE its trust check (Multipaz parses,
  // then TrustManager.verify fails), so `approved: false` can still carry `age_over_21: true`
  // — exactly what this fixture's default claims do. That state is read by EVERY completion
  // path (completeOrder's age sweep), so writing it here would leave the order marked
  // age-verified: the delegated verify is correctly refused, but the buyer could then complete
  // the SAME order through the passkey / place-order path on the strength of a claim the
  // verifier explicitly refused to vouch for. Delete the `verdict.approved === true` guard in
  // routes.ts and this goes red.
  it("writes NO age proof when the verifier did not approve (no cross-path bleed)", async () => {
    const verifier = verifierReturning({ approved: false, reason: "card not from a trusted issuer" });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean }).completed).toBe(false);
    // The refused presentment's claims must never become this order's age proof.
    expect((await h.verification.read("ORD-1"))?.ageVerified).not.toBe(true);
  });

  it("REFUSES (400) a reference token minted for ANOTHER order — never even fetches a verdict (invariant 4)", async () => {
    const verifier = verifierReturning();
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-OTHER") });
    expect(out.code).toBe(400);
    expect(verifier.consume).not.toHaveBeenCalled();
    expect(verifier.settle).not.toHaveBeenCalled();
  });

  it("REFUSES an age-restricted order whose policy carries no age credential — no age proof written", async () => {
    // Payment-only policy on a 21+ cart: applyDelegatedPolicy writes no ageVerified, so the
    // shared age sweep refuses. Guards against the delegated path skipping the age gate.
    const verifier = verifierReturning({ claims: { payment: {} } });
    const h = harness([payment.in("usd")], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean; reason?: string }).reason).toBe("age");
    expect(verifier.settle).not.toHaveBeenCalled();
  });

  it("enforces a custom gate() credential over the disclosed claims (invariant 1)", async () => {
    const rx = defineCredential({
      id: "prescription",
      request: dcql({ docType: "org.example.rx.1", claims: ["rx_valid"] }),
      verify: (c) => c.rx_valid === true,
      effect: gate(),
      ui: { label: "Prescription", action: "Present your prescription" },
    });
    const items = [{ productId: "aurora-headphones", quantity: 1 }]; // no age, isolates the custom gate
    const bindingHp = { amount: 199, currency: "USD", payee: { id: "shop.example" } };
    // rx not disclosed → refused with reason "gate", no settle
    const bad = verifierReturning({ binding: bindingHp, claims: { payment: {} } });
    const h1 = harness([payment.in("usd"), rx], bad, items);
    expect(((await h1.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") })).body as { reason?: string }).reason).toBe("gate");
    expect(bad.settle).not.toHaveBeenCalled();
    // rx_valid disclosed true → completes
    const good = verifierReturning({ binding: bindingHp, claims: { prescription: { rx_valid: true }, payment: {} } });
    const h2 = harness([payment.in("usd"), rx], good, items);
    expect(((await h2.verify({ order: "ORD-2", referenceToken: tokenFor("ORD-2") })).body as { completed: boolean }).completed).toBe(true);
  });
});

describe("delegated rail — settlement gating + trust honesty", () => {
  it("a settlement failure is authorized-but-not-settled: no record (FR-013)", async () => {
    const verifier = verifierReturning({}, () => { throw new Error("processor down"); });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    const body = out.body as { completed: boolean; settlementError?: string };
    expect(body.completed).toBe(false);
    expect(body.settlementError).toContain("processor down");
    expect(h.records.get("ORD-1")).toBeUndefined();
  });

  it("relays the verdict's trust_level VERBATIM — never upgrades it (Principle VII)", async () => {
    const verifier = verifierReturning({ trust_level: "presence-only-demo" });
    const h = harness([payment.in("usd"), age.over(21)], verifier);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { trust_level: string }).trust_level).toBe("presence-only-demo");
    expect(h.records.get("ORD-1")!.trustLevel).toBe("presence-only-demo");
  });

  it("an identity-only delegated gate (no payment) completes with NO settlement call", async () => {
    // age-only policy on a non-age item so the age sweep is the only gate; nothing to settle.
    const verifier = verifierReturning({ binding: { amount: 199, currency: "USD", payee: { id: "shop.example" } }, claims: { age_mdl: { age_over_21: true } } });
    const h = harness([age.over(21)], verifier, [{ productId: "aurora-headphones", quantity: 1 }]);
    const out = await h.verify({ order: "ORD-1", referenceToken: tokenFor("ORD-1") });
    expect((out.body as { completed: boolean }).completed).toBe(true);
    expect(verifier.settle).not.toHaveBeenCalled(); // no authorize() credential ⇒ no settlement
  });
});

// ── statelessOrders (FR-007) — the ?cart passthrough must survive the verify POST ────────
// With no order store to fall back on, the signed cart mandate IS the order transport, and
// routes.ts promises it "survives every hop". The verify POST used to send only
// { order, referenceToken }, so `resolveOrder` found nothing and EVERY stateless delegated
// checkout 400'd with "missing or invalid order". The other e2e tests all use the stateful
// store, which is why nothing caught it.

const cartParam = (mandate: unknown): string => Buffer.from(JSON.stringify(mandate)).toString("base64url");

describe("delegated rail — statelessOrders passthrough", () => {
  it("the approve page forwards `cart` on the verify POST (the hop that dropped it)", () => {
    const html = renderDelegatedPage({
      order: "ORD-S1",
      total: 199,
      currency: "USD",
      lines: [{ name: "Aurora", quantity: 1, lineTotal: 199, currency: "USD" }],
      cart: "CART-MANDATE",
    });
    // Read off the live URL (same as the dc-payment rail) and included in the verify body.
    expect(html).toContain('new URLSearchParams(location.search).get("cart")');
    expect(html).toContain("cart: CART");
  });

  it("completes from the signed cart mandate alone — the order store is never read", async () => {
    const verifier = verifierReturning({
      claims: { payment: { issuer_name: "Bank" } },
      binding: { amount: 199, currency: "USD", payee: { id: "shop.example" } },
    });
    const h = harness([payment.in("usd")], verifier, [{ productId: "aurora-headphones", quantity: 1 }], { stateless: true });
    const mandate = issueCartMandate(
      { orderId: "ORD-S1", lines: [{ id: "aurora-headphones", quantity: 1, unitPrice: 199, lineTotal: 199 }], currency: "USD", total: 199 },
      SECRET,
    );
    // Exactly what the page posts: `cart` = base64url(JSON(mandate)). The harness's order
    // store THROWS, so completing at all proves the mandate carried the order.
    const out = await h.verify({ order: "ORD-S1", cart: cartParam(mandate), referenceToken: tokenFor("ORD-S1") });
    expect((out.body as { completed: boolean }).completed).toBe(true);
    expect(h.records.get("ORD-S1")?.amount).toBe(199); // reconstructed + re-priced from the mandate
  });
});

// ── Reflected XSS on the refusal path (the `cart` param is caller-supplied) ──────────────
// The approve page is served on the MERCHANT'S PAYMENT ORIGIN, so markup injected here runs
// with that origin's privileges. `cart` rides the ceremony URL untrusted; it used to land
// UNENCODED in the default returnUrl, and the refusal/error branches then concatenated that
// URL into `innerHTML` — so `?cart="><img src=x onerror=…>` executed on any refusal.
describe("delegated rail — approve page escapes the untrusted cart param", () => {
  const XSS = '"><img src=x onerror=alert(1)>';
  const page = () =>
    renderDelegatedPage({
      order: "ORD-X",
      total: 10,
      currency: "USD",
      lines: [{ name: "Item", quantity: 1, lineTotal: 10, currency: "USD" }],
      cart: XSS,
    });

  it("percent-encodes a crafted cart so no raw markup survives into the page", () => {
    const html = page();
    expect(html).not.toContain("onerror=alert(1)"); // encoded → onerror%3Dalert(1)
    expect(html).not.toContain("<img src=x");
  });

  it("builds the refusal return link via DOM, never by concatenating the URL into innerHTML", () => {
    const html = page();
    // The old sink. innerHTML PARSES markup; setAttribute/textContent cannot.
    expect(html).not.toContain(`'<a class="ret" href="' + RETURN_URL`);
    expect(html).toContain("createElement(\"a\")");
  });
});

// ── The gate must name NO verifier (#88 honesty) ─────────────────────────────────────────
// types.ts and index.ts both promise "nothing here names a specific verifier or processor".
// The approve page used to bake in `window.multipazVerifyCredentials` + the
// `/verify_credentials.js` filename, so a second adapter could not use this rail without
// shipping a script that impersonated Multipaz's global — and the promise was simply false.
// The adapter now declares its own contract via `clientScript` + `clientEntry`.
describe("delegated rail — the gate names no verifier", () => {
  it("the approve page carries no vendor symbol, and drives whatever the handoff declares", () => {
    const html = renderDelegatedPage({
      order: "ORD-V",
      total: 10,
      currency: "USD",
      lines: [{ name: "Item", quantity: 1, lineTotal: 10, currency: "USD" }],
    });
    expect(html).not.toMatch(/multipaz/i); // no vendor global, no vendor script name
    expect(html).not.toContain("verify_credentials.js");
    expect(html).not.toContain("verifierBase");
    // Driven entirely by what the adapter declared.
    expect(html).toContain("data.clientScript");
    expect(html).toContain("window[data.clientEntry]");
  });

  it("forwards the adapter's declared client contract through /request", async () => {
    const verifier = verifierReturning();
    verifier.buildRequest = vi.fn(async () => ({
      reference: "ref-1",
      handoff: { anything: "opaque" },
      clientScript: "https://verifier.example/acme.js",
      clientEntry: "acmeVerifyCredentials",
    }));
    const order = catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-V1");
    const ctx = { verifier, signingKey: SECRET, credentialRegistry: new Map([["payment", payment.in("usd")]]) };
    const out = await buildDelegatedRequest(ctx as never, order, { rpID: "shop.example", origin: "https://shop.example" });
    expect(out.clientScript).toBe("https://verifier.example/acme.js");
    expect(out.clientEntry).toBe("acmeVerifyCredentials");
  });
});
