# Example — `statelessOrders` (Cart Mandate as the order transport)

A runnable, hands-on way to exercise what the gate does when the order isn't stored server-side: the
**signed cart mandate** carries the order, and a checkout completes on an instance whose order store is
**empty** (serverless / multi-instance). See [FR-007](../../specs/004-cart-mandate/spec.md) and the
[`statelessOrders` reference](../../docs/reference/api.md#statelessorders-mount-seam-option-default-off).

## Run it

```bash
# 1) build the gate (once), so the example can import the published dist:
npm run build -w @openmobilehub/attestomcp-gate

# 2) boot the example server:
node examples/stateless-orders/server.mjs        # → http://localhost:4000

# 3) in another terminal, drive a full checkout with curl:
bash examples/stateless-orders/demo.sh
```

## What you should see

```
① mint a signed cart mandate …            cart param length: ~442 chars
② GET the gate page …                      HTTP 200   (empty/throwing store never touched)
③ POST verify … → completed: true          (all four amount/auth gates pass)
④ BYPASS: tamper the cart …                completed: false   (fails closed)
```

The order-store in the example **throws** on read, so a `200` / `completed:true` *proves* no
server-side order state was used — the signed cart was the whole transport. Tampering any field breaks
the HMAC signature, so `verifyCartMandate` refuses and the order won't resolve.

## The wire contract (what the client sends)

- **GET** page / request — `?order=<id>&cart=<base64url(JSON mandate)>`
- **POST** `/attestomcp/dc-payment/verify` — `{ "order": "<id>", "cartMandate": { … }, "claims": { … } }`

The catalog **still re-prices** — the mandate carries the *items*, never the *price*. Turn the mode off
(default) and the same host uses the order store instead; the client then carries only the order id.
