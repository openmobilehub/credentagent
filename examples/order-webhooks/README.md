# `order-webhooks/` — get told over HTTP when an order settles

`credentagent.on("order.settled", …)` only fires **inside the process that settled the order**.
When your fulfillment runs on a *different* service (or a different instance), you need a real
**webhook**: the gate sends a signed HTTP `POST` to a URL you registered, and that other service
verifies it. This is the Stripe idiom — if you've used `stripe.webhooks.constructEvent`, you already
know this API.

```js
// ── SENDING — the server that settles orders (configure once) ──
const credentagent = new CredentAgent({
  walletOrigin: "https://shop.example",
  webhooks: { endpoints: [{ url: "https://fulfillment.example/hooks", secret: process.env.WHSEC }] },
});
credentagent.orders.serve(app);
// …an order settles → a SIGNED order.settled event is POSTed to the endpoint. No delivery code to write.

// ── RECEIVING — a different service; only the shared secret ──
import { constructEvent } from "@openmobilehub/credentagent-gate";
app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get("CredentAgent-Signature"), process.env.WHSEC);
  } catch (err) {
    return res.status(400).send(`webhook signature failed: ${err.message}`); // forged / tampered / replayed
  }
  if (event.type === "order.settled") fulfill(event.data.object.orderId); // dedupe on event.id
  res.json({ received: true });
});
```

## Run it (two terminals)

```bash
npm run build

# terminal 1 — the receiver (a separate service)
CREDENTAGENT_WHSEC=whsec_demo node examples/order-webhooks/receiver.mjs   # → :4100

# terminal 2 — the gate (settles orders, sends webhooks)
CREDENTAGENT_WHSEC=whsec_demo node examples/order-webhooks/sender.mjs     # → :4000
curl -X POST http://localhost:4000/buy-sticker
```

Watch terminal 1: it prints the verified `order.settled` event. Use the **same** `CREDENTAGENT_WHSEC`
in both — that shared secret is what proves the event came from your gate.

## Prove it (one command, no browser)

```bash
node examples/order-webhooks/smoke.mjs
```

Boots both a sender and a receiver, settles an order over real HTTP, and asserts: the receiver got
exactly one **verified** `order.settled` event carrying the settled order — and a **forged** POST
(signed with the wrong secret) is rejected with `400` and never recorded.

## What's real, and what to know

- **Real signature.** HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with your `whsec_` secret,
  in a `CredentAgent-Signature: t=…,v1=…` header — the same scheme Stripe uses. A forged, tampered,
  wrong-secret, or **stale** (replayed) event is rejected. This is a genuine security control, not a demo.
  (It's unrelated to the `presence-only-demo` trust level, which is about wallet/mdoc issuer trust.)
- **At-least-once delivery.** The gate retries with backoff; your receiver may see the same event
  twice — **dedupe on `event.id`**. There is no guaranteed/exactly-once delivery.
- **Non-blocking.** Delivery is fire-and-forget from the completion path; a slow or dead receiver
  never blocks or rolls back a settled order. For the durable, cross-instance source of truth, read
  `orders.retrieve(id)` (backed by a shared completed-order store).
- **Endpoints are trusted config**, not user input. Use https in production; keep the secret in env.
- **Multi-instance:** put endpoints in `new CredentAgent({ webhooks: { endpoints } })` so every
  instance signs alike. `webhooks.register(...)` is a runtime convenience but is process-local.
