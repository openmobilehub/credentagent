---
name: publish-release
description: Use when releasing the @openmobilehub/credentagent-gate and credentagent-storefront packages — version bump, pre-flight audit, tag + GitHub release, and the honesty gate. The GitHub release triggers CI (publish.yml) to publish to npm; the maintainer NEVER runs `npm publish` by hand. Do NOT use for ordinary builds or CI questions.
---

# Releasing the CredentAgent packages

The authoritative checklist is [`docs/PUBLISHING.md`](../../../docs/PUBLISHING.md) —
read it first; this skill encodes the order of operations and the traps.

**The GitHub release IS the publish trigger.** `.github/workflows/publish.yml` runs on
`release: published` and publishes both packages to npm (gate first, then storefront —
the order is encoded in the workflow). **Never run `npm publish` by hand**: a manual
publish makes the release-triggered run fail on the already-published versions — exactly
what happened with v0.3.1 (published manually 2026-07-26; the release then fired run
30213999549, which went red on the duplicate).

## Order of operations (the order is load-bearing)

1. **Pre-flight** — run the full audit in `docs/PUBLISHING.md`: clean build from a
   wiped `dist/`, `exports` maps resolve, the storefront's runtime asset
   `dist/ui/mcp-app.html` is in the tarball (`npm pack --dry-run`), no heavy/demo
   deps leaked into `dependencies`, LICENSE + README in `files`, and the full suite
   green **including the security bypass tests**:

   ```bash
   npm run build        # builds both workspaces' dist/
   npm test
   npm run lint
   ```

2. **Version bump** — bump both packages together in a PR and merge it; the
   storefront depends on the gate via a **semver range** (`^x.y.z`, never
   `workspace:*`). Keep the two package READMEs in sync with any API surface that
   changed — they are the published docs.

3. **Tag + GitHub release — this is the publish.** One lightweight tag `vX.Y.Z` on
   the exact merged bump commit (the packages version in lockstep, so one tag marks
   both), then publish the release; `publish.yml` ships both packages to npm from it
   (requires the repo's `NPM_TOKEN` secret — no local npm login involved):

   ```bash
   PUBLISHED_COMMIT=abc1234        # <- substitute the merged bump commit, then run:
   git tag vX.Y.Z "$PUBLISHED_COMMIT" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z — a plain-language headline" --notes-file notes.md --latest
   ```

   Release notes are public copy — plain language for someone who didn't follow
   development, and the honesty gate (below) applies to them exactly as to the
   READMEs. Skipping the release breaks the record AND the publish: 0.3.0/0.3.1
   shipped tagless via manual publishes and had to be backfilled.

4. **Post-publish** — watch the `publish` workflow run go green, confirm
   `npm view @openmobilehub/credentagent-gate version` shows the new version, then
   open the **quickstart catch-up PR** (bump `examples/quickstart` to the new
   versions): that PR's `quickstart-smoke` job is the real post-publish check — it
   clean-installs the PUBLISHED packages — and `deployed-smoke` re-runs the same
   assertions against the live demo once the merge deploys. Nothing else to
   hand-update: the **release + merged PRs are the record** (there is no status
   file). Close any issue the release resolves.

## The honesty gate (do not regress at publish)

`trust_level` stays **`presence-only-demo`** for the OpenID4VP rails until
issuer-trust verification lands (the v0.2 line). Before releasing, re-read the two
READMEs and any changed docs: real wire crypto, **no issuer/device-signature trust
anchor**, AP2 mandate dev-signed. Never let release notes or README copy present a
presence-only gate as a real safety control.
