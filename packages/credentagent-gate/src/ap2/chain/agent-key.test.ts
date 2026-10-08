// Spec 014, FR-5: the agent's key is generated and held in the agent's process, and nothing the
// merchant imports can hold it. These pin the key's own handling and the split between the
// package root (the merchant's import) and `/agent` (the agent's).
import { describe, expect, it } from "vitest";
import * as root from "../../index.js";
import * as agentEntry from "../../agent.js";
import { AgentKey } from "./agent-key.js";
import { DelegatedIntent } from "./purchase.js";
import { testGrant } from "./test-wallet.js";

describe("the agent's key", () => {
  it("survives the agent's secret store: export, then load, is the same key", () => {
    const key = AgentKey.generate();
    const again = AgentKey.fromJwk(key.exportPrivateJwk());
    expect(again.publicJwk).toEqual(key.publicJwk);
    expect(Object.keys(key.publicJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
  });

  it("never serializes its private half — not by JSON, not by spreading it", () => {
    const key = AgentKey.generate();
    const { d } = key.exportPrivateJwk();
    expect(JSON.stringify(key)).not.toContain(d);
    expect(JSON.stringify({ ...key })).not.toContain(d);
  });

  it("refuses a stored key whose public half does not belong to its private half", () => {
    const jwk = AgentKey.generate().exportPrivateJwk();
    const other = AgentKey.generate().publicJwk;
    expect(() => AgentKey.fromJwk({ ...jwk, x: other.x, y: other.y })).toThrow(/agent key/);
  });

  it("refuses to spend a permission signed for a different agent key (bypass)", async () => {
    const g = await testGrant();
    const intent = DelegatedIntent.fromWalletPresentation({ presentation: g.presentation, disclosures: g.disclosures });
    await expect(
      intent.spend({
        agentKey: AgentKey.generate(),
        checkoutJwt: "x.y.z",
        instrument: { id: "pi_1", type: "card" },
        audience: "https://shop.example",
        nonce: "n",
      }),
    ).rejects.toThrow(/different agent key/);
  });
});

describe("two imports, two processes (FR-5)", () => {
  it("the package root — the merchant's import — exports nothing that holds the agent's key (bypass)", () => {
    expect(root).not.toHaveProperty("AgentKey");
    expect(root).not.toHaveProperty("DelegatedIntent");
    expect(root).toHaveProperty("verifyDelegatedPurchase");
  });

  it("`/agent` exports the agent's side, and not the merchant's", () => {
    expect(agentEntry).toHaveProperty("AgentKey");
    expect(agentEntry).toHaveProperty("DelegatedIntent");
    expect(agentEntry).not.toHaveProperty("verifyDelegatedPurchase");
    expect(agentEntry).not.toHaveProperty("CredentAgent");
  });
});
