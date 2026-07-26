---
name: publish-release
description: Use when publishing the @openmobilehub/credentagent-gate and credentagent-storefront packages to npm — version bump, pre-flight audit, publish order, and the honesty gate. Publishing is a maintainer action (CI does not publish). Do NOT use for ordinary builds or CI questions.
---

# Publishing the CredentAgent packages

The authoritative checklist is [`docs/PUBLISHING.md`](../../../docs/PUBLISHING.md) —
read it first; this skill encodes the order of operations and the traps.

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

2. **Version bump** — bump both packages together; the storefront depends on the
   gate via a **semver range** (`^x.y.z`, never `workspace:*`). Keep the two package
   READMEs in sync with any API surface that changed — they are the published docs.

3. **Publish the gate FIRST, then the storefront.** The storefront's dependency only
   resolves once the gate is on the registry:

   ```bash
   npm publish -w @openmobilehub/credentagent-gate --access public
   npm publish -w @openmobilehub/credentagent-storefront --access public
   ```

   Requires `@openmobilehub` org publish rights (`npm whoami` / `npm login`). This
   is a maintainer action — **CI does not publish**.

4. **Post-publish** — the `quickstart-smoke` CI job exercises the PUBLISHED packages
   from a clean checkout; a red run after publishing means registry/example drift.

5. **Tag + GitHub release — the publish is not done until this is.** The packages
   version in lockstep, so ONE lightweight tag `vX.Y.Z` on the exact commit you
   published from marks both:

   ```bash
   git tag vX.Y.Z <published-commit> && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z — <plain-language headline>" --notes-file <notes> --latest
   ```

   Release notes are public copy — plain language for someone who didn't follow
   development, and the honesty gate (below) applies to them exactly as to the
   READMEs. Skipping this step breaks the record: 0.3.0/0.3.1 shipped untagged and
   had to be backfilled. With the tag + release in place, nothing else needs
   hand-updating: the **release + merged PR are the record** (there is no status
   file). Close any issue the release resolves.

## The honesty gate (do not regress at publish)

`trust_level` stays **`presence-only-demo`** for the OpenID4VP rails until
issuer-trust verification lands (the v0.2 line). Before publishing, re-read the two
READMEs and any changed docs: real wire crypto, **no issuer/device-signature trust
anchor**, AP2 mandate dev-signed. Never let release notes or README copy present a
presence-only gate as a real safety control.
