#!/usr/bin/env node
// Refuses a release whose version has no CHANGELOG.md entry.
//
//   node scripts/check-changelog.mjs              # the packages' version (both must agree)
//   node scripts/check-changelog.mjs v0.6.0       # a release tag or a bare version
//   node scripts/check-changelog.mjs 0.6.0 --file path/to/CHANGELOG.md
//   node scripts/check-changelog.mjs --tag v0.6.0   # release mode: the tag must also equal
//                                                   # the packages' version
//
// Passes only if the changelog has a `## [X.Y.Z] - YYYY-MM-DD` heading with at least one
// non-blank line under it. Exits 1 otherwise, saying why. The root `npm test` runs it against
// the real changelog (scripts/check-changelog.test.ts), and publish.yml runs `npm test` before
// any `npm publish` — so a version bump without its changelog entry cannot reach npm.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["credentagent-gate", "credentagent-storefront"];

function fail(message) {
  console.error(`check-changelog: ${message}`);
  process.exit(1);
}

function packageVersion() {
  const versions = PACKAGES.map(
    (dir) => JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")).version,
  );
  if (new Set(versions).size !== 1) {
    fail(`the packages must version in lockstep, but read ${PACKAGES.map((p, i) => `${p}@${versions[i]}`).join(", ")}`);
  }
  return versions[0];
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return { value: undefined, rest: args };
  if (!args[at + 1]) fail(`${name} needs a value`);
  return { value: args[at + 1], rest: args.filter((_, i) => i !== at && i !== at + 1) };
}

const { value: fileArg, rest: afterFile } = option(process.argv.slice(2), "--file");
const { value: tag, rest: positional } = option(afterFile, "--tag");
const file = fileArg ?? join(root, "CHANGELOG.md");
let version = (positional[0] ?? packageVersion()).replace(/^v/, "");
if (tag !== undefined) {
  // Release mode: the tag being published must be the version the packages carry.
  const fromPackages = packageVersion();
  if (tag.replace(/^v/, "") !== fromPackages) {
    fail(`the release tag ${tag} does not match the packages' version ${fromPackages}`);
  }
  version = fromPackages;
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`"${version}" is not a version`);

if (!existsSync(file)) fail(`${file} does not exist`);
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  fail(`${file} has no "## [${version}] - YYYY-MM-DD" section. Move the [Unreleased] entries under it before tagging (docs/PUBLISHING.md).`);
}
const next = lines.findIndex((line, i) => i > start && /^## /.test(line));
const body = lines.slice(start + 1, next === -1 ? undefined : next);
if (!body.some((line) => line.trim() !== "")) fail(`the [${version}] section in ${file} is empty`);

console.log(`check-changelog: CHANGELOG.md has an entry for ${version}`);
