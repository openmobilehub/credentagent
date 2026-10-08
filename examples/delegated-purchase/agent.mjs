// delegated-purchase/agent.mjs — the AGENT's process. Spawned by merchant.mjs; run that instead.
//
// It imports `/agent` and nothing else from the package: its key is generated here, used here, and
// never sent anywhere. Only `agentKey.publicJwk` and the finished proof leave this process.
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";

// A real agent loads a stored key: AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)).
const agentKey = AgentKey.generate();
process.send({ publicJwk: agentKey.publicJwk });

process.once("message", async ({ intent, checkoutJwt, audience, nonce }) => {
  const permission = DelegatedIntent.fromWalletPresentation(intent); // plain JSON — an agent would store it
  const proof = await permission.spend({
    agentKey,
    checkoutJwt,
    instrument: { id: "demo-instrument-0001", type: "card" }, // the payee and amount are the cart's own
    audience,
    nonce,
  });
  console.log(`[agent]    spent the permission on one purchase → ${proof.checkout.split("~~").length} links per chain`);
  process.send({ proof });
});
