# Publishing the CredentAgent packages

Release checklist for the two npm packages extracted from this repo:

- **`@openmobilehub/credentagent-gate`** — the credential/payment Gate (`new CredentAgent()`, `credentagent.mount(app)`).
- **`@openmobilehub/credentagent-storefront`** — the reference storefront (`createStorefront()`).

Both version in lockstep (bump them together), Apache-2.0, ESM, ship their own types, and declare
`publishConfig.access: public` (required for a scoped public package).

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

## How a release ships (the GitHub release IS the publish trigger)

`.github/workflows/publish.yml` publishes **both** packages to npm when a GitHub release is
**published** — gate first, then storefront (load-bearing: the storefront depends on the gate
via a semver range, `^x.y.z` and **not** `workspace:*`, which only resolves once the gate is on
the registry; the workflow encodes that order and uses the repo's `NPM_TOKEN` secret).

**Never run `npm publish` by hand.** A manual publish makes the release-triggered run fail on
the already-published versions — exactly what happened with v0.3.1: published manually
2026-07-26, release created after, and the `publish` run went red on the duplicate. The manual
path also skips the record: 0.3.0/0.3.1 shipped tagless and had to be backfilled.

1. **Version bump** — bump both packages together (lockstep) in a PR; merge it. See
   [the version-bump trap](#the-version-bump-trap-npm-version-does-not-do-all-of-it) below —
   `npm version` does **not** finish the job, and the way it fails looks like a source bug.
2. **Tag + release — this is the publish.** One lightweight tag per release on the merged bump
   commit (lockstep versions ⇒ one tag marks both), then publish the release:

   ```bash
   PUBLISHED_COMMIT=abc1234        # <- substitute the merged bump commit, then run:
   git tag vX.Y.Z "$PUBLISHED_COMMIT" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z — a plain-language headline" --notes-file notes.md --latest
   ```

3. **Verify** — watch the `publish` run go green and `npm view` show the new versions, then open
   the **quickstart catch-up PR** (bump `examples/quickstart` to the new versions): that PR's
   `quickstart-smoke` is the real post-publish check — a clean install of the PUBLISHED
   packages — and `deployed-smoke` re-runs the same assertions against the live demo once the
   merge deploys.

Release notes are **public copy, written for someone who didn't follow development**: plain
language, each feature stated by what it does for the integrator, and the honesty gate (below)
applies to them exactly as it does to the READMEs — never let notes present a presence-only gate
as a real safety control.

## The version-bump trap (`npm version` does not do all of it)

`npm version X.Y.Z -w …` bumps each package's own `version`, but it does **not** rewrite the
storefront's dependency range on the gate. That line has to be edited **by hand**:

```jsonc
// packages/credentagent-storefront/package.json
"@openmobilehub/credentagent-gate": "^0.4.0",   // <- edit this yourself
```

**Why it matters:** `^0.3.1` means `>=0.3.1 <0.4.0`. Leave it and you publish a 0.4.0
storefront that resolves a **0.3.x** gate off the registry — the two packages version in
lockstep precisely so this can't happen, and this is the one line that enforces it.

**The symptom, if you forget.** In the intermediate state (workspace gate already bumped,
storefront still asking for the old range) npm can no longer satisfy the range from the
workspace, so it installs the **published** old gate into a nested
`packages/credentagent-storefront/node_modules/`. TypeScript then resolves the gate to that
stale copy and the build fails naming a symbol that is new in the release:

```
src/server.ts(63,8): error TS2305: Module '"@openmobilehub/credentagent-gate"'
  has no exported member 'Branding'.
```

That reads like the export is missing or the barrel is broken. It isn't — the export is fine
and the resolution is stale. **Fix the range, then run a plain `npm install`** (not
`--package-lock-only`, which updates the lockfile without touching `node_modules` and leaves
the nested copy in place). Confirm with:

```bash
node -p "const g=require('./packages/credentagent-gate/package.json'),s=require('./packages/credentagent-storefront/package.json');JSON.stringify({gate:g.version,storefront:s.version,dep:s.dependencies['@openmobilehub/credentagent-gate']})"
```

All three must read the new version. (Hit while cutting 0.4.0 — PR #162.)

> **Check exit codes, not piped output.** `npm run build 2>&1 | tail` returns *`tail`'s*
> status, so a `cmd | tail && next` chain marches straight past a failing build. Use
> `set -o pipefail`, or capture to a file and echo `$?`, whenever a pre-flight result is
> going to be reported as green.

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
