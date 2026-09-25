# credentagent.ai router

The Vercel project **`credentagent-router`** (team `cbg6`) owns the `credentagent.ai` and
`www.credentagent.ai` domains. It hosts nothing itself — `vercel.json` forwards each path to
the demo that serves it:

| Public URL | Served by |
| --- | --- |
| `https://credentagent.ai/marketplace/mcp` | `credentagent-demo` — the published npm packages |
| `https://credentagent.ai/marketplace-dev/mcp` | `credentagent-demo-dev` — `main`'s unpublished packages |
| `https://credentagent.ai/` | redirects to https://openmobilehub.org/credentagent |

**Why a separate project, not a domain on `credentagent-demo`:** the demo mints its checkout
and wallet links from `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel resolves to the project's
*shortest* domain. A custom domain there would move every checkout link to `credentagent.ai`
at the next deploy — where the gate pages' root paths (`/checkout`, `/credentagent/...`)
don't exist. Here only the MCP endpoint moves; checkout pages stay on each demo's own
`*.vercel.app` origin, so passkey and wallet-reader bindings are unchanged.

To add a route, add a `rewrites` entry mapping `/<name>/:path*` to the target origin.

**DNS** (GoDaddy): `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com.`

**Deploy:** git-connected with Root Directory `deploy/router`. By hand:
`vercel deploy --prod --scope cbg6` from a linked copy of this folder.
