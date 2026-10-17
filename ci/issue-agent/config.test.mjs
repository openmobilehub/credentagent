// The issue agent in another repo (config.mjs, README "Using it in another repo"): the repo's own
// commands reach the gates, the test-proof check, the prompts and the PR — and a config the pipeline
// can't use is refused by name instead of quietly weakening a gate.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, CONFIG_PATH, validateConfig, loadConfig, testLabel, checkCommand } from "./config.mjs";
import { testGateCommand, isMutableSource, rootTestRefusal, publishVerdict } from "./checks.mjs";
import { forRepo } from "./roles.mjs";
import * as libraryRoles from "./roles.mjs";
import { fingerprints, withinBaseline } from "./fingerprints.mjs";
import { prBody } from "./report.mjs";

// A static site with node --test and no build — shaped like openmobilehub/credentagent-website's.
const SITE = validateConfig({
  install: null,
  build: null,
  gates: [{ name: "test", cmd: ["node", "--test", "tests/*.test.mjs"] }],
  fastTest: null,
  testRunner: ["node", "--test"],
  testFile: "^tests/.+\\.test\\.mjs$",
  source: "^[^/]+\\.(html|md|txt|xml)$",
  sourceExclude: "^(README|CLAUDE)\\.md$",
  testSummary: "(?<=^[#ℹ] )(?:pass|fail) \\d+$",
  checkTools: ["Bash(node --test*)"],
  focusedTest: "node --test <file>",
  reproduce: 'node --test "tests/*.test.mjs"',
  docs: ["CLAUDE.md"],
  audience: "a visitor to the site",
  implementNotes: ["Keep the honesty rule (CLAUDE.md).", "Keep index.md in step with index.html."],
  lenses: { security: "the HONESTY lens: no claim stronger than the library's trust level." },
  serveHint: 'cmd "python3 tools/dev-server.py $PORT"',
});

const issue = { number: 7, url: "u", title: "T", body: "B", comments: [], dropped: [] };
const spec = { actionable: true, acceptance_criteria: [{ id: "AC1", text: "t", verified_by: "test" }] };

describe("the repo's config", () => {
  it("is this repo's own setup when the repo has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-cfg-"));
    expect(loadConfig(dir)).toBe(DEFAULT_CONFIG);
    expect(testLabel(DEFAULT_CONFIG)).toBe("npm test");
    expect(checkCommand(DEFAULT_CONFIG)).toBe("npm run build && npm run typecheck && npm run lint && npm test");
  });

  it("reads .github/issue-agent.json over the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-cfg-"));
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, CONFIG_PATH), JSON.stringify({ $comment: "x", build: null, gates: [{ name: "test", cmd: ["node", "--test"] }] }));
    const cfg = loadConfig(dir);
    expect(cfg.build).toBeNull();
    expect(testLabel(cfg)).toBe("node --test");
    expect(cfg.install).toEqual(DEFAULT_CONFIG.install); // unset fields keep the default
  });

  it("refuses a config it can't use, naming the field", () => {
    const bad = (raw) => () => validateConfig(raw);
    expect(bad({ gate: [] })).toThrow(/unknown field "gate"/); // a typo never silently drops a gate
    expect(bad({ gates: [{ name: "lint", cmd: ["npm", "run", "lint"] }] })).toThrow(/named "test"/);
    expect(bad({ gates: [{ name: "test", cmd: ["a"] }, { name: "test", cmd: ["b"] }] })).toThrow(/unique/);
    expect(bad({ gates: [{ name: "test", cmd: "npm test" }] })).toThrow(/"gates"/); // argv, never a shell string
    expect(bad({ testRunner: [] })).toThrow(/"testRunner"/);
    expect(bad({ testRunner: null })).toThrow(/"testRunner"/); // only install/build may be null
    expect(bad({ source: "(" })).toThrow(/"source" must be a valid regular expression/);
    expect(bad({ fastTest: "jest" })).toThrow(/"fastTest"/);
    expect(bad({ lenses: { style: "x" } })).toThrow(/"lenses"/);
    expect(bad([])).toThrow(/JSON object/);
  });

  it("refuses a file that isn't JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-cfg-"));
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, CONFIG_PATH), "{ nope");
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });
});

