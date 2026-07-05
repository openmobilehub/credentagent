# Example — run THIS repo's storefront + gate

The separate demo (`openmobilehub/mcp-apps-shopping-demo`) vendors its **own, older** copy of the
packages (the pre-rename `Attesto` API) and can't consume this repo's `attestomcp` packages until the
"flip the demo" step lands. So to exercise **the code in this repo** — the gate + storefront we
actually iterate on — boot the storefront directly. `createStorefront().listen()` is a runnable MCP
shopping server with the gate mounted on it.

## Run it

```bash
npm run build -w @openmobilehub/attestomcp-gate
npm run build -w @openmobilehub/attestomcp-storefront
node examples/run-storefront/serve.mjs        # → http://localhost:3005
```

Serves, all from this repo's code:
- `http://localhost:3005/mcp` — the MCP shopping endpoint (9 tools: browse, cart, checkout, …)
- `http://localhost:3005/attestomcp/*` — the gate's browsable checkout / approve pages
- the product-picker widget bundle

## See the ceremony end-to-end

Shopping happens through an MCP client, so connect one — the quickest is the Inspector (no account):

```bash
npx @modelcontextprotocol/inspector       # open the UI, connect to http://localhost:3005/mcp
```

Then: `browse-products` → `add-to-cart` the **Oak Whiskey** (21+) → `checkout`. Because whiskey is
age-restricted, checkout returns a `requires` manifest **plus an approve link** under `/attestomcp/…`.
Open that link in a **browser** and drive the age → passkey / dc-payment ceremony with the
**instant-demo buttons** — no phone wallet needed. The gate serving those pages is *this repo's* gate.

(Alternatively add `http://localhost:3005/mcp` as a connector in claude.ai / Claude Desktop and just ask
it to buy the whiskey.)

## Troubleshooting

- **`TypeError: Failed to fetch` / "Connection error" in the Inspector.** Two causes:
  1. **The server isn't running.** `node examples/run-storefront/serve.mjs` must be up in its own
     terminal and *stay* up — keep that terminal open while you use the Inspector.
  2. **CORS in "Direct" mode.** This harness wraps the storefront in a permissive CORS layer so
     Inspector **Direct** works; if you're on an older copy without it, switch the Inspector's
     **Connection Type** from *Direct* to the proxy option (the proxy fetches server-side, no CORS).
- **Sanity check the server from a terminal:**
  ```bash
  curl -s http://localhost:3005/mcp -X POST \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
  ```
  A `serverInfo: attestomcp-storefront` line means it's healthy.

## `statelessOrders` is ON here

This harness sets `createStorefront({ statelessOrders: true })`, so the `checkout` tool carries the
order in a **signed cart mandate on the link** — `.../checkout?order=<id>&cart=<base64url>` — instead of
a server-side order store, and the `/checkout` page + gate rails reconstruct + **verify** it. You'll see
the `cart=` payload in the checkout URL the `checkout` tool returns and in each `/attestomcp/…` approve
link. (The completion + verification stores are still server-side; `statelessOrders` only drops the
*created-order* store.) The lower-level, store-free version is [`../stateless-orders/`](../stateless-orders/).

## Note

The gate here runs in its **presence-only-demo** trust level (real wire crypto, no issuer trust anchor —
see `docs/reference/trust-model.md`).
