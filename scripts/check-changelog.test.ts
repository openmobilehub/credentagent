import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The release guard: publish.yml runs `npm test` before any `npm publish`, so the first test
// here is what stops a version bump without its CHANGELOG.md entry from reaching npm.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-changelog.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

function fixture(content: string) {
  const file = join(mkdtempSync(join(tmpdir(), "changelog-")), "CHANGELOG.md");
  writeFileSync(file, content);
  return file;
}

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- Something new.

## [0.2.0] - 2026-07-01

## [0.1.0] - 2026-06-28

### Added

- First release.
`;

describe("check-changelog", () => {
  it("passes for the real CHANGELOG.md at the packages' current version", () => {
    const { version } = JSON.parse(readFileSync(join(here, "../packages/credentagent-gate/package.json"), "utf8"));
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(version);
  });

  it("release mode passes for the tag that matches the packages' version", () => {
    const { version } = JSON.parse(readFileSync(join(here, "../packages/credentagent-gate/package.json"), "utf8"));
    expect(run("--tag", `v${version}`).status).toBe(0);
  });

  it("release mode refuses a tag that doesn't match the packages' version", () => {
    const { version } = JSON.parse(readFileSync(join(here, "../packages/credentagent-gate/package.json"), "utf8"));
    // Both sections exist, so only the tag/version comparison can refuse this.
    const both = fixture(`## [999.0.0] - 2026-06-28\n\n- x\n\n## [${version}] - 2026-06-28\n\n- y\n`);
    const result = run("--tag", "v999.0.0", "--file", both);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the packages' version");
  });

  it("passes for a release tag whose section exists", () => {
    expect(run("v0.1.0", "--file", fixture(SAMPLE)).status).toBe(0);
  });

  it("refuses a version with no section", () => {
    const result = run("0.3.0", "--file", fixture(SAMPLE));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no \"## [0.3.0] - YYYY-MM-DD\" section");
  });

  it("refuses a version that appears only inside another version", () => {
    expect(run("0.1.0", "--file", fixture("## [10.1.0] - 2026-06-28\n\n- x\n")).status).toBe(1);
    expect(run("0.1.0", "--file", fixture("## [0.1.0-rc.1] - 2026-06-28\n\n- x\n")).status).toBe(1);
  });

  it("refuses something that is not a version", () => {
    expect(run("latest", "--file", fixture(SAMPLE)).status).toBe(1);
  });

  it("refuses a section with nothing under it", () => {
    const result = run("0.2.0", "--file", fixture(SAMPLE));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("empty");
  });

  it("refuses an empty file", () => {
    expect(run("0.1.0", "--file", fixture("")).status).toBe(1);
  });

  it("refuses a missing file", () => {
    const result = run("0.1.0", "--file", join(tmpdir(), "no-such-dir-376", "CHANGELOG.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });
});
