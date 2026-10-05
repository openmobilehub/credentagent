// `@openmobilehub/credentagent-gate/agent` — the AGENT's side of a delegated purchase (spec 014,
// FR-5). Everything here either holds or uses the agent's private key, so none of it is exported
// from the package root: a merchant imports the root, an agent imports this, and the agent's key
// never enters the merchant's process.
//
//   const agentKey = AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY!));    // or AgentKey.generate()
//   // …the merchant creates a grant naming agentKey.publicJwk; the person signs it on their phone…
//   const intent = DelegatedIntent.fromWalletPresentation(grant.mandate.intent);
//   const proof = await intent.spend({ agentKey, checkoutJwt, payment, audience, nonce });
//
// The merchant checks `proof` with `verifyDelegatedPurchase`, from the package root.
export { AgentKey } from "./ap2/chain/agent-key.js";
export type { AgentPublicJwk } from "./ap2/chain/agent-key.js";
export { DelegatedIntent } from "./ap2/chain/purchase.js";
export type { DelegatedPurchaseProof } from "./ap2/chain/purchase.js";
export type { PrivateJwkP256 } from "./ap2/keys.js";
export type { Amount, Merchant, PaymentInstrument, OpenCheckoutMandate, OpenPaymentMandate } from "./ap2/types.js";
export { DELEGATE_SD_JWT_REVISION } from "./ap2/chain/serialize.js";
