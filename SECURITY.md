# Security policy

CredentAgent is a consent layer: an AI agent must prove a verifiable credential before a
payment, an age gate or an access grant completes. A bug that lets an agent skip that step
is exactly what we want to hear about, and we would rather hear it privately first.

## Supported versions

Both packages, [`@openmobilehub/credentagent-gate`](./packages/credentagent-gate) and
[`@openmobilehub/credentagent-storefront`](./packages/credentagent-storefront), are
released together and share a version number. The project is pre-1.0, so only the latest
minor release line receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | ✅ Yes     |
| < 0.5   | ❌ No — upgrade to 0.5.x |

A fix ships as a new patch release on the supported line. There are no backports to older
versions.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.** A public
report shows the attack to everyone before a fix exists.

Report it privately through GitHub instead:

1. Go to the repository's [**Security** tab](https://github.com/openmobilehub/credentagent/security).
2. Choose **Report a vulnerability**.
3. Fill in the form. Only you and the maintainers can see it.

Please include:

- the **affected version** (package name and version, or a commit hash);
- **steps to reproduce** — ideally a minimal script against the packages or an
  [`examples/`](./examples) app, or the URL and each click in order;
- the **impact** — what an attacker gains (for example, "an unverified agent completes an
  age-restricted order"), and which [security invariant](./SECURITY-INVARIANTS.md) it
  breaks, if you know.

## What to expect

| Step | Target time |
| ---- | ----------- |
| Acknowledgement that we received your report | within **3 business days** |
| First assessment — confirmed or not, and how severe | within **10 business days** |
| Fix released, or a disclosure plan agreed with you | within **90 days** of the report |

We keep you updated in the private advisory as we work. Once a fix is released we publish
a GitHub security advisory and credit you, unless you ask us not to. Please give us the
time above before disclosing publicly; if we need longer, we will tell you why and agree a
new date with you.

## What is in scope — and what is already known

Read the [trust model](./docs/reference/trust-model.md) and the
[security invariants](./SECURITY-INVARIANTS.md) before you report. They state plainly what
the gate does and does not verify today.

**Known and expected (not a vulnerability on its own).** The gate itself never checks an
issuer's signature against a trusted certificate authority, so no level it reports on its
own is backed by a real trust anchor:

- The built-in checkout rails (passkey, credential, dc-payment) report
  `trust_level: "presence-only-demo"`. The wire cryptography is real — WebAuthn, OpenID4VP
  JWE / ECDH-ES decryption with nonce binding, HPKE, ISO-mdoc parsing — but mdoc issuer and
  device signatures are not checked against a real certificate authority. So a
  self-crafted mdoc passes the gate. The AP2-shaped payment mandate is not key-signed
  either: the passkey rail's carries a dev integrity hash, and the dc-payment rail's
  carries none.
- Spending grants that opt into device signing report `trust_level: "device-signed"`: the
  credential's own signature and the wallet's signature are really checked, but the
  payment credential is self-minted, so its certificate chains to no trusted root.
- Grants issued by `DelegatedGate`, and spending grants approved by a click on the server's
  page, report `trust_level: "server-issued-demo"` by default: the server, not a wallet,
  vouches for them.

These levels mark flow demos, not real safety controls. In-gate issuer verification is on
the roadmap. Today, `trust_level: "issuer-verified"` appears only when the host supplies it — for
example an external `verifier` passed to `mount()` that reports it — and the gate relays it
unchanged.
A report that only shows one of these known gaps is already known.

**In scope.** Anything that breaks what the gate *does* claim to enforce today, for
example:

- a violation of one of the six rules in [SECURITY-INVARIANTS.md](./SECURITY-INVARIANTS.md)
  — completing an order without passing the gate, trusting a hand-edited order token, a
  discount that breaks amount binding, one user's verification unlocking another's
  checkout, accepting a missing or wrong claim (an 18+ proof for a 21+ gate), or a
  presentation accepted from the wrong origin or with a replayed nonce;
- a presence-only result being reported as `"issuer-verified"`, or any other way the
  `trust_level` overstates what was checked;
- the usual web and Node.js issues in the packages themselves (injection, cross-site
  scripting in the ceremony pages, secrets leaking into responses or logs);
- the hosted demo marketplace at [credentagent.ai/marketplace](https://credentagent.ai/marketplace),
  which is built and deployed from [`examples/quickstart`](./examples/quickstart) in this
  repository.

**Out of scope here.** The Utopia Marketplace MCP server lives in a
[separate repository](https://github.com/openwallet-foundation/multipaz-utopia); report
problems in that code there. Problems in a third-party dependency should go to that
project, though we still want to know if CredentAgent uses it in an unsafe way.
