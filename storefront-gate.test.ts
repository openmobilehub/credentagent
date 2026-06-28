import { describe, it, expect } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront, type Storefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

// Guards the quickstart showcase (examples/storefront.mjs): the two packages
// compose with ZERO glue — a priced storefront Order feeds attesto.requirements()
// directly (the line carries minimumAge), and the checkout tool surfaces the
// manifest. Drives the real MCP server over an in-memory transport (deterministic).

const hasAlcohol = (order: { lines: { minimumAge?: number }[] }) =>
  order.lines.some((l) => l.minimumAge != null);

function gatedStore(): Storefront {
  const store = createStorefront();
  const attesto = new Attesto();
  attesto.mount(store.app);
  store.gate((order) =>
    attesto.requirements(order, [
      required(age.over(21).when(hasAlcohol)),
      optional(membership.discount(10)),
      required(payment.in("usd")),
    ]),
  );
  return store;
}

async function connect(store: Storefront): Promise<Client> {
  const server = store.mcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "compose-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const checkout = (c: Client, productId: string) =>
  c.callTool({ name: "checkout", arguments: { items: [{ productId, quantity: 1 }] } });

describe("attesto-storefront × attesto-gate compose (zero glue)", () => {
  it("registers the storefront tools", async () => {
    const tools = (await (await connect(gatedStore())).listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["browse-products", "checkout", "get-order-status"]));
  });

  it("alcohol cart → checkout surfaces the age gate + a checkoutUrl; payment settles last", async () => {
    const res = await checkout(await connect(gatedStore()), "oak-whiskey");
    const sc = res.structuredContent as { checkoutUrl: string; requires: Array<{ credential: string; minAge?: number }> };
    expect(sc.checkoutUrl).toContain("/checkout?order=");
    const order = sc.requires.map((e) => e.credential);
    expect(order).toEqual(["age", "membership", "payment"]); // declared order, payment last
    expect(sc.requires.find((e) => e.credential === "age")!.minAge).toBe(21);
  });

  it("non-alcohol cart → no age entry (the .when() predicate drops it)", async () => {
    const res = await checkout(await connect(gatedStore()), "aurora-headphones");
    const sc = res.structuredContent as { requires: Array<{ credential: string }> };
    expect(sc.requires.find((e) => e.credential === "age")).toBeUndefined();
    expect(sc.requires.map((e) => e.credential)).toEqual(["membership", "payment"]);
  });

  it("ungated storefront → plain checkout link, no `requires`", async () => {
    const res = await checkout(await connect(createStorefront()), "oak-whiskey");
    const sc = res.structuredContent as { checkoutUrl: string; requires?: unknown };
    expect(sc.checkoutUrl).toContain("/checkout?order=");
    expect(sc.requires).toBeUndefined();
  });
});

// The full composition over HTTP: opening the checkout LINKS to the mounted
// /attesto/* ceremony routes (in policy order, payment last), and a buyer can
// actually COMPLETE the ceremony — prove age → present membership → authorize
// payment — which writes completion that the order-status poll reflects. Drives the
// real mounted rails on `store.app` via supertest (the MCP server + the app share the
// same closure stores, so the checkout tool and the ceremony see one state).
type Sc = { orderId: string; requires: Array<{ credential: string; effect: string; approveUrl: string }> };

// Presence-only DC payment claims (the instrument is disclosed, not cryptographically
// verified — trust_level presence-only-demo). expiry in the future → Gate 3 passes.
const DC_CLAIMS = {
  payment_instrument_id: "acct_demo_1",
  expiry_date: "2031-12-31",
  masked_account_reference: "•••• 4242",
  issuer_name: "Demo Bank",
  holder_name: "Test Buyer",
};

describe("end-to-end ceremony over the mounted /attesto/* routes", () => {
  it("prove age → present membership → authorize payment completes with the DISCOUNTED amount", async () => {
    const store = gatedStore();
    const client = await connect(store);
    const sc = (await checkout(client, "oak-whiskey")).structuredContent as Sc;
    const orderId = sc.orderId;

    // requires[] carries approveUrls onto THIS server's mounted routes, in policy
    // order (payment last): age/membership → the credential page, payment → dc-payment.
    expect(sc.requires.map((e) => e.credential)).toEqual(["age", "membership", "payment"]);
    const byCred = Object.fromEntries(sc.requires.map((e) => [e.credential, e.approveUrl]));
    expect(byCred.age).toContain("/attesto/credential?order=");
    expect(byCred.age).toContain("cred=age");
    expect(byCred.membership).toContain("/attesto/credential?order=");
    expect(byCred.membership).toContain("cred=membership");
    expect(byCred.payment).toContain("/attesto/dc-payment?order=");

    // The age gate page renders (the link from requires[].approveUrl resolves).
    const page = await request(store.app).get(byCred.age);
    expect(page.status).toBe(200);
    expect(page.text).toContain(orderId);

    // Prove age (explicit positive claim at the order's threshold) + present membership
    // (opts THIS order into the 10% discount).
    const ageOut = await request(store.app).post("/attesto/credential/verify").send({ order: orderId, cred: "age", claims: { age_over_21: true } });
    expect(ageOut.body.verified).toBe(true);
    const memOut = await request(store.app).post("/attesto/credential/verify").send({ order: orderId, cred: "membership", claims: { membership_number: "MEMBER-7" } });
    expect(memOut.body.verified).toBe(true);

    // Authorize payment. The bound amount is the DISCOUNTED total — line sum 124 − 10%
    // = 111.6 — re-derived from the catalog + this order's verified loyalty (invariant
    // 3), and a finished ceremony records through the shared completeOrder seam.
    const pay = await request(store.app).post("/attesto/dc-payment/verify").send({ order: orderId, claims: DC_CLAIMS });
    expect(pay.body.completed).toBe(true);
    expect(pay.body.mandate.payment.amount).toBeCloseTo(111.6);

    // get-order-status / the order-status poll reflect completion + the discounted amount.
    const status = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(status.body.completed).toBe(true);
    expect(status.body.order.amount).toBeCloseTo(111.6);
    expect(status.body.order.currency).toBe("USD");
  });

  it("BYPASS: an age-restricted order whose age is NOT proven cannot complete (refused on the completion path; load-bearing)", async () => {
    const store = gatedStore();
    const client = await connect(store);
    const orderId = ((await checkout(client, "oak-whiskey")).structuredContent as Sc).orderId;

    // MUTATE: authorize payment WITHOUT proving age. The dc-payment gates pass (the
    // amount binds), but the SHARED completeOrder re-derives the age restriction from
    // the catalog-priced lines and REFUSES — invariant 1, on the completion path, not
    // merely a hidden button. Nothing is recorded.
    const refused = await request(store.app).post("/attesto/dc-payment/verify").send({ order: orderId, claims: DC_CLAIMS });
    expect(refused.body.completed).toBe(false);
    expect(refused.body.reason).toBe("age");
    const pending = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(pending.body.completed).toBe(false);

    // REVERT: prove age, retry the SAME order → it now completes (so the refusal was
    // the age control, not an unrelated failure). No membership ⇒ full 124.
    await request(store.app).post("/attesto/credential/verify").send({ order: orderId, cred: "age", claims: { age_over_21: true } });
    const ok = await request(store.app).post("/attesto/dc-payment/verify").send({ order: orderId, claims: DC_CLAIMS });
    expect(ok.body.completed).toBe(true);
    expect(ok.body.mandate.payment.amount).toBeCloseTo(124);
    const done = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(done.body.completed).toBe(true);
    expect(done.body.order.amount).toBeCloseTo(124);
  });
});
