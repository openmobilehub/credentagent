// negative.mjs — does a cart with a negative-quantity line get through verifyDelegatedPurchase on main?
// The store here is the cold reader's README-pattern store: it builds the cart from the agent's items, as the
// README and the multi-store demo both leave to the merchant.
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

  // coffee $22 + tea x(-1) $9.50 → total $12.50 for a $22 coffee
  const r = await agent.buy([{ sku: "coffee" }, { sku: "tea", qty: -1 }]);
  console.log("coffee + (-1) tea →", JSON.stringify(r.result));
  // tea x(-2) alone → negative total
  const r2 = await agent.buy([{ sku: "tea", qty: -2 }]);
  console.log("(-2) tea →", JSON.stringify(r2.result));
  // zero quantity
  const r3 = await agent.buy([{ sku: "coffee", qty: 0 }]);
  console.log("(0) coffee →", JSON.stringify(r3.result));
} finally { server.close(); }
