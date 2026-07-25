# `demo-hub/` — see CredentAgent work, in one page

A single page where you click through every shipped capability yourself — no code, and no wallet
for the quick path. It's built on the **real library** (`credentagent.orders.serve()` +
`credentagent.webhooks`), so what you see is what ships.

```bash
npm run build
node examples/demo-hub/hub.mjs      # → open http://localhost:4000
```

## What you can do

1. **Drive a checkout.** Click *Buy a $5 sticker pack* → the agent mints an order and hands you a
   link → open it → *Complete purchase* (no wallet). Or *Buy $21 wine* to see the real **21+ age
   gate** (finish that one on your phone).
2. **Watch the webhook fire — signed.** When the order settles, the gate POSTs a **signed** event
   to a separate service (also running in this app). Its **live feed** on the page shows the
   `order.settled` event arrive with **✓ signature verified** and the order details — the moment you
   complete a checkout. That's the cross-service notification, made visible.

## What's honest about it

- The signature is **real** HMAC-SHA256; a forged event is rejected (see `GUARANTEES.md`).
- The wallet trust level is `presence-only-demo` — no issuer anchor yet — and **no real money moves**.
- The self-serve path uses an *ungated* item so it completes with a click; a real age/payment order
  always finishes through the phone ceremony.