describe("gates and the test-proof check in another repo", () => {
  it("runs the repo's test command, before the reviews and (with no fast subset) between fixes", () => {
    expect(testGateCommand({ phase: "pre-review" }, SITE)).toEqual({ cmd: "node", args: ["--test", "tests/*.test.mjs"], scope: "root" });
    // The same command between fixes — but recorded as a quick run, which never counts for publish.
    expect(testGateCommand({ phase: "fix", changed: ["index.html"] }, SITE)).toEqual({ cmd: "node", args: ["--test", "tests/*.test.mjs"], scope: "fast" });
  });

  it("reverts the repo's source, never its tests or excluded docs", () => {
    expect(isMutableSource("index.html", SITE)).toBe(true);
    expect(isMutableSource("llms.txt", SITE)).toBe(true);
    expect(isMutableSource("index.md", SITE)).toBe(true);
    expect(isMutableSource("CLAUDE.md", SITE)).toBe(false);
    expect(isMutableSource("tests/agent-files.test.mjs", SITE)).toBe(false);
    expect(isMutableSource("packages/credentagent-gate/src/a.ts", SITE)).toBe(false);
    // …and this repo keeps its own rule.
    expect(isMutableSource("packages/credentagent-gate/src/a.ts")).toBe(true);
    expect(isMutableSource("packages/credentagent-gate/README.md")).toBe(false);
  });

  it("names the repo's own test command when it refuses to publish", () => {
    const fast = { gates: [{ name: "test", scope: "fast", ok: true, green: true }] };
    expect(rootTestRefusal(fast, "aa", testLabel(SITE))).toMatch(/before the root `node --test tests\/\*\.test\.mjs`/);
    expect(publishVerdict({ done: true, last: fast, patchSha256: "aa", label: testLabel(SITE) }).reason).toMatch(/node --test/);
  });
});

describe("node --test failures as fingerprints", () => {
  const spec = (ms) => `▶ suite\n  ✖ JSON-LD names the software (${ms}ms)\n  ✔ sitemap (0.2ms)\n✖ failing tests:\n\n✖ JSON-LD names the software (${ms}ms)\n`;
  const tap = (n) => `TAP version 13\n# Subtest: a\nnot ok ${n} - JSON-LD names the software\n  ---\n  duration_ms: 1.2\n  ...\n# pass 94\n# fail 1\n`;

  it("reads the spec and TAP reporters, without durations or test numbers", () => {
    expect(fingerprints("test", spec("1.5"), "/r")).toEqual(["✖ JSON-LD names the software", "✖ failing tests:"]);
    expect(fingerprints("test", tap(3), "/r")).toEqual(["✖ JSON-LD names the software"]);
  });

  it("matches main's own failure across runs, so a red main isn't charged to the change", () => {
    expect(withinBaseline(fingerprints("test", tap(7), "/r"), fingerprints("test", tap(3), "/r"))).toBe(true);
    expect(withinBaseline(fingerprints("test", spec("9"), "/r"), fingerprints("test", spec("1.5"), "/r"))).toBe(true);
    expect(withinBaseline(fingerprints("test", tap(1), "/r"), [])).toBe(false);
  });

  it("still reads vitest the same way", () => {
    expect(fingerprints("test", " FAIL  a.test.ts > x\n × y 12ms\n", "/r")).toEqual(["FAIL  a.test.ts > x", "× y"]);
  });
});

