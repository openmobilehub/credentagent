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
`{ question, context: { cartId?, orderId?, grantId? }, history? }` and gets `{ answer, tools, model, app? }`.

- **Model:** Z.ai's `glm-5` (paid, ~$0.005 a question from the account's prepaid balance — it can't
  overspend), then `glm-4.5-air` if it's overloaded, then the free `glm-4.5-flash`, which also covers a
  spent balance (logged as `1113`). A 429 is retried with backoff first; the last model always keeps 8 s of
  the budget. `glm-5` because editing the cart needs it: `glm-4.5-air` claimed edits it never made. Needs
  the `ZAI_API_KEY` environment variable on this project (Production); without it the endpoint answers
  `503 not_configured`.
- **Reads the store, edits only the cart — never checks out:** the model is offered the store's read
  tools (`browse-products`, `get-order-status`, `get-cart`, `list-products`, `get-product-details`,
  `get-product-reviews`, `get-grant-status`) plus the cart edits `add-to-cart`, `set-quantity` and
  `remove-from-cart`, called on the dev store (`/marketplace-dev`, the same store the website demo uses)
  with the visitor's own signed `cartId`. `checkout` and every grant write are refused without being
  called: the visitor checks out in the picker, where 21+ items ask for their wallet proof.
- **No claimed edit without a real one:** if an answer says the cart changed but no cart tool ran for that
  question (small models copy earlier "Added …" replies from the history), the model gets one corrective
  round; if it still calls no tool, the answer is replaced by "I didn't change your cart just then".
- **MCP Apps:** when the model calls a tool that declares an MCP App (`_meta.ui.resourceUri`, e.g.
  `browse-products` → the product picker), the reply carries `app: { tool, resourceUri, result }` with the
  store's full result, and the page renders that `ui://` resource as any MCP host would (a cart edit
  refreshes the open picker). Whatever the visitor does in the app (add to cart, checkout) goes page →
  store through the app bridge, never through the model. If the model drops the cartId, the page's `context.cartId` fills it in on cart tools.
- **Bounded:** questions ≤ 500 characters, ids must look like ids, the last 6 turns of history at most,
  3 tool rounds then a forced plain answer, a 10 s timeout per model call, a 25 s budget per question
  (`maxDuration` 30 s in `vercel.json`), and a best-effort 8 questions/minute per IP.
- **Same-origin only:** requests without an `https://credentagent.ai` (or localhost) `Origin` get 403.
- `ASK_STORE_MCP` overrides the store it reads (default `https://credentagent-demo-dev.vercel.app/mcp`,
  what `/marketplace-dev/mcp` rewrites to). It must match the website demo's `ENDPOINT`, or Ask AI
  can't find the visitor's cart or order.
