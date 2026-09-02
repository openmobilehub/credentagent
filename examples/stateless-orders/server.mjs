// Runnable example — statelessOrders (a signed AP2 chain as the order transport, FR-007).
//
//   node examples/stateless-orders/server.mjs      # boots on http://localhost:4000
//   bash examples/stateless-orders/demo.sh         # drives a full checkout with curl
//
// It mounts the CredentAgent gate with `statelessOrders: true` and an EMPTY order store
// (it THROWS on read) — so the only way a checkout can succeed is by reconstructing the
// order from a *signed* AP2 chain carried on the request. If you see a completed order,
// no server-side order state was involved: the signed chain was the whole transport.
import express from "express";
import {
  CredentAgent,
  completeOrder,
  MemoryVerificationStore,
  issueOrderChain,
  encodeMandateChainParam,
} from "@openmobilehub/credentagent-gate";
import { generateKeyPairSync } from "node:crypto";

const SECRET = "demo-signing-key-change-me";
const ORIGIN = "http://localhost:4000";
const PORT = 4000;

// The gate's AP2 mandate key. Generated here so the example runs with no setup; in a real
// deployment this comes from a secret manager, and `credentagent.doctor()` reports an ERROR
// if you deploy without one (every mandate stops verifying when the process restarts).
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { x, y, d } = privateKey.export({ format: "jwk" });
const mandateSigningKey = { kty: "EC", crv: "P-256", x, y, d };

// A tiny catalog — the SERVER-SIDE price authority (invariant 2). The chain carries the
// items; prices always come from here, never the token.
const PRICES = { "aurora-headphones": 199, "oak-whiskey": 124 };
const catalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const unitPrice = PRICES[it.productId] ?? 0;
      return { id: it.productId, name: it.productId, unitPrice, currency: "USD", quantity: it.quantity, lineTotal: unitPrice * it.quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total, currency: "USD" };
  },
};

const store = new MemoryVerificationStore();
const records = new Map();

const app = express();
app.use(express.json());

const credentagent = new CredentAgent({ walletOrigin: ORIGIN, store, mandateSigningKey });

// Shared completion context. `mandatePublicJwk` is what lets completion verify the chain —
// its ABSENCE is fail-closed: a chain with no key to check it against is refused, never
// waved through.
const completionCtx = {
  catalog,
  verificationStore: store,
  records: { read: (id) => records.get(id), write: (rec) => void records.set(rec.orderId, rec) },
  cart: { clear() {} },
  signingKey: SECRET,
  mandatePublicJwk: credentagent.mandateKey.publicJwk,
};

credentagent.mount(app, {
  // The order store is DELIBERATELY empty and throws — proving no server-side order state
  // is used. In a real serverless deploy this would just be "no shared store".
  orderStore: { read: () => { throw new Error("orderStore read — should not happen under statelessOrders"); } },
  catalog,
  completion: (input) => completeOrder(input, completionCtx),
  signingKey: SECRET,
  statelessOrders: true,
});

// Mint the chain that carries a demo order. (A real host does this when it creates the
// order.) Try: curl 'http://localhost:4000/issue?order=ORD-1'
app.get("/issue", async (req, res) => {
  const orderId = String(req.query.order ?? "ORD-1");
  const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], orderId);
  const { chain } = await issueOrderChain({ issuer: credentagent.ap2, order, origin: ORIGIN, merchantName: "Demo Shop" });
  res.json({ orderId, chain: encodeMandateChainParam(chain), mandates: chain });
});

app.listen(PORT, () => {
  console.log(`stateless-orders example on http://localhost:${PORT}`);
  console.log(`  0) GET  /.well-known/did.json            → the key anyone verifies these with`);
  console.log(`  1) GET  /issue?order=ORD-1               → mint a signed AP2 chain`);
  console.log(`  2) GET  /credentagent/dc-payment?order=ORD-1&chain=<b64>  → the gate page (no store read)`);
  console.log(`  3) POST /credentagent/dc-payment/verify    { order, chain, claims } → completes`);
  console.log(`Run:  bash examples/stateless-orders/demo.sh`);
});
