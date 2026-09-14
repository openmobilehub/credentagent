// LOCAL E2E HARNESS (untracked) — the whole store exactly as it would be on main once #148
// merges: the merged tree, both fixes applied, nothing stubbed.
//
// It is examples/hnp-on-claude/serve.mjs (MCP + checkout + grant tools + approve pages) PLUS
// one DEVICE-signed grant minted at boot — because the MCP create-spending-grant tool only
// makes page-approve grants, so the spec-012 rail is otherwise unreachable through an agent.
//
//   PUBLIC_URL=https://<tunnel> node .e2e-merged.mjs
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 4040);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

const gateCatalog = Object.fromEntries(
  SAMPLE_CATALOG.map((p) => [p.id, { price: p.price, category: p.category, ...(p.minimumAge ? { minAge: p.minimumAge } : {}) }]),
);

const credentagent = new CredentAgent({ walletOrigin: PUBLIC_URL, catalog: gateCatalog });
const store = createStorefront({ baseUrl: PUBLIC_URL, grants: credentagent.grants, merchant: "utopia" });
credentagent.mount(store.app);
credentagent.grants.serve(store.app);
store.gate((order) => credentagent.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));

await store.listen(PORT);

// The spec-012 rail: a grant the WALLET must sign before anything can be spent against it.
const device = await credentagent.grants.create({
  merchant: "utopia",
  budget: 200,
  perSpend: 130,
  // Electronics + Home are delegable; Beverages is deliberately INCLUDED so the age
  // refusal is demonstrable too — both drinks in the catalog are 21+, and age NEVER delegates.
  allow: { categories: ["Electronics", "Home", "Beverages"] },
  signing: "device",
  description: "Desk supplies while I'm away — up to $200 at Utopia, $130 per purchase.",
});

console.log(`\n  MCP connector      → ${PUBLIC_URL}/mcp`);
console.log(`  Storefront         → ${PUBLIC_URL}`);
console.log(`\n  DEVICE-signed grant (sign this on the phone):`);
console.log(`    ${device.approveUrl}`);
console.log(`    grantId = ${device.id}`);
console.log(`\n  Then tell Claude:  "spend from grant ${device.id} on coffee"\n`);

let last = "";
setInterval(async () => {
  const g = await credentagent.grants.retrieve(device.id);
  const u = await g.usage();
  const line = `device grant: ${g.status} · trust=${g.trustLevel} · doctype=${g.mandate?.credentialDoctype ?? "—"} · spent $${u.spent}/${u.budget}`;
  if (line === last) return;
  last = line;
  console.log(`  → ${line}`);
}, 1000);
