# CredentAgent — credentagent.ai

**The consent layer for AI agents.** Before an AI agent completes a consequential action (a
payment, an age-restricted purchase, an access grant), CredentAgent makes it get a **verifiable
credential from the user's phone wallet**. The agent sends the user a link, the user proves the
credential (a passkey, or an OpenID4VP / W3C Digital Credentials presentation), and only then does
the action complete. The check runs on the server, on the completion path.

This is the Markdown copy of https://credentagent.ai/ for AI agents. Browsers get the HTML page.

## What's on this domain

| URL | What it is |
| --- | --- |
| `https://credentagent.ai/marketplace/mcp` | A demo store as a remote MCP server (Streamable HTTP), built from the published npm packages. Add it to Claude, ChatGPT or Goose as a connector. |
| `https://credentagent.ai/marketplace-dev/mcp` | The same store built from `main`'s unreleased code. It may change or break without notice. |
| `https://credentagent.ai/marketplace-dev/…` | The dev store's checkout and consent pages. Its tools return these links. The production store's links still point at its own `*.vercel.app` address. Either way, the user opens them in a browser. |
| `https://credentagent.ai/` | The product page (HTML), or this file when the request sends `Accept: text/markdown`. |
| `https://credentagent.ai/index.md` | This file, without content negotiation. |

## Try it as an agent

1. Connect `https://credentagent.ai/marketplace/mcp` as a remote MCP server.
2. Browse the catalog (`browse-products`, `list-products`), add an item (`add-to-cart`), then call
   `checkout`. The store keeps no session between calls: pass the `cartId` from each result to the
   next call (or pass `items` to `checkout`), or checkout finds an empty cart.
3. `checkout` returns a checkout link and a `requires` list naming what the buyer must prove (every
   order needs a payment step; 21+ items, such as the whiskey, also need an age proof). Give the link
   to the user. The order completes only after that step is done on the checkout page (a wallet
   presentation, or the demo's walletless "instant demo" button); `get-order-status` reports it.

The store's MCP tools can't complete a gated checkout on their own: the proof is a separate step on
the checkout page, meant for the user. Hand the link to the user and don't attempt that step
yourself. This is a demo, not a real age or payment control (see below).

The store also has spending-grant tools (`create-spending-grant`, `get-grant-status`,
`spend-from-grant`, `revoke-grant`): the user approves a bounded spending limit once at a link, and
the agent can then buy within it without the user present. Grants are the same presence-only demo.

## Build with it

Two Apache-2.0 npm packages (ESM, Node ≥ 20, types included):

- [`@openmobilehub/credentagent-gate`](https://www.npmjs.com/package/@openmobilehub/credentagent-gate):
  the Gate. `new CredentAgent()`, `credentagent.mount(app)` and a credential policy
  (`age.over(21)`, `membership.discount(10)`, `payment.in("usd")`). Mounts on any Express-style app.
- [`@openmobilehub/credentagent-storefront`](https://www.npmjs.com/package/@openmobilehub/credentagent-storefront):
  `createStorefront()`, a runnable MCP shopping server that the Gate mounts onto. The demo store
  above is this package.

```sh
npm install @openmobilehub/credentagent-gate
```

- Source, docs and the 5-minute quickstart: https://github.com/openmobilehub/credentagent
- Quickstart: https://github.com/openmobilehub/credentagent/tree/main/examples/quickstart
- API reference: https://github.com/openmobilehub/credentagent/blob/main/docs/reference/api.md
- Trust model: https://github.com/openmobilehub/credentagent/blob/main/docs/reference/trust-model.md

## What it does not do yet

The checkout gates and spending grants report `trust_level: "presence-only-demo"`. The wire
cryptography is real (WebAuthn bound to the checkout page's origin, OpenID4VP decryption with nonce
binding, ISO mdoc parsing), but there is no issuer trust anchor yet: the gate checks that the right
claim was disclosed and bound to this request, not who issued it. A self-made credential would pass.
The demo store also has an "instant demo" button on its checkout pages that sends self-asserted
claims (such as `age_over_21: true`) for both the age and the payment step, with no wallet at all.
So don't rely on it as a real age or payment control. Issuer-verified trust is planned, not shipped
yet.

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