describe("the prompts in another repo", () => {
  const site = forRepo(SITE);
  const all = [
    site.specPrompt(issue), site.implementPrompt(issue, spec), site.conflictPrompt(issue, ["index.html"], "0123456789abcdef"),
    site.reviewFixPrompt(issue, { verdict: "changes", cycle: 0, maxCycles: 3, summary: "", threads: [] }),
    site.reviewPrompt("spec", issue, spec, "b"), site.reviewPrompt("security", issue, spec, "b"), site.reviewPrompt("dx", issue, spec, "b"),
    site.evidencePrompt({ issue, spec, captureModule: "/c", beforeDir: "/b", afterDir: "/a", evidenceDir: "/e", portBase: 4100 }),
  ].join("\n");

  it("never tells the agents to run this repo's commands or read its docs", () => {
    for (const foreign of ["npm run build", "npm test", "npx vitest", "SECURITY-INVARIANTS.md", "write-bypass-test", "Stripe-grade", "examples/storefront.mjs"]) {
      expect(all).not.toContain(foreign);
    }
  });

  it("tells them the repo's own commands, docs and rules", () => {
    expect(site.implementPrompt(issue, spec)).toContain("run: node --test tests/*.test.mjs — from the repo root");
    expect(site.implementPrompt(issue, spec)).toContain("then fix. Keep the honesty rule (CLAUDE.md).");
    expect(site.implementPrompt(issue, spec)).toContain("- Keep index.md in step with index.html.");
    expect(site.specPrompt(issue)).toContain("1. Read CLAUDE.md, then the code");
    expect(site.specPrompt(issue)).toContain("the pipeline runs the root `node --test tests/*.test.mjs` itself");
    expect(site.reviewPrompt("security", issue, spec, "b")).toContain("the HONESTY lens");
    expect(site.reviewPrompt("spec", issue, spec, "b")).toContain("(`node --test <file>`)");
    expect(site.evidencePrompt({ issue, spec, captureModule: "/c", beforeDir: "/b", afterDir: "/a", evidenceDir: "/e", portBase: 1 })).toContain("python3 tools/dev-server.py $PORT");
    expect(site.SPEC_SCHEMA.properties.summary.description).toContain("a visitor to the site");
  });

  it("leaves this repo's own prompts exactly as they were", () => {
    const lib = forRepo(DEFAULT_CONFIG);
    expect(lib.implementPrompt(issue, spec)).toBe(libraryRoles.implementPrompt(issue, spec));
    expect(lib.implementPrompt(issue, spec)).toContain("run: npm run build && npm run typecheck && npm run lint && npm test — from the repo root");
    expect(lib.implementPrompt(issue, spec)).toContain("then fix. For a security control, follow the write-bypass-test skill");
    expect(lib.specPrompt(issue)).toContain("Read CLAUDE.md, REVIEW.md and SECURITY-INVARIANTS.md");
    expect(lib.specPrompt(issue)).toContain("the pipeline runs build, typecheck, lint and the root `npm test` itself");
  });
});

describe("the PR's How to test, from the repo's config", () => {
  const report = {
    done: true, files: ["index.html"], issue: { number: 7, title: "T", dropped: [] }, spec: { summary: "s", acceptance_criteria: [] }, manifest: [], patchSha256: "aa",
    rounds: [], id: "202610170000", model: "claude-opus-5-5", costUsd: 1,
    last: { impl: { summary: "i" }, reviews: [], gates: [{ name: "test", scope: "root", ok: true, green: true, patchSha256: "aa" }],
      mutation: { applicable: true, ok: true, tests: ["tests/a.test.mjs"], reverted: ["index.html"] } },
  };
  it("prints the repo's commands and names only the gates it ran", () => {
    const body = prBody(report, { mediaBase: "", repo: "o/r", commands: { reproduce: SITE.reproduce, focused: SITE.focusedTest } });
    expect(body).toContain('gh pr checkout <this PR> && node --test "tests/*.test.mjs"');
    expect(body).toContain("`node --test tests/a.test.mjs`");
    expect(body).toContain("the full test suite (");
    expect(body).not.toMatch(/npm|vitest|typecheck/);
  });
  it("credits the harness's own repo when it runs for another one", () => {
    expect(prBody(report, { mediaBase: "", repo: "o/site", harnessRepo: "o/lib" })).toContain("(`ci/issue-agent` in o/lib)");
    expect(prBody(report, { mediaBase: "", repo: "o/lib" })).toContain("(`ci/issue-agent` in o/lib)");
  });
  it("keeps this repo's own text by default", () => {
    const lib = { ...report, last: { ...report.last, gates: ["build", "typecheck", "lint"].map((name) => ({ name, ok: true, green: true })).concat(report.last.gates) } };
    const body = prBody(lib, { mediaBase: "", repo: "o/r" });
    expect(body).toContain("gh pr checkout <this PR> && npm ci && npm run build && npm test");
    expect(body).toContain("`npx vitest run tests/a.test.mjs`");
    expect(body).toContain("the build, typecheck, lint and full test suite (");
  });
});

describe("run.mjs --target", () => {
  it("refuses to start on a target whose config it can't use", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-target-"));
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, CONFIG_PATH), JSON.stringify({ gates: [] }));
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "run.mjs"), "--target", dir, "--repo", "o/r"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/"gates" must be a non-empty array/);
  });
});
