// End to end, in-process (spec 014 acceptance): the person delegates on their phone, the agent
// keeps that permission and spends it at a merchant, and the merchant verifies the purchase —
// at a SECOND merchant too, and refused at one the permission excludes. That last pair is the
// test that portability is real.
//
// The examples at the top of each test are the API's DX test: if one needed plumbing, the API failed.
import { describe, expect, it } from "vitest";
import { DelegatedIntent, verifyDelegatedPurchase, type DelegatedPurchaseProof, type VerifyPurchaseOptions } from "./purchase.js";
import type { Spent } from "./constraints.js";
import { resolveSigningKey } from "../keys.js";
import { Ap2Issuer } from "../issue.js";
import { merchantFor } from "../from-gate.js";
import { newWallet, testGrant, GATE_ORIGIN } from "./test-wallet.js";
import { p256 } from "../../ceremony/intent-sign/dev-wallet.js";
import { VCT, type UcpCheckout } from "../types.js";
import { digestToken } from "../sdjwt.js";
import { appendAgentHop } from "./hop.js";
import { walletChain } from "./serialize.js";

const SECOND = "https://second-shop.example";

/** A merchant: its key, its quoted cart, and its catalog (the price authority — invariant 2). */
function merchant(origin: string, lines: Array<[string, number]> = [["coffee", 1]], mutate: (c: UcpCheckout) => UcpCheckout = (c) => c) {
  const key = resolveSigningKey(origin);
  const ap2 = new Ap2Issuer(key);
  const ucp: UcpCheckout = mutate({
    id: "ord_1",
    merchant: merchantFor(origin),
    line_items: lines.map(([id, q], i) => ({
      id: `li${i}`,
      item: { id, title: id, price: 450 },
      quantity: q,
      totals: [{ type: "total", amount: 450 * q }],
    })),
    status: "ready_for_complete",
    currency: "USD",
    totals: [{ type: "total", amount: lines.reduce((s, [, q]) => s + 450 * q, 0) }],
    links: [],
  });
  const catalog = (c: UcpCheckout) => c.line_items.reduce((s, l) => s + 450 * l.quantity, 0);
  return { origin, ap2, ucp, checkoutJwt: ap2.signCheckout(ucp), price: catalog };
}

/** Verify at merchant `m` with the options every test shares; `over` changes the one under test. */
const verifyWith = (proof: DelegatedPurchaseProof, m: Merchant, over: Partial<VerifyPurchaseOptions> = {}) =>
  verifyDelegatedPurchase(proof, {
    trust: "presence-only-demo",
    audience: m.origin,
    nonce: "purchase-nonce",
    checkoutKey: m.ap2.checkoutPublicJwk,
    spent: { amount: 0, uses: 0 },
    price: m.price,
    ...over,
  });
type Merchant = ReturnType<typeof merchant>;

async function purchase(
  opts: {
    grant?: Parameters<typeof testGrant>[0];
    at?: string;
    amount?: number;
    lines?: Array<[string, number]>;
    mutate?: (c: UcpCheckout) => UcpCheckout;
    payee?: string;
  } = {},
) {
  const g = await testGrant(opts.grant);
  const m = merchant(opts.at ?? GATE_ORIGIN, opts.lines, opts.mutate);
  const intent = DelegatedIntent.fromWalletPresentation({ presentation: g.presentation, disclosures: g.disclosures });
  const honest = await intent.spend({
    agentKey: g.agentKey,
    checkoutJwt: m.checkoutJwt,
    instrument: { id: "pi_1", type: "card" },
    audience: m.origin,
    nonce: "purchase-nonce",
  });
  // `spend` takes the payee and the amount from the cart, so an honest agent cannot get them wrong.
  // A hostile one signs its own hop — which is what these overrides build, with the agent's real key.
  const forged =
    opts.payee !== undefined || opts.amount !== undefined
      ? await appendAgentHop({
          chain: walletChain(g.presentation, intent.disclosures.payment)!,
          agentKey: g.agent.privateKey,
          content: {
            vct: VCT.payment,
            transaction_id: digestToken(m.checkoutJwt),
            payee: merchantFor(opts.payee ?? m.origin),
            payment_amount: { amount: opts.amount ?? m.ucp.totals[0].amount, currency: "USD" },
            payment_instrument: { id: "pi_1", type: "card" },
            iat: Math.floor(Date.now() / 1000),
          },
          audience: m.origin,
          nonce: "purchase-nonce",
        })
      : undefined;
  const proof = forged ? { ...honest, payment: forged } : honest;
  const verify = (over: Partial<VerifyPurchaseOptions> = {}) => verifyWith(proof, m, over);
  return { g, m, intent, proof, verify };
}

