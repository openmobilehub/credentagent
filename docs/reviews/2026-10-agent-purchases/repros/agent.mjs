// agent.mjs — the shopping agent, a different process in real life. Only the `/agent` entry point.
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";

const post = async (url, body) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

export class ShoppingAgent {
  constructor(storeUrl) { this.storeUrl = storeUrl; this.key = AgentKey.generate(); }

  async requestGrant() { return post(`${this.storeUrl}/grants`, { agentPublicJwk: this.key.publicJwk }); }

  async loadPermission(grantId) {
    const r = await fetch(`${this.storeUrl}/grants/${grantId}/intent`);
    if (!r.ok) throw new Error(`permission not ready: ${JSON.stringify(await r.json())}`);
    this.intent = DelegatedIntent.fromWalletPresentation(await r.json());
  }

  async quote(items) { return post(`${this.storeUrl}/quote`, { items }); }

  async spend(quote) {
    return this.intent.spend({
      agentKey: this.key, checkoutJwt: quote.checkoutJwt,
      instrument: { id: "pi_demo", type: "card", description: "Visa ••4242" },
      audience: quote.audience, nonce: quote.nonce,
    });
  }

  async send(proof, nonce) { return post(`${this.storeUrl}/purchase`, { proof, nonce }); }

  async buy(items) { const q = await this.quote(items); const proof = await this.spend(q); return { q, proof, result: await this.send(proof, q.nonce) }; }
}
