// Walking a delegation chain (Delegate SD-JWT §6): the root against its own certificate, each hop
// against the key the link before it names, every hop bound to its predecessor.
//
// Every "(bypass)" test here must fail when its control is deleted. The splice tests share ONE
// wallet key on purpose: two chains signed by different keys are refused at the signature, which
// would let a binding test pass without its binding ever running.
import { describe, expect, it } from "vitest";
import { appendAgentHop, bindingHash } from "./hop.js";
import { joinChain, splitChain, walletChain } from "./serialize.js";
import { sdJwtInstance } from "../sdjwt.js";
import { verifyChain } from "./verify.js";
import { newWallet, p256, sign, testGrant } from "./test-wallet.js";
import { VCT } from "../types.js";

const MERCHANT = "https://other-shop.example";
const closedCheckout = { vct: VCT.checkout, checkout_jwt: "h.p.s", checkout_hash: "hash" };

async function chainFor(opts: Parameters<typeof testGrant>[0] = {}, which: 0 | 1 = 0) {
  const g = await testGrant(opts);
  const prefix = walletChain(g.presentation, g.disclosures[which]);
  const chain = await appendAgentHop({ chain: prefix!, agentKey: g.agent.privateKey, content: closedCheckout, audience: MERCHANT, nonce: "n-1" });
  return { g, prefix: prefix!, chain };
}

const verify = (chain: string, over: Partial<Parameters<typeof verifyChain>[1]> = {}) =>
  verifyChain(chain, { audience: MERCHANT, nonce: "n-1", ...over });

describe("a well-formed chain", () => {
  it("verifies, and hands back the open and the closed mandate", async () => {
    const { g, chain } = await chainFor();
    const v = await verify(chain);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.open).toEqual(g.open[0]);
    expect(v.closed).toEqual(closedCheckout);
    expect(v.credential.vct).toBe("com.emvco.dpc");
    expect(v.links).toHaveLength(3);
  });

  it("walletChain discloses exactly the mandate it was given", async () => {
    const g = await testGrant();
    const prefix = walletChain(g.presentation, g.disclosures[1])!;
    expect(prefix.endsWith(`~~${g.presentation.split("~").at(-1)}~${g.disclosures[1]}~`)).toBe(true);
    expect(walletChain(g.presentation.replace(/~[^~]*$/, "~"), g.disclosures[1])).toBeUndefined(); // no KB-JWT
  });
});

