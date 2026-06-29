# Deployment & troubleshooting

Running Attesto for real (beyond `node examples/storefront.mjs`). Most of this is about one
thing: **on serverless, every invocation may be a different instance**, so per-order state
and the challenge key must be shared, not in-memory.

## Serverless checklist

- **Inject shared stores.** The defaults are in-memory — fine for a single dev process, wrong
  for serverless. Provide Redis-backed (or any shared) implementations of the cart, the
  created-order store, the completed-order store, and the verification store. Without this,
  the checkout page lands on a cold instance that never saw the order / the proven age / the
  completion, and the flow silently breaks.
- **Set a stable `signingKey`.** The passkey `options` and `verify` calls (and Cart Mandate
  issue/verify) may hit different instances. Pass a fixed `signingKey` (e.g.
  `process.env.GATE_SECRET`) so the sealed challenge / mandate verifies across instances.
  A per-process ephemeral key works only for a single process.
- **Bind the wallet origin.** `new Attesto({ walletOrigin: "https://shop.example" })` — wallet
  ceremonies (OpenID4VP / WebAuthn) are origin-bound; a localhost origin in production is
  refused by wallets.
- **Ship the widget bundle.** `createStorefront()` reads its widget HTML at runtime via
  `readFile` (it is *not* import-traced). On a bundler/serverless host (e.g. Vercel
  `includeFiles`), make sure `@openmobilehub/attesto-storefront`'s `dist/ui/**` is included in
  the function, or the widget resource 404s.

## Settlement (the `settle` seam)

`createStorefront({ settle })` runs `settle(order)` after the payment gates pass. It is
**fail-closed**: if `settle` throws, completion records nothing and the cart stays intact
(authorized-but-not-settled). The amount is re-derived server-side from the (already
re-priced) order — never a client figure. `settle` is your integration point for an on-chain
or PSP settlement; see `examples/with-x402-settlement.mjs`.

## Troubleshooting

| Symptom | Likely cause |
| :-- | :-- |
| Checkout page says "unknown order" / loses proven age | In-memory stores on multi-instance serverless — inject shared stores. |
| Passkey "challenge expired / invalid" only in prod | No stable `signingKey` — `options` and `verify` hit different instances. |
| Widget resource 404s after deploy | The package's `dist/ui/**` isn't bundled into the function (`includeFiles`). |
| Wallet refuses the request / nothing opens | `walletOrigin` is localhost or scheme-less in production. |
| A completed order can still be "re-paid" from the browser back button | Stale bfcache restore — the shared checkout page reloads on `pageshow`; ensure you're serving the package's page, not a cached copy. |
| Discount accepted by one path, refused by another | The discount must be a **gate effect** the host re-prices into the total — don't apply it only on one rail. |
| A gated order completes with no proof | A completion path isn't enforcing server-side. Every completion path (`/verify` handlers, the host's place-order / MCP tool) must run the gates — hiding a button is not enforcement. |

## Honest status

The OpenID4VP rails are `trust_level: "presence-only-demo"` — real wire crypto, **no issuer
trust anchor yet**. Do not put a presence-only gate in front of anything that needs a real
safety guarantee until issuer-verified trust lands (see [ROADMAP](../ROADMAP.md)).