describe("a delegated purchase, end to end", () => {
  it("verifies at the merchant the permission was made at", async () => {
    const { verify, m } = await purchase();
    const v = await verify();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.checkout).toEqual(m.ucp);
    expect(v.payment.payment_amount).toEqual({ amount: 450, currency: "USD" });
    expect(v.trust_level).toBe("presence-only-demo");
  });

  it("says so plainly when the wallet presentation carries no key binding", async () => {
    const { g, m } = await purchase();
    const intent = DelegatedIntent.fromWalletPresentation({
      presentation: g.presentation.replace(/[^~]*$/, ""),
      disclosures: g.disclosures,
    });
    await expect(
      intent.spend({
        agentKey: g.agentKey,
        checkoutJwt: m.checkoutJwt,
        instrument: { id: "pi_1", type: "card" },
        audience: GATE_ORIGIN,
        nonce: "n",
      }),
    ).rejects.toThrow(/no wallet key binding/);
  });

  it("is plain data an agent can store and bring back", async () => {
    const { intent } = await purchase();
    const restored = DelegatedIntent.fromWalletPresentation(JSON.parse(JSON.stringify(intent)));
    expect(restored.openPayment).toEqual(intent.openPayment);
    expect(restored.permissionId).toBe(intent.permissionId);
  });

  // Portability: the same signed permission, a different store that it names.
  it("verifies at a SECOND merchant the permission allows", async () => {
    const { verify } = await purchase({ grant: { alsoAllowed: [merchantFor(SECOND)] }, at: SECOND });
    expect((await verify()).ok).toBe(true);
  });

  it("is refused at a merchant the permission does not name (bypass)", async () => {
    const { verify } = await purchase({ at: SECOND });
    const v = await verify();
    expect(v).toMatchObject({ ok: false, code: "constraint" });
    if (v.ok) return;
    expect(v.violations?.map((x) => x.constraint)).toEqual(
      expect.arrayContaining(["checkout.allowed_merchants", "payment.allowed_payees"]),
    );
  });

  // A permission naming two stores lets each be paid — for its own cart. Every signature is
  // genuine and SECOND passes allowed_payees; only the payee ↔ checkout binding refuses it.
  it("refuses paying another allowed store for this store's cart (bypass)", async () => {
    const { verify } = await purchase({ grant: { alsoAllowed: [merchantFor(SECOND)] }, payee: SECOND });
    expect(await verify()).toMatchObject({ ok: false, code: "payee" });
  });
});

describe("the merchant's own checks", () => {
  // Spec 014: "re-pricing still decides" — invariant 2. Every signature here is genuine and every
  // limit holds; only the catalog knows the cart costs more than the agent paid.
  it("refuses a perfectly signed purchase whose total the catalog disagrees with (bypass)", async () => {
    const { verify } = await purchase();
    expect(await verify({ price: () => 900 })).toMatchObject({ ok: false, code: "price" });
  });

  // Invariant 3: a total that does not add up from its lines — even one the merchant signed, and
  // even when the catalog and the payment agree with it — is refused.
  it("refuses a checkout whose total does not add up from its lines (bypass)", async () => {
    const { verify } = await purchase({
      mutate: (c) => ({ ...c, line_items: c.line_items.map((l) => ({ ...l, totals: [{ type: "total", amount: 900 }] })) }),
    });
    expect(await verify()).toMatchObject({ ok: false, code: "amount", detail: expect.stringMatching(/does not add up/) });
  });

  // Invariant 3: the payment must pay exactly the cart's total.
  it("refuses a payment that does not pay the checkout's total (bypass)", async () => {
    const { verify } = await purchase({ amount: 400 });
    expect(await verify()).toMatchObject({ ok: false, code: "amount" });
  });

  it("refuses a payment above the permission's per-purchase limit (bypass)", async () => {
    const { verify } = await purchase({
      grant: { perSpend: 5 },
      lines: [
        ["coffee", 1],
        ["tea", 1],
      ],
    });
    const v = await verify();
    expect(v).toMatchObject({ ok: false, code: "constraint" });
    if (!v.ok) expect(v.violations?.map((x) => x.constraint)).toContain("payment.amount_range");
  });

  it("refuses when the budget cannot be checked — no `spent` (bypass)", async () => {
    const { verify } = await purchase();
    expect(await verify({ spent: undefined })).toMatchObject({ ok: false, code: "constraint" });
  });

  it("refuses a checkout signed by someone other than this merchant (bypass)", async () => {
    const { verify } = await purchase();
    expect(await verify({ checkoutKey: resolveSigningKey(GATE_ORIGIN).publicJwk })).toMatchObject({ ok: false, code: "signature" });
  });

  // Spec 014: "no key, no pass".
  it("refuses when no checkout key was configured (bypass)", async () => {
    const { verify } = await purchase();
    expect(await verify({ checkoutKey: undefined as never })).toMatchObject({
      ok: false,
      code: "no-checkout-key",
      detail: expect.stringMatching(/^no checkout key/),
    });
  });
});