describe("structure and keys", () => {
  // Only the three-link AP2 shape is evaluated. A two-link chain — a wallet hop with no purchase
  // under it — must not pass as a purchase whose agent hop was "checked".
  it("refuses a chain that is not exactly three links (bypass)", async () => {
    const g = await testGrant();
    expect(await verify(walletChain(g.presentation, g.disclosures[0])!)).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/^expected `<credential>/) });
  });

  it("refuses a single SD-JWT as if it were a chain", async () => {
    const g = await testGrant();
    expect(await verify(g.presentation.replace(/[^~]*$/, ""))).toMatchObject({ ok: false, code: "malformed" });
  });

  it("refuses a root with no certificate to check it against (bypass)", async () => {
    const { chain } = await chainFor({ omitX5c: true });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "root" });
  });

  it("refuses a wallet hop signed by a key the credential does not name (bypass)", async () => {
    const { chain } = await chainFor({ forgeWalletKey: true });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "signature", detail: expect.stringMatching(/^link 1/) });
  });

  // Spec 014: "the agent key is the one cnf endorses".
  it("refuses an agent hop signed by a key the open mandate's cnf does not name (bypass)", async () => {
    const { prefix } = await chainFor();
    const chain = await appendAgentHop({ chain: prefix, agentKey: p256().privateKey, content: closedCheckout, audience: MERCHANT, nonce: "n-1" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "signature", detail: expect.stringMatching(/^link 2/) });
  });
});

describe("each hop is bound to the one before it", () => {
  // Same wallet, same agent, two grants: every signature in the spliced chain is genuine. Only
  // the binding hash can tell that the agent's hop was made for a different wallet hop.
  it("refuses an agent hop lifted onto another grant's wallet hop (bypass)", async () => {
    const wallet = await newWallet();
    const agent = p256();
    const a = await chainFor({ wallet, agent, grantId: "grant-a" });
    const b = await chainFor({ wallet, agent, grantId: "grant-b", perSpend: 5000 });
    const agentHopA = a.chain.slice(a.prefix.length - 1 + 2); // after "<prefix minus ~>~~"
    const spliced = `${b.prefix.slice(0, -1)}~~${agentHopA}`;
    expect(await verify(spliced)).toMatchObject({ ok: false, code: "binding", detail: expect.stringMatching(/^link 2/) });
  });

  it("refuses a wallet hop lifted onto another credential (bypass)", async () => {
    const wallet = await newWallet();
    const a = await testGrant({ wallet });
    const b = await testGrant({ wallet }); // same holder key, a freshly issued credential
    const credentialB = b.presentation.slice(0, b.presentation.lastIndexOf("~") + 1);
    const walletHopA = a.presentation.slice(a.presentation.lastIndexOf("~") + 1);
    const prefix = walletChain(`${credentialB}${walletHopA}`, a.disclosures[0])!;
    const chain = await appendAgentHop({ chain: prefix, agentKey: a.agent.privateKey, content: closedCheckout, audience: MERCHANT, nonce: "n-1" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "binding", detail: expect.stringMatching(/^link 1/) });
  });

  it("refuses a hop that carries no binding hash at all (bypass)", async () => {
    const { prefix, g } = await chainFor();
    // Minted by hand: `appendAgentHop` always binds, so the unbound hop has to be built without it.
    const unbound = await sdJwtInstance({ privateKey: g.agent.privateKey }).issue(
      { iat: Math.floor(Date.now() / 1000), aud: MERCHANT, nonce: "n-1", delegate_payload: [closedCheckout] } as never,
      { delegate_payload: { _sd: [0] } } as never,
      { header: { typ: "kb+sd-jwt" } },
    );
    const chain = joinChain([prefix, unbound]);
    expect(await verify(chain)).toMatchObject({ ok: false, code: "binding", detail: expect.stringMatching(/exactly one of sd_hash/) });
  });
});

describe("typ and disclosure rules (§5.1.4, §6)", () => {
  // A wallet hop that names the agent's key in `cnf` is one that may be delegated again, so it
  // must say so. `kb+sd-jwt` means "the end of the chain" — and the AP2 Python SDK refuses it.
  it("refuses a wallet hop typed as terminal while naming a next key (bypass)", async () => {
    const { chain } = await chainFor({ walletTyp: "kb+sd-jwt" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "typ", detail: expect.stringMatching(/^link 1/) });
  });

  // A wallet hop that names no next key cannot be followed: there is no key to check the agent by.
  it("refuses a wallet hop that names no key for the agent (bypass)", async () => {
    const { chain } = await chainFor({ walletTyp: "kb+sd-jwt", mapOpen: ({ cnf: _cnf, ...m }) => m });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "typ", detail: expect.stringMatching(/^link 1: names no key/) });
  });

  it("refuses a hop with no iat (bypass)", async () => {
    const { prefix, g } = await chainFor();
    const undated = await sdJwtInstance({ privateKey: g.agent.privateKey }).issue(
      { aud: MERCHANT, nonce: "n-1", sd_hash: bindingHash(splitChain(prefix)!.at(-1)!), delegate_payload: [closedCheckout] } as never,
      { delegate_payload: { _sd: [0] } } as never,
      { header: { typ: "kb+sd-jwt" } },
    );
    expect(await verify(joinChain([prefix, undated]))).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/numeric iat/) });
  });

  it("refuses an agent hop that names a further key (bypass)", async () => {
    const { prefix, g } = await chainFor();
    const chain = await appendAgentHop({ chain: prefix, agentKey: g.agent.privateKey, content: { ...closedCheckout, cnf: { jwk: p256().publicJwk } }, audience: MERCHANT, nonce: "n-1" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "typ", detail: expect.stringMatching(/^link 2/) });
  });

  // §5.1.4: "exactly one of these MUST be disclosed". Disclosing both open mandates would let the
  // agent's single closed hop sit under whichever one a verifier happened to read.
  it("refuses a wallet hop that discloses both open mandates (bypass)", async () => {
    const g = await testGrant();
    const both = `${walletChain(g.presentation, g.disclosures[0])!}${g.disclosures[1]}~`;
    const chain = await appendAgentHop({ chain: both, agentKey: g.agent.privateKey, content: closedCheckout, audience: MERCHANT, nonce: "n-1" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "disclosure", detail: expect.stringMatching(/^link 1.*exactly one/) });
  });

  it("refuses a disclosure the wallet never signed (bypass)", async () => {
    const g = await testGrant();
    const other = await testGrant({ grantId: "other" });
    const chain = await appendAgentHop({ chain: walletChain(g.presentation, other.disclosures[0])!, agentKey: g.agent.privateKey, content: closedCheckout, audience: MERCHANT, nonce: "n-1" });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "disclosure" });
  });
});

describe("the agent's hop is addressed to this merchant, now", () => {
  it("refuses a wrong audience and a wrong nonce (bypass)", async () => {
    const { chain } = await chainFor();
    expect(await verify(chain, { audience: "https://evil.example" })).toMatchObject({ ok: false, code: "audience" });
    expect(await verify(chain, { nonce: "n-2" })).toMatchObject({ ok: false, code: "nonce" });
  });

  // The open mandate expires in a minute; the credential under it lives an hour. Ten minutes on,
  // only the mandate's own `exp` can refuse — the library never sees it, it sits in a disclosure.
  it("refuses an expired open mandate (bypass)", async () => {
    const { chain } = await chainFor({ openTtlSec: 60 });
    expect(await verify(chain, { nowMs: Date.now() + 600_000 })).toMatchObject({ ok: false, code: "expired", detail: expect.stringMatching(/^link 1: exp=/) });
  });

  it("refuses an open mandate with no exp — it would never end (bypass)", async () => {
    const { chain } = await chainFor({ mapOpen: ({ exp: _exp, ...m }) => m });
    expect(await verify(chain)).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/needs an exp/) });
  });
});

describe("the algorithm pin", () => {
  // `es256Verify` ignores the header's `alg`, so a link CLAIMING another algorithm would still
  // verify on its signature. The pin is what refuses it: only ES256 is ever signed here, so only
  // ES256 is ever read.
  it("REFUSES a link whose header names an algorithm other than ES256, however good its signature (bypass)", async () => {
    const { g, chain } = await chainFor();
    const links = splitChain(chain)!;
    const hop = links[2];
    const [, payload] = hop.jwt.split(".");
    for (const alg of ["HS256", "none", "ES384"]) {
      const header = Buffer.from(JSON.stringify({ alg, typ: "kb+sd-jwt" })).toString("base64url");
      const resigned = `${header}.${payload}.${sign(g.agent.privateKey)(`${header}.${payload}`)}`;
      const relabelled = joinChain([...links.slice(0, 2), { ...hop, jwt: resigned }].map((l) => `${l.jwt}~${l.disclosures.map((d) => `${d}~`).join("")}`));
      expect(await verify(relabelled)).toMatchObject({ ok: false, code: "signature" });
    }
  });
});
