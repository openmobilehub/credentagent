// Repro: published package metadata + README links point at the archived demo repo
// (openmobilehub/mcp-apps-shopping-demo) instead of this repo (openmobilehub/credentagent).
// Local-only: reads files in this checkout and `npm pack`s each package (no network).
// Run from the repo root:  node docs/reviews/2026-10-agent-purchases/repros/npm-metadata-404.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const DEMO = "openmobilehub/mcp-apps-shopping-demo";
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
console.log(`root package.json repository (ground truth for this repo): ${rootPkg.repository.url}`);
const rootReadme = readFileSync(join(ROOT, "README.md"), "utf8");
const archivedLine = rootReadme.split("\n").find((l) => /archived/i.test(l));
console.log(`root README says about the demo repo: ${archivedLine?.trim()}\n`);

let bad = 0;

// 1. package.json metadata — both the source file and the exact tarball npm would publish.
for (const name of ["credentagent-gate", "credentagent-storefront"]) {
  const dir = join(ROOT, "packages", name);
  const tmp = mkdtempSync(join(tmpdir(), "pack-"));
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp, "--json"], {
    cwd: dir, encoding: "utf8",
  });
  const parsed = JSON.parse(out); // array, or (in a workspace) an object keyed by package name
  const tgz = join(tmp, (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).filename);
  const shipped = JSON.parse(execFileSync("tar", ["-xOzf", tgz, "package/package.json"], { encoding: "utf8" }));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`== ${shipped.name}@${shipped.version} (from npm pack tarball)`);
  for (const [field, url] of [
    ["homepage", shipped.homepage],
    ["repository.url", shipped.repository?.url],
    ["bugs.url", shipped.bugs?.url],
  ]) {
    const wrong = url.includes(DEMO);
    if (wrong) bad++;
    console.log(`  ${wrong ? "WRONG" : "ok   "} ${field}: ${url}`);
  }
}

// 2. README links into the demo repo whose target file actually lives in THIS repo.
console.log("\n== package README links to the demo repo");
for (const readme of ["packages/credentagent-gate/README.md", "packages/credentagent-storefront/README.md"]) {
  const lines = readFileSync(join(ROOT, readme), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/https:\/\/github\.com\/openmobilehub\/mcp-apps-shopping-demo(?:\/(?:blob|tree)\/main\/([^)#\s]*))?/g)) {
      const target = m[1];
      if (!target) {
        console.log(`  ${readme}:${i + 1}  repo-root link (prose: "still being extracted from the reference server")`);
        continue;
      }
      const here = existsSync(join(ROOT, target));
      if (here) bad++;
      console.log(`  ${readme}:${i + 1}  ${target}  -> ${here ? "EXISTS in this repo (link should point here)" : "not in this repo"}`);
    }
  });
}

console.log(`\n${bad} wrong-repo references found`);
process.exit(bad ? 1 : 0);