describe("the two chains are one purchase", () => {
  // Same wallet, same agent, two permissions: a generous payment authority stapled to a strict
  // checkout authority. Every signature is genuine; only the shared-root check sees the splice.
  it("refuses a payment chain from another grant (bypass)", async () => {
    const wallet = await newWallet();
    const agent = p256();
    const strict = await purchase({ grant: { wallet, agent, grantId: "strict", perSpend: 1 } });
    const generous = await purchase({ grant: { wallet, agent, grantId: "generous", perSpend: 500 } });
    const spliced = { checkout: strict.proof.checkout, payment: generous.proof.payment };
    expect(await strict.verify()).toMatchObject({ ok: false, code: "constraint" }); // strict alone is over its $1 limit
    expect(await verifyWith(spliced, strict.m)).toMatchObject({ ok: false, code: "splice" });
  });

  it("refuses chains whose mandate types are swapped (bypass)", async () => {
    const { proof, m } = await purchase();
    const v = await verifyWith({ checkout: proof.payment, payment: proof.checkout }, m);
    expect(v).toMatchObject({ ok: false, code: "unexpected-type", detail: expect.stringMatching(/^the checkout chain/) });
  });

  it("refuses a payment chain that carries checkout mandates (bypass)", async () => {
    const { proof, m } = await purchase();
    const v = await verifyWith({ checkout: proof.checkout, payment: proof.checkout }, m);
    expect(v).toMatchObject({ ok: false, code: "unexpected-type", detail: expect.stringMatching(/^the payment chain/) });
  });

  // The merchant signed BOTH carts; the agent names one by hash and carries the other. Only
  // re-hashing what it carries catches it — the signature on the swapped cart is genuine.
  it("refuses a checkout_jwt swapped under the hash it claims (bypass)", async () => {
    const { g, m } = await purchase();
    const cheaper = merchant(GATE_ORIGIN, [["tea", 1]]);
    const intent = DelegatedIntent.fromWalletPresentation({ presentation: g.presentation, disclosures: g.disclosures });
    const honest = await intent.spend({
      agentKey: g.agentKey,
      checkoutJwt: m.checkoutJwt,
      instrument: { id: "pi_1", type: "card" },
      audience: GATE_ORIGIN,
      nonce: "purchase-nonce",
    });
    const hash = digestToken(m.checkoutJwt);
    const forged = await appendAgentHop({
      chain: walletChain(g.presentation, intent.disclosures.checkout)!,
      agentKey: g.agent.privateKey,
      content: { vct: VCT.checkout, checkout_jwt: cheaper.checkoutJwt, checkout_hash: hash, iat: Math.floor(Date.now() / 1000) },
      audience: GATE_ORIGIN,
      nonce: "purchase-nonce",
    });
    const v = await verifyWith({ checkout: forged, payment: honest.payment }, m);
    expect(v).toMatchObject({ ok: false, code: "checkout-unbound", detail: expect.stringMatching(/does not hash/) });
  });

  it("refuses a payment bound to a different checkout (bypass)", async () => {
    const { g, m } = await purchase();
    const intent = DelegatedIntent.fromWalletPresentation({ presentation: g.presentation, disclosures: g.disclosures });
    const other = merchant(GATE_ORIGIN, [["tea", 1]]);
    const a = await intent.spend({
      agentKey: g.agentKey,
      checkoutJwt: m.checkoutJwt,
      instrument: { id: "pi_1", type: "card" },
      audience: GATE_ORIGIN,
      nonce: "purchase-nonce",
    });
    const b = await intent.spend({
      agentKey: g.agentKey,
      checkoutJwt: other.checkoutJwt,
      instrument: { id: "pi_1", type: "card" },
      audience: GATE_ORIGIN,
      nonce: "purchase-nonce",
    });
    const v = await verifyWith({ checkout: a.checkout, payment: b.payment }, m);
    expect(v).toMatchObject({ ok: false, code: "payment-unbound" });
  });
});

