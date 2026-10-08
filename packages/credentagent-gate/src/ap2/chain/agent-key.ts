// The agent's key — `K_s` in spec 014 — generated and held in the AGENT's process (FR-5).
//
// The open mandates the person signs name this key's public half in `cnf`; spending them needs
// the private half. So the private half is the permission's spending power, and the one rule
// here is that it never reaches the merchant: a merchant hands the gate the PUBLIC key
// (`grants.create({ agentKey: agent.publicJwk })`) and never imports this module, which is only
// reachable from the `/agent` entry point.
//
// The private key is a `#private` field, so it cannot be logged, spread or `JSON.stringify`d by
// accident; taking it out for storage is one call whose name says what it does —
// `exportPrivateJwk()`.
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { importPrivateJwk, type PrivateJwkP256 } from "../keys.js";

/** The agent key's public half, exactly as it goes into a mandate's `cnf`. */
export interface AgentPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/**
 * The agent's own P-256 key. Configure once, then spend permissions with it.
 *
 * ```ts
 * const agentKey = AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY!)); // or AgentKey.generate()
 * // Hand the merchant ONLY agentKey.publicJwk — it goes into the grant the person signs.
 * ```
 */
export class AgentKey {
  /** The public half — what the merchant puts in the grant, and the person's wallet signs over. */
  readonly publicJwk: AgentPublicJwk;
  readonly #privateKey: KeyObject;

  private constructor(privateKey: KeyObject, x: string, y: string) {
    this.publicJwk = { kty: "EC", crv: "P-256", x, y };
    this.#privateKey = privateKey;
  }

  /** A fresh key. Store `exportPrivateJwk()` in the agent's secret store, or it is gone at exit. */
  static generate(): AgentKey {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { x, y } = privateKey.export({ format: "jwk" }) as { x: string; y: string };
    return new AgentKey(privateKey, x, y);
  }

  /** A key the agent stored earlier — a PRIVATE P-256 JWK. Refused when `x` / `y` do not belong to `d`. */
  static fromJwk(jwk: PrivateJwkP256): AgentKey {
    const { privateKey, x, y } = importPrivateJwk(jwk, "agent key");
    return new AgentKey(privateKey, x, y);
  }

  /** The PRIVATE JWK, for the agent's own secret store. Never send it to a merchant. */
  exportPrivateJwk(): PrivateJwkP256 {
    return this.#privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;
  }

  /** Does `jwk` name this key? Compares the point, ignoring any extra members. */
  matches(jwk: unknown): boolean {
    const j = jwk as Partial<AgentPublicJwk> | undefined;
    return j?.kty === "EC" && j.crv === "P-256" && j.x === this.publicJwk.x && j.y === this.publicJwk.y;
  }

  /** Keeps the private half out of logs and serialized state. */
  toJSON(): { publicJwk: AgentPublicJwk } {
    return { publicJwk: this.publicJwk };
  }
}

/**
 * The signing key, for this package's own hop signer. Not exported from any entry point.
 *
 * Read through `exportPrivateJwk()` rather than a back door: whoever holds an `AgentKey` can
 * already export it, so this grants nothing new. What `#privateKey` guards against is the
 * ACCIDENTAL leak — a log line, a spread, a serialized state blob — not a deliberate call.
 */
export function agentPrivateKey(agentKey: AgentKey): KeyObject {
  if (!(agentKey instanceof AgentKey)) throw new Error("not an AgentKey — make one with AgentKey.generate() or AgentKey.fromJwk()");
  return createPrivateKey({ key: agentKey.exportPrivateJwk() as unknown as Record<string, unknown>, format: "jwk" });
}
