# Publishing the CredentAgent packages

Release checklist for the two npm packages extracted from this repo:

- **`@openmobilehub/credentagent-gate`** — the credential/payment Gate (`new CredentAgent()`, `credentagent.mount(app)`).
- **`@openmobilehub/credentagent-storefront`** — the reference storefront (`createStorefront()`).

Both are at `0.2.0`, Apache-2.0, ESM, ship their own types, and declare `publishConfig.access: public`
(required for a scoped public package).

## Pre-flight (verified by the pre-publish audit)

- [x] Both build clean from a wiped `dist/` — `npm run -w @openmobilehub/credentagent-gate build`,
      `npm run -w @openmobilehub/credentagent-storefront build`.
- [x] `exports` maps resolve to emitted files: gate `.`; storefront `.` and `./server`.
- [x] The storefront's runtime asset `dist/ui/mcp-app.html` (read via `readFile` at request time) **is**
      in the tarball (`npm pack --dry-run` confirms). The `files` allowlist covers it via `"dist"`.
- [x] No heavy/demo deps leak into either package's `dependencies` or built `dist` (no `@upstash/redis`,
      `@hashgraph/sdk`, `cors`, `react`). Hedera/Upstash appear only as UI copy strings; settlement is the
      injected `settle?` seam.
- [x] `@simplewebauthn/browser` (resolved at runtime by the passkey rail) is a declared gate dependency.
- [x] LICENSE + README present in both packages and in `files`.
- [x] Full suite green (`npm test`) including the security bypass tests.

## Publish order (load-bearing)

`@openmobilehub/credentagent-storefront` depends on `@openmobilehub/credentagent-gate` via a semver range
(`^0.2.0`, **not** `workspace:*`), so it only resolves once the gate is on the registry:

1. Publish **`@openmobilehub/credentagent-gate@0.2.0`** first.
2. Then publish **`@openmobilehub/credentagent-storefront@0.2.0`**.

```bash
npm run build                                            # build both workspaces' dist/
npm publish -w @openmobilehub/credentagent-gate --access public
npm publish -w @openmobilehub/credentagent-storefront --access public
```

> Requires `@openmobilehub` org publish rights on npm (`npm whoami` / `npm login`). This is a
> maintainer action — CI does not publish.

## Optional polish (non-blocking, deferred)

- `@modelcontextprotocol/sdk`, `zod`, `express` are regular `dependencies` of the storefront. They are
  correct as-is (the storefront *is* the MCP server), but if hosts are expected to instantiate their own
  MCP SDK / zod, consider moving those to `peerDependencies` to avoid duplicate instances. Decide before
  a `1.0`.
- The redundant `"dist/ui"` entry in the storefront `files` array (already covered by `"dist"`) can be
  dropped.

## Honesty gate (do not regress at publish)

`trust_level` stays **`presence-only-demo`** for the OpenID4VP rails: real wire crypto (JWE/ECDH-ES, nonce
binding, HPKE, mdoc parse) and **real** WebAuthn on the passkey rail, but **no issuer/device-signature
trust anchor** yet, and the AP2 mandate is dev-signed. Issuer-trust verification is the v0.2 line. The
READMEs fence this honestly per rail — keep it that way; never present a presence-only gate as a real
safety control.