describe("trust — the opt-in that says what a verdict is worth", () => {
  // The reviewer's probe, kept: the credential at the root is checked against the certificate it
  // carries ITSELF, so an agent can mint its own "permission" with any limits. `testGrant` does
  // exactly that — a fresh self-signed wallet each time. Nothing here anchors it (#14).
  it('refuses to verify at all without trust: "presence-only-demo" (bypass)', async () => {
    const { verify, m } = await purchase();
    // @ts-expect-error — `trust` is required: leaving it out does not compile.
    const missing: Parameters<typeof verifyDelegatedPurchase>[1] = {
      audience: GATE_ORIGIN,
      nonce: "purchase-nonce",
      checkoutKey: m.ap2.checkoutPublicJwk,
      price: m.price,
    };
    expect(await verifyDelegatedPurchase((await purchase()).proof, missing)).toMatchObject({ ok: false, code: "trust" });
    expect(await verify({ trust: undefined as never })).toMatchObject({ ok: false, code: "trust" });
    expect(await verify({ trust: "issuer-verified" as never })).toMatchObject({ ok: false, code: "trust" });
  });

  it("a self-made permission with $1,000,000 limits buys a $500,000 item — which is why it is opt-in", async () => {
    const { verify } = await purchase({
      grant: { perSpend: 1_000_000, budget: 1_000_000 },
      mutate: (c) => ({
        ...c,
        line_items: [
          { ...c.line_items[0], item: { ...c.line_items[0].item, price: 50_000_000 }, totals: [{ type: "total", amount: 50_000_000 }] },
        ],
        totals: [{ type: "total", amount: 50_000_000 }],
      }),
    });
    const v = await verify({ price: () => 50_000_000 });
    expect(v).toMatchObject({ ok: true, trust_level: "presence-only-demo" });
  });
});

describe("one permission, one id", () => {
  it("names the permission the same way to the agent and to every merchant", async () => {
    const g = await testGrant({ alsoAllowed: [merchantFor(SECOND)] });
    const intent = DelegatedIntent.fromWalletPresentation({ presentation: g.presentation, disclosures: g.disclosures });
    const ids: string[] = [];
    for (const origin of [GATE_ORIGIN, SECOND]) {
      const m = merchant(origin);
      const proof = await intent.spend({
        agentKey: g.agentKey,
        checkoutJwt: m.checkoutJwt,
        instrument: { id: "pi_1", type: "card" },
        audience: origin,
        nonce: "n",
      });
      const v = await verifyWith(proof, m, { nonce: "n" });
      expect(v.ok).toBe(true);
      if (v.ok) ids.push(v.permissionId);
    }
    expect(ids).toEqual([intent.permissionId, intent.permissionId]);
    const other = await testGrant();
    expect(
      DelegatedIntent.fromWalletPresentation({ presentation: other.presentation, disclosures: other.disclosures }).permissionId,
    ).not.toBe(intent.permissionId);
  });

  it("looks `spent` up by the VERIFIED id — a budget spent out at this store refuses (bypass)", async () => {
    const { verify, intent } = await purchase();
    const asked: string[] = [];
    const ledger = (id: string) => {
      asked.push(id);
      return { amount: 20_000, uses: 1 }; // $200 already spent here — the whole budget
    };
    expect(await verify({ spent: ledger })).toMatchObject({
      ok: false,
      code: "constraint",
      violations: [expect.objectContaining({ constraint: "payment.budget" })],
    });
    expect(asked).toEqual([intent.permissionId]);
  });

  it("never asks the ledger about a purchase whose chains do not verify", async () => {
    const { verify } = await purchase();
    let asked = false;
    await verify({ nonce: "not-the-one-issued", spent: () => ((asked = true), { amount: 0, uses: 0 }) });
    expect(asked).toBe(false);
  });
});

