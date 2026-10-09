// bugs.mjs — reproduce two suspected defects against the cold reader's store (README pattern).
import { devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";
import { createStore, ORIGIN } from "./store.mjs";
import { ShoppingAgent } from "./agent.mjs";

const server = createStore().listen(4200);
try {
  const agent = new ShoppingAgent(ORIGIN);
  const { grantId } = await agent.requestGrant();
  const signReq = await (await fetch(`${ORIGIN}/credentagent/grants/${grantId}/sign/request`)).json();
  const result = await devSimulateWalletSignature({ request: { request: signReq.requests[0].data.request, dcql_query: signReq.dcql_query }, origin: ORIGIN });
  await fetch(`${ORIGIN}/credentagent/grants/${grantId}/sign/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readerContextToken: signReq.readerContextToken, result }) });
  await agent.loadPermission(grantId);

  // BUG 1: spend() called the way the ap2-multistore demo calls it — `payment: {...}` instead of `instrument`.
  const q = await agent.quote([{ sku: "tea" }]);
  const proof = await agent.intent.spend({ agentKey: agent.key, checkoutJwt: q.checkoutJwt, payment: { instrument: { id: "x", type: "card" } }, audience: q.audience, nonce: q.nonce });
  const r1 = await agent.send(proof, q.nonce);
  console.log("BUG1 spend with no instrument → merchant says:", r1.ok ? "ACCEPTED (no payment instrument in the signed payment)" : r1);

  // BUG 2: two purchases at once under a $50 budget, $9.50 already spent: two $22 coffees → $53.50.
  const [a, b] = await Promise.all([agent.quote([{ sku: "coffee" }]), agent.quote([{ sku: "coffee" }])]);
  const [pa, pb] = await Promise.all([agent.spend(a), agent.spend(b)]);
  const [ra, rb] = await Promise.all([agent.send(pa, a.nonce), agent.send(pb, b.nonce)]);
  console.log("BUG2 concurrent:", JSON.stringify(ra), JSON.stringify(rb), "→ spent", (rb.spentSoFar ?? ra.spentSoFar));
} finally { server.close(); }
