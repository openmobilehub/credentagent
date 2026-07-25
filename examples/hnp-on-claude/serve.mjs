// HNP on Claude — the full "agent buys while you're away" store, ready to connect to Claude.
//
//   node examples/hnp-on-claude/serve.mjs                 # → http://localhost:3005/mcp
//   PUBLIC_URL=https://xxxx.ngrok.app node examples/hnp-on-claude/serve.mjs   # tunneled (for claude.ai)
//
// One server, both consent modes, all REAL library surface:
//   • human-present  — browse/cart/checkout with the age gate (credentagent.mount)
//   • human-NOT-present — create-spending-grant / spend-from-grant / revoke-grant MCP tools
//     (credentagent.grants) + the approve page at each grant's approveUrl (grants.serve)
//
// To test in the Claude app: tunnel this server (ngrok http 3005 / cloudflared tunnel --url
// http://localhost:3005), restart with PUBLIC_URL=<tunnel URL> so approve links are reachable,
// then add <tunnel URL>/mcp as a custom connector in claude.ai. Ask Claude to set up a grant,
// approve it once at the link it gives you, then tell it you're stepping away.
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 3005);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

// ── the gate's priced catalog (dollars), derived from the storefront's — ONE price source.
// minAge rides through so age-restricted items are non-delegable; category feeds allow-bounds.
const gateCatalog = Object.fromEntries(
  SAMPLE_CATALOG.map((p) => [p.id, { price: p.price, category: p.category, ...(p.minimumAge ? { minAge: p.minimumAge } : {}) }]),
);

const credentagent = new CredentAgent({ walletOrigin: PUBLIC_URL, catalog: gateCatalog });

// ── once, at startup ──────────────────────────────────────────────────────────
const store = createStorefront({ baseUrl: PUBLIC_URL, grants: credentagent.grants }); // storefront + the 4 grant tools
credentagent.mount(store.app);          // the human-present ceremony rails (/credentagent/*)
credentagent.grants.serve(store.app);   // each grant's approveUrl → a real approve/deny page

store.gate((order) => credentagent.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));

const { url } = await store.listen(PORT);
console.log(`\n  HNP-on-Claude store → MCP at ${PUBLIC_URL}/mcp (local: ${url})`);
console.log(`  Tools: browse/cart/checkout (human-present) + create-spending-grant / spend-from-grant /`);
console.log(`         get-grant-status / revoke-grant (human-NOT-present)`);
console.log(`  Grant approve pages served at ${PUBLIC_URL}/credentagent/grants/:id`);
if (!process.env.PUBLIC_URL) console.log(`\n  For claude.ai: tunnel this port, then restart with PUBLIC_URL=<tunnel URL>.`);
console.log();
