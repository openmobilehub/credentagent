// The CredentAgent quickstart — a credential-gated agentic storefront.
//   npm i && npm start    # → http://localhost:3005/mcp  (add it to Claude / ChatGPT / Goose)
//   npm run smoke         # assert the gate contract end-to-end
// Deployed (Vercel): api/index.mjs serves this SAME app — set GATE_SECRET (see README).
import { fileURLToPath } from "node:url";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
// Namespace import so the NEW grant-store export is feature-detected — this same file runs in CI
// against the PUBLISHED 0.3.1 packages (which lack it), and a named import of a missing export
// would throw at load. `redisStorage` (0.3.1) comes off the same namespace.
import * as sfRedis from "@openmobilehub/credentagent-storefront/redis";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const deployed = !!process.env.VERCEL; // serverless: instances share no memory, so an
if (deployed && !process.env.GATE_SECRET) // ephemeral per-instance key can't work — refuse.
  throw new Error("GATE_SECRET is required on a deployment — generate one with: openssl rand -hex 32");
const kv = { url: process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN };
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL; // set by Vercel at runtime
const walletOrigin = origin && `https://${origin}`;

// The priced catalog (dollars) the grants resource prices + bounds delegated spends from —
// derived from the SAME storefront catalog so a grant's allow-bounds and the checkout agree.
const grantCatalog = Object.fromEntries(
  SAMPLE_CATALOG.map((p) => [p.id, { price: p.price, category: p.category, ...(p.minimumAge ? { minAge: p.minimumAge } : {}) }]),
);
// Durable grant state across serverless instances (fixes the cross-instance "unknown grant").
// Feature-detected: undefined against 0.3.1 (in-memory fallback) or when no Redis env is set.
// GRANTS_NAMESPACE isolates this deployment's grant keys from anything else sharing the database.
const grantStore = sfRedis.redisGrantStoreFromEnv
  ? sfRedis.redisGrantStoreFromEnv({ namespace: process.env.GRANTS_NAMESPACE })
  : undefined;
// The grants resource lives on the CredentAgent, so construct it BEFORE the storefront wires it in.
const credentagent = new CredentAgent({ walletOrigin, catalog: grantCatalog, ...(grantStore ? { grantStore } : {}) });

const store = createStorefront({
  signingKey: process.env.GATE_SECRET,
  statelessOrders: deployed, // the signed cart mandate carries the order between instances
  statelessMcp: deployed, // no per-instance MCP session — survives Vercel's instance split
  // Storage namespace from env (default unchanged) so a shared Redis database stays isolated per deployment.
  storage: kv.url && kv.token ? sfRedis.redisStorage({ ...kv, namespace: process.env.STORAGE_NAMESPACE }) : undefined,
  baseUrl: walletOrigin,
  grants: credentagent.grants, // human-NOT-present: adds create/get/spend/revoke grant tools
  merchant: "Utopia", // the merchant a created grant is sealed + audited as
});
credentagent.mount(store.app); // wires the /credentagent/* ceremony rails onto this server
credentagent.grants.serve(store.app); // grant.approveUrl → a real approve/deny page on this server

store.gate((order) => credentagent.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)), // 10% off with a loyalty credential
  required(payment.in("usd")), // amount derived server-side from the order; settles last
]));

export const app = store.app;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await store.listen(Number(process.env.PORT ?? 3005));
  console.log(`\n  ✓ CredentAgent quickstart → ${url}\n`);
}
