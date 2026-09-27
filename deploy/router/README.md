# credentagent.ai router

The Vercel project **`credentagent-router`** (team `cbg6`) owns the `credentagent.ai` and
`www.credentagent.ai` domains. Apart from one small function (`/api/ask`, below) it hosts nothing
itself — `vercel.json` forwards each path to the demo that serves it:

| Public URL | Served by |
| --- | --- |
| `https://credentagent.ai/marketplace/mcp` | `credentagent-demo` — the published npm packages |
| `https://credentagent.ai/marketplace-dev/mcp` | `credentagent-demo-dev` — `main`'s unpublished packages |
| `https://credentagent.ai/` | the product page from https://openmobilehub.org/credentagent, served under credentagent.ai (the address bar stays on credentagent.ai) |

**Why a separate project, not a domain on `credentagent-demo`:** the demo mints its checkout
and wallet links from `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel resolves to the project's
*shortest* domain. A custom domain there would move every checkout link to `credentagent.ai`
at the next deploy — where the gate pages' root paths (`/checkout`, `/credentagent/...`)
don't exist. Here only the MCP endpoint moves; checkout pages stay on each demo's own
`*.vercel.app` origin, so passkey and wallet-reader bindings are unchanged.

To add a route, add a `rewrites` entry mapping `/<name>/:path*` to the target origin.

**DNS** (GoDaddy): `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com.`

**Deploy:** the `deploy-prod` workflow deploys this project (together with the demo) whenever
`deploy/router/`, `examples/quickstart/` or the workflow itself changes on `main` (or by hand:
Actions → deploy-prod → Run workflow → `router`), from the repository root
with the project's Root Directory `deploy/router`. It then checks that `/marketplace/mcp` and
`/marketplace-dev/mcp` answer through credentagent.ai.

## `POST /api/ask` — the website demo's "Ask about your order" agent

The one thing this project runs itself (`api/ask.mjs`, logic in `lib/ask-core.mjs`, tests in
`ask.test.mjs`, run by the root `npm test`). The website's chat window sends
`{ question, context: { cartId?, orderId?, grantId? }, history? }` and gets `{ answer, tools, model }`.

- **Model:** Z.ai's free `glm-4.5-flash`, falling back to `glm-4.7-flash` (also free). Needs the
  `ZAI_API_KEY` environment variable on this project (Production); without it the endpoint answers
  `503 not_configured`.
- **Read-only by construction:** the model is offered only `get-order-status`, `get-cart`,
  `list-products`, `get-product-details`, `get-product-reviews` and `get-grant-status`, called on the
  dev store (`/marketplace-dev`, the same store the website demo uses); any other tool it names is
  refused without being called. It cannot change a cart,
  check out, or touch a grant.
- **Bounded:** questions ≤ 500 characters, ids must look like ids, the last 6 turns of history at most,
  3 tool rounds then a forced plain answer, a 10 s timeout per model call, a 25 s budget per question
  (`maxDuration` 30 s in `vercel.json`), and a best-effort 8 questions/minute per IP.
- **Same-origin only:** requests without an `https://credentagent.ai` (or localhost) `Origin` get 403.
- `ASK_STORE_MCP` overrides the store it reads (default `https://credentagent-demo-dev.vercel.app/mcp`,
  what `/marketplace-dev/mcp` rewrites to). It must match the website demo's `ENDPOINT`, or Ask AI
  can't find the visitor's cart or order.
