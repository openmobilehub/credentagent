#!/usr/bin/env node
// The post-release catch-up edits (CONTRIBUTING.md, "After a release"). Publishing to npm changes
// nothing people see: the hosted demo runs the version pinned in examples/quickstart, and
// credentagent.ai hard-codes the version in its pages. publish.yml runs this, then opens a PR for
// each; run it by hand the same way if that job couldn't.
//
//   node scripts/post-release-bump.mjs quickstart <version>
//   node scripts/post-release-bump.mjs website <site checkout> <version> <release title> <YYYY-MM-DD>
//
// Every edit must match exactly once. A pattern that no longer matches (the site was redesigned)
// fails loudly instead of opening a PR that silently leaves the old version up. No dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const PACKAGES = ["@openmobilehub/credentagent-gate", "@openmobilehub/credentagent-storefront"];

// "v0.6.0 — an AI agent can …" → "an AI agent can …"; a title that is only the tag gives "".
export function releaseHeadline(title, version) {
  return String(title ?? "")
    .trim()
    .replace(new RegExp(`^v?${version.replace(/\./g, "\\.")}\\b`), "")
    .replace(/^\s*[—–:-]\s*/, "")
    .trim();
}

// [file, pattern, replacement] for every place the site shows the version.
export function websiteEdits({ version, title, date }) {
  const minor = version.split(".").slice(0, 2).join(".");
  const headline = releaseHeadline(title, version) || "see what's new";
  const html = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    ["index.html", /"softwareVersion":"[^"]*"/, `"softwareVersion":"${version}"`],
    ["index.html", /<span class="pill">v[\d.]+ · OPEN SOURCE<\/span>/, `<span class="pill">v${minor} · OPEN SOURCE</span>`],
    [
      "index.html",
      /href="https:\/\/github\.com\/openmobilehub\/credentagent\/releases\/tag\/v[\d.]+"><b>NEW<\/b><span>[^<]*<\/span>/,
      `href="https://github.com/openmobilehub/credentagent/releases/tag/v${version}"><b>NEW</b><span>${minor} — ${html(headline)} →</span>`,
    ],
    [
      "index.html",
      /credentagent-gate@[\d.]+ @openmobilehub\/credentagent-storefront@[\d.]+/,
      `credentagent-gate@${version} @openmobilehub/credentagent-storefront@${version}`,
    ],
    ["index.md", /^v[\d.]+ · Apache-2\.0/m, `v${minor} · Apache-2.0`],
    ["llms.txt", /Pre-1\.0 \(v[\d.]+\)/, `Pre-1.0 (v${minor})`],
    ["CLAUDE.md", /versioned in lockstep, both live at `[\d.]+`/, `versioned in lockstep, both live at \`${version}\``],
    [
      "CLAUDE.md",
      /The site reflects the published \*\*[\d.]+\*\* packages \(released [\d-]+: [\s\S]*?\)\./,
      `The site reflects the published **${version}** packages (released ${date}: ${headline}).`,
    ],
  ];
}

// Applies the edits to the files under root; throws, writing nothing, unless each matches once.
export function applyEdits(root, edits) {
  const files = new Map();
  for (const [file, pattern, replacement] of edits) {
    const text = files.get(file) ?? readFileSync(join(root, file), "utf8");
    const hits = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
    if (hits?.length !== 1) throw new Error(`${file}: expected 1 match for ${pattern}, found ${hits?.length ?? 0}`);
    files.set(file, text.replace(pattern, () => replacement));
  }
  for (const [file, text] of files) writeFileSync(join(root, file), text);
  return [...files.keys()];
}

// Points examples/quickstart at the release. Below 1.0 a caret never reaches the next minor, so
// the range has to move with every release.
export function bumpQuickstart(root, version) {
  const file = join(root, "examples/quickstart/package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const name of PACKAGES) {
    if (!pkg.dependencies?.[name]) throw new Error(`examples/quickstart/package.json: no dependency ${name}`);
    pkg.dependencies[name] = `^${version}`;
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}

function main([command, ...args]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (command === "quickstart" && SEMVER.test(args[0] ?? "")) {
    bumpQuickstart(root, args[0]);
    console.log(`examples/quickstart → ^${args[0]}`);
    return;
  }
  if (command === "website" && args.length === 4 && SEMVER.test(args[1]) && /^\d{4}-\d\d-\d\d$/.test(args[3])) {
    const [site, version, title, date] = args;
    console.log(applyEdits(site, websiteEdits({ version, title, date })).join("\n"));
    return;
  }
  console.error("usage: post-release-bump.mjs quickstart <x.y.z>\n       post-release-bump.mjs website <site dir> <x.y.z> <release title> <YYYY-MM-DD>");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