describe("malformed input is refused, never thrown", () => {
  // A hostile agent signs its own hops, so it controls every field of the closed mandates.
  async function forgedProof(checkoutContent: (jwt: string, hash: string) => Record<string, unknown>, payment: (hash: string) => Record<string, unknown>) {
    const g = await testGrant();
    const m = merchant(GATE_ORIGIN);
    const hash = digestToken(m.checkoutJwt);
    const hop = (which: 0 | 1, content: Record<string, unknown>) =>
      appendAgentHop({ chain: walletChain(g.presentation, g.disclosures[which])!, agentKey: g.agent.privateKey, content, audience: GATE_ORIGIN, nonce: "n" });
    const proof = { checkout: await hop(0, checkoutContent(m.checkoutJwt, hash)), payment: await hop(1, payment(hash)) };
    return verifyWith(proof, m, { nonce: "n" });
  }
  const iat = () => Math.floor(Date.now() / 1000);
  const honestPayment = (hash: string) => ({
    vct: VCT.payment,
    transaction_id: hash,
    payee: merchantFor(GATE_ORIGIN),
    payment_amount: { amount: 450, currency: "USD" },
    payment_instrument: { id: "pi_1", type: "card" },
    iat: iat(),
  });

  it("refuses a closed checkout whose checkout_jwt is not a string (bypass)", async () => {
    for (const bad of [123, {}, true]) {
      const v = await forgedProof((_jwt, hash) => ({ vct: VCT.checkout, checkout_jwt: bad, checkout_hash: hash, iat: iat() }), honestPayment);
      expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/checkout_jwt/) });
    }
  });

  it("refuses a closed payment with no integer payment_amount (bypass)", async () => {
    for (const amount of [undefined, { amount: 4.5, currency: "USD" }, { amount: 450 }]) {
      const v = await forgedProof(
        (jwt, hash) => ({ vct: VCT.checkout, checkout_jwt: jwt, checkout_hash: hash, iat: iat() }),
        (hash) => ({ ...honestPayment(hash), payment_amount: amount }),
      );
      expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/payment_amount/) });
    }
  });

  it("refuses a signed limit missing a field it needs — e.g. a spending range with no currency (bypass)", async () => {
    const dropCurrency = (m: Record<string, unknown>) => ({
      ...m,
      constraints: (m.constraints as Array<Record<string, unknown>>).map((c) =>
        c.type === "payment.amount_range" ? { type: c.type, max: c.max } : c,
      ),
    });
    const { verify } = await purchase({ grant: { mapOpen: (m, i) => (i === 1 ? (dropCurrency(m as never) as never) : m) } });
    expect(await verify()).toMatchObject({
      ok: false,
      code: "malformed",
      violations: expect.arrayContaining([expect.objectContaining({ code: "malformed", constraint: "payment.amount_range" })]),
    });
  });

  it("refuses a line_items limit with no items, and an open mandate with no constraints list (bypass)", async () => {
    const noItems = await purchase({
      grant: {
        mapOpen: (m, i) =>
          i === 0
            ? ({
                ...m,
                constraints: (m.constraints as Array<{ type: string }>).map((c) =>
                  c.type === "checkout.line_items" ? { type: c.type } : c,
                ),
              } as never)
            : m,
      },
    });
    expect(await noItems.verify()).toMatchObject({ ok: false, code: "malformed" });
    const noList = await purchase({ grant: { mapOpen: (m, i) => (i === 0 ? ({ ...m, constraints: undefined } as never) : m) } });
    expect(await noList.verify()).toMatchObject({ ok: false, code: "malformed" });
  });

  it("refuses a signed cart with no line_items — the merchant's signature does not make it well-formed (bypass)", async () => {
    // `spend` refuses such a cart on the agent's side, so the hostile agent signs its own hops.
    const g = await testGrant();
    const m = merchant(GATE_ORIGIN, undefined, (c) => ({ ...c, line_items: undefined as never }));
    const hash = digestToken(m.checkoutJwt);
    const iat = Math.floor(Date.now() / 1000);
    const hop = (which: 0 | 1, content: Record<string, unknown>) =>
      appendAgentHop({
        chain: walletChain(g.presentation, g.disclosures[which])!,
        agentKey: g.agent.privateKey,
        content,
        audience: GATE_ORIGIN,
        nonce: "n",
      });
    const proof = {
      checkout: await hop(0, { vct: VCT.checkout, checkout_jwt: m.checkoutJwt, checkout_hash: hash, iat }),
      payment: await hop(1, {
        vct: VCT.payment,
        transaction_id: hash,
        payee: merchantFor(GATE_ORIGIN),
        payment_amount: { amount: 450, currency: "USD" },
        payment_instrument: { id: "pi_1", type: "card" },
        iat,
      }),
    };
    const v = await verifyWith(proof, m, { nonce: "n" });
    expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/line_items/) });
  });
});

