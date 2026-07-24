// The SENDER — the server that runs the gate and settles orders. Configured to POST every settled
// order to the receiver. Run receiver.mjs first (same secret), then this in another terminal.
//
//   CREDENTAGENT_WHSEC=whsec_demo node examples/order-webhooks/sender.mjs   # → http://localhost:4000
//   curl -X POST http://localhost:4000/buy-sticker   # settles an (ungated) order → fires the webhook
import express from "express";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const PORT = 4000;
const SECRET = process.env.CREDENTAGENT_WHSEC ?? "whsec_demo_run_both_with_this_secret";

const app = express();
app.use(express.json());

// ── once, at startup ──────────────────────────────────────────────────────────
// Declare where settled orders get POSTed. One config line turns on signed HTTP delivery.
const credentagent = new CredentAgent({
  walletOrigin: `http://localhost:${PORT}`,
  webhooks: { endpoints: [{ url: "http://localhost:4100/hooks", secret: SECRET }] },
});
credentagent.orders.serve(app);

// ── per purchase ────────────────────────────────────────────────────────────────
// An UNGATED order so it settles from the instant-demo path without a wallet — the webhook
// fires the same way a real age/payment order would once its ceremony completes.
app.post("/buy-sticker", async (_req, res) => {
  const { id } = await credentagent.orders.create({
    order: { id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 5 }] },
    policy: [],
  });
  await fetch(`http://localhost:${PORT}/credentagent/orders/${id}/place`, { method: "POST" }); // settle it
  res.json({ id, settled: true, note: "watch the receiver terminal for the signed order.settled event" });
});

app.listen(PORT, () => {
  console.log(`sender (gate) on http://localhost:${PORT}  →  webhooks POST to http://localhost:4100/hooks`);
  console.log(`  curl -X POST http://localhost:${PORT}/buy-sticker   # settle an order → fires the webhook`);
});
