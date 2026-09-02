# Example — `statelessOrders` (Cart Mandate as the order transport)

A runnable, hands-on way to exercise what the gate does when the order isn't stored server-side: the
**signed AP2 chain** carries the order, and a checkout completes on an instance whose order store is
**empty** (serverless / multi-instance). See [FR-007](../../specs/004-cart-mandate/spec.md) (superseded on the wire by [spec 013](../../specs/013-ap2-v2-wire-format/spec.md)) and the
[`statelessOrders` reference](../../docs/reference/api.md#statelessorders-mount-seam-option-default-off).

## Run it

```bash
# 1) build the gate (once), so the example can import the published dist:
npm run build -w @openmobilehub/credentagent-gate

# 2) boot the example server:
node examples/stateless-orders/server.mjs        # → http://localhost:4000

# 3) in another terminal, drive a full checkout with curl:
bash examples/stateless-orders/demo.sh
```

## What you should see

```
① mint a signed AP2 chain …               chain param length: ~1.4k chars
② GET the gate page …                      HTTP 200   (empty/throwing store never touched)
③ POST verify … → completed: true          (all four amount/auth gates pass)
④ BYPASS: tamper the chain …               completed: false   (fails closed)
```

The order-store in the example **throws** on read, so a `200` / `completed:true` *proves* no
server-side order state was used — the signed chain was the whole transport. Tampering any field breaks
the ES256 signature, so `verifyChain` refuses and the order won't resolve.

## The wire contract (what the client sends)

- **GET** page / request — `?order=<id>&chain=<base64url(JSON chain)>`
- **POST** `/credentagent/dc-payment/verify` — `{ "order": "<id>", "chain": { "checkout": "…", "payment": "…" }, "claims": { … } }`

The catalog **still re-prices** — the mandate carries the *items*, never the *price*. Turn the mode off
(default) and the same host uses the order store instead; the client then carries only the order id.
