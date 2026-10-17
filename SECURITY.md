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

**Known and expected (not a vulnerability on its own).** Every rail today reports
`trust_level: "presence-only-demo"`. The wire cryptography is real — WebAuthn, OpenID4VP
JWE / ECDH-ES decryption with nonce binding, HPKE, ISO-mdoc parsing — but there is **no
issuer or device-signature trust anchor yet**: mdoc issuer and device signatures are not
checked against a real certificate authority, and the AP2-shaped mandate is dev-signed (an
integrity hash, not a key signature). So a self-crafted mdoc passes the gate. Spending
grants that opt into device signing report `trust_level: "device-signed"`: the wallet's
signature is really checked, but the payment credential behind it is self-minted, so it has
no issuer trust anchor either. The
presence-only gate is a flow demo, not a real safety control. Issuer-verified trust
(`trust_level: "issuer-verified"`) is planned for v0.2 and is not available yet. A report
that only shows this gap is already known.

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
  scripting in the ceremony pages, secrets leaking into responses or logs).

**Out of scope here.** The hosted demo marketplace and the Utopia Marketplace MCP server
live in a [separate repository](https://github.com/openwallet-foundation/multipaz-utopia);
report problems in that code there. Problems in a third-party dependency should go to that
project, though we still want to know if CredentAgent uses it in an unsafe way.
