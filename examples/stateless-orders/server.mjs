// Runnable example — statelessOrders (Cart Mandate as the order transport, FR-007).
//
//   node examples/stateless-orders/server.mjs      # boots on http://localhost:4000
//   bash examples/stateless-orders/demo.sh         # drives a full checkout with curl
//
// It mounts the AttestoMCP gate with `statelessOrders: true` and an EMPTY order store
// (it THROWS on read) — so the only way a checkout can succeed is by reconstructing the
// order from a *signed* cart mandate carried on the request. If you see a completed
// order, no server-side order state was involved: the signed cart was the transport.
import express from "express";
import { AttestoMCP, completeOrder, MemoryVerificationStore, issueCartMandate } from "@openmobilehub/attestomcp-gate";

const SECRET = "demo-signing-key-change-me";
const PORT = 4000;

// A tiny catalog — the SERVER-SIDE price authority (invariant 2). The cart mandate
// carries the items; prices always come from here, never the token.
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

// Shared verification store — the AttestoMCP instance and the completion seam use the same one.
const store = new MemoryVerificationStore();
const records = new Map();
const completionCtx = {
  catalog,
  verificationStore: store,
  records: { read: (id) => records.get(id), write: (rec) => void records.set(rec.orderId, rec) },
  cart: { clear() {} },
  signingKey: SECRET, // so completeOrder re-verifies + reconciles the cart mandate
};

const app = express();
app.use(express.json());

const attestomcp = new AttestoMCP({ store });
attestomcp.mount(app, {
  // The order store is DELIBERATELY empty and throws — proving no server-side order
  // state is used. In a real serverless deploy this would just be "no shared store".
  orderStore: { read: () => { throw new Error("orderStore read — should not happen under statelessOrders"); } },
  catalog,
  completion: (input) => completeOrder(input, completionCtx),
  signingKey: SECRET,
  statelessOrders: true,
});

// Helper: mint a signed cart mandate for a demo cart, and hand back the base64url
// `cart` param + the JSON body the /verify route wants. (A real host issues this when
// it creates the order.) Try: curl 'http://localhost:4000/issue?order=ORD-1'
app.get("/issue", (req, res) => {
  const orderId = String(req.query.order ?? "ORD-1");
  const priced = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], orderId);
  const mandate = issueCartMandate(
    { orderId, lines: priced.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })), currency: "USD", total: priced.total },
    SECRET,
  );
  const cart = Buffer.from(JSON.stringify(mandate)).toString("base64url");
  res.json({ orderId, cart, mandate });
});

app.listen(PORT, () => {
  console.log(`stateless-orders example on http://localhost:${PORT}`);
  console.log(`  1) GET  /issue?order=ORD-1               → mint a signed cart mandate`);
  console.log(`  2) GET  /attestomcp/dc-payment?order=ORD-1&cart=<b64>   → the gate page (no store read)`);
  console.log(`  3) POST /attestomcp/dc-payment/verify    { order, cartMandate, claims } → completes`);
  console.log(`Run:  bash examples/stateless-orders/demo.sh`);
});
