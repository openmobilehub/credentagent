# credentagent.ai router

The Vercel project **`credentagent-router`** (team `cbg6`) owns the `credentagent.ai` and
`www.credentagent.ai` domains. Apart from one small function (`/api/ask`, below) it hosts nothing
itself — `vercel.json` forwards each path to the demo that serves it:

| Public URL | Served by |
| --- | --- |
| `https://credentagent.ai/marketplace/mcp` | `credentagent-demo` — the published npm packages |
| `https://credentagent.ai/marketplace-dev/mcp` | `credentagent-demo-dev` — `main`'s unpublished packages |
| `https://credentagent.ai/marketplace-dev/checkout?…` and the other store pages | `credentagent-demo-dev` — its checkout and consent pages (see below) |
| `https://credentagent.ai/` | the product page from https://openmobilehub.org/credentagent, served under credentagent.ai (the address bar stays on credentagent.ai) |

**Why a separate project, not a domain on `credentagent-demo`:** a demo mints its checkout and
wallet links from `PUBLIC_URL`, falling back to `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel
resolves to the project's *shortest* domain. A custom domain on a demo would silently move its
links whenever that ordering changes; `PUBLIC_URL` states the address outright.

**Store pages under credentagent.ai (#226):** `deploy-dev.yml` sets the dev demo's `PUBLIC_URL` to
`https://credentagent.ai/marketplace-dev`. The gate and storefront then put `/marketplace-dev` on
every checkout link, consent-page fetch and redirect, so a buyer stays on credentagent.ai end to
end — the router strips the prefix on the way in. The wallet binds to the page's origin
(`https://credentagent.ai`, from the forwarded host), so passkeys and wallet requests name
credentagent.ai. The prod demo keeps its `*.vercel.app` links until a release carries this (0.5.0's
pages use root paths); then set `PUBLIC_URL=https://credentagent.ai/marketplace` in `deploy-prod.yml`.

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

- **Models (paid from prepaid balances — they can't overspend):** two chains, both starting on Nebius
  Token Factory's `openai/gpt-oss-120b` (~$0.0007 a question, ~1.5 s; 36/36 in a live cart-editing
  bake-off, the store's cart checked after every turn — see the comment on `MODELS` in `lib/ask-core.mjs`).
  Reads then fall back to Z.ai's `glm-4.5-air` and the free `glm-4.5-flash`. A question that asks to change
  the cart ("add the mouse", "make it 2", "one more"), and the corrective round when an answer claims an
  edit no tool made, use the cart-edit chain: Nebius `zai-org/GLM-5.3-Flash`, Z.ai `glm-5`, then
  `glm-4.5-flash` — never `glm-4.5-air`, which claimed edits it never made. The free `glm-4.5-flash` also
  covers spent balances (Z.ai logs `1113`). A 429 is retried with backoff first; the last model always keeps
  8 s of the budget. Needs `NEBIUS_API_KEY` and `ZAI_API_KEY` on this project (Production); a missing key
  skips that provider's models, and with no usable model the endpoint answers `503 not_configured`.
- **Swapping models / providers:** any OpenAI-compatible provider listed in `PROVIDERS` in
  `lib/ask-core.mjs` — today `zai` (`ZAI_API_KEY`) and `nebius` (`NEBIUS_API_KEY`). Set `ASK_MODELS` (reads)
  and/or `ASK_EDIT_MODELS` (cart edits) on this project to a comma-separated `provider:model-id` chain, e.g.
  `zai:glm-5,zai:glm-4.5-flash`, and redeploy; unset, the defaults above apply. An unknown provider fails
  the function at start. Adding a provider is one `PROVIDERS` line (URL, key variable, provider-only fields).
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
