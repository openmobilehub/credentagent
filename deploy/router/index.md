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
| `https://credentagent.ai/marketplace/…`, `/marketplace-dev/…` | The store's checkout and consent pages. The store's tools return these links; open them in a browser, not from an agent. |
| `https://credentagent.ai/` | The product page (HTML), or this file when the request sends `Accept: text/markdown`. |
| `https://credentagent.ai/index.md` | This file, without content negotiation. |

## Try it as an agent

1. Connect `https://credentagent.ai/marketplace/mcp` as a remote MCP server.
2. Browse the catalog (`browse-products`, `list-products`), add an item (`add-to-cart`), then call
   `checkout`.
3. For an age-restricted item (the whiskey is 21+), `checkout` returns a checkout link and a
   `requires` list naming the credentials it needs. Give the link to the user. The order completes
   only after the user proves those credentials in their wallet; `get-order-status` reports it.

An agent cannot complete a gated checkout by itself, and should not try: the proof comes from the
user's wallet on the user's device.

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

The checkout gates report `trust_level: "presence-only-demo"`. The wire cryptography is real
(WebAuthn bound to this origin, OpenID4VP decryption with nonce binding, ISO mdoc parsing), but
there is no issuer trust anchor yet: the gate checks that the right claim was disclosed and bound
to this request, not who issued it. A self-made credential would pass. Don't rely on it as a real
age or payment control. Issuer-verified trust is the next milestone.

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