describe("one permission, one id — however its signature is spelled", () => {
  // An ECDSA signature has other spellings that still verify: `s` replaced by `n − s` ("high-S"),
  // and the unused low bits of its last base64url character. A hostile agent can re-spell the
  // wallet's signature and re-sign its own hops over it. If the id hashed the signature, each
  // spelling would be a fresh permission with an empty ledger.
  const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const respell = (presentation: string, how: "high-s" | "spare-bits"): string => {
    const cut = presentation.lastIndexOf(".") + 1;
    const sig = presentation.slice(cut);
    if (how === "high-s") {
      const raw = Buffer.from(sig, "base64url");
      const s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
      const high = Buffer.from((N - s).toString(16).padStart(64, "0"), "hex");
      return presentation.slice(0, cut) + Buffer.concat([raw.subarray(0, 32), high]).toString("base64url");
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(sig.at(-1)!);
    const same = [1, 2, 3]
      .map((flip) => alphabet[last ^ flip])
      .find((c) => Buffer.from(sig.slice(0, -1) + c, "base64url").equals(Buffer.from(sig, "base64url")));
    return presentation.slice(0, cut) + sig.slice(0, -1) + same!;
  };

  it("gives every spelling of the wallet's signature the same permissionId, so a budget cannot be re-spent (bypass)", async () => {
    const g = await testGrant({ budget: 5 }); // 500 cents
    const m = merchant(GATE_ORIGIN);
    const ledger = new Map<string, Spent>();
    const results = [];
    for (const presentation of [g.presentation, respell(g.presentation, "high-s"), respell(g.presentation, "spare-bits")]) {
      const intent = DelegatedIntent.fromWalletPresentation({ presentation, disclosures: g.disclosures });
      const proof = await intent.spend({
        agentKey: g.agentKey,
        checkoutJwt: m.checkoutJwt,
        instrument: { id: "pi_1", type: "card" },
        audience: GATE_ORIGIN,
        nonce: "n",
      });
      const v = await verifyWith(proof, m, { nonce: "n", spent: (id) => ledger.get(id) ?? { amount: 0, uses: 0 } });
      if (v.ok) {
        const before = ledger.get(v.permissionId) ?? { amount: 0, uses: 0 };
        ledger.set(v.permissionId, { amount: before.amount + v.payment.payment_amount.amount, uses: before.uses + 1 });
      }
      results.push(v.ok ? "ok" : v.code);
    }
    // 450 of a 500 budget, then nothing more — whichever spelling the agent tries.
    expect(results).toEqual(["ok", "constraint", "constraint"]);
    expect(ledger.size).toBe(1);
  });
});

describe("the caller's own input is checked too", () => {
  it("refuses a ledger whose spent is not a pair of whole numbers — NaN would pass every budget (bypass)", async () => {
    const { verify } = await purchase();
    for (const bad of [{}, { uses: 2 }, { amount: Number.NaN, uses: 0 }, { amount: "0", uses: 0 }, { amount: -1, uses: 0 }]) {
      expect(await verify({ spent: () => bad as never })).toMatchObject({ ok: false, code: "malformed" });
      expect(await verify({ spent: bad as never })).toMatchObject({ ok: false, code: "malformed" });
    }
  });

  it("refuses a proof that is not two chains, without throwing", async () => {
    const { verify } = await purchase();
    void verify;
    const m = merchant(GATE_ORIGIN);
    const opts = {
      trust: "presence-only-demo" as const,
      audience: GATE_ORIGIN,
      nonce: "n",
      checkoutKey: m.ap2.checkoutPublicJwk,
      price: m.price,
    };
    for (const bad of [null, {}, "a.b.c", { checkout: 1, payment: 2 }, { checkout: "a~~b~", payment: null }]) {
      expect(await verifyDelegatedPurchase(bad as never, opts)).toMatchObject({ ok: false, code: "malformed" });
    }
  });
});
