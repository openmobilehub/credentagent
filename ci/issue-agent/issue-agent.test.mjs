// The issue agent's trust decisions (ci/issue-agent/README.md, "What it trusts"). These are the
// checks that keep an outsider's words away from the agents and keep the publish job from pushing
// what it shouldn't — each test fails if its check is removed.

import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { titleAuthor, forbiddenPaths, applyAndCheck, isRunId, isCommitId, publishIssueNumber } from "./checks.mjs";
import { fingerprints, withinBaseline } from "./fingerprints.mjs";
import { prBody, issueComment } from "./report.mjs";

// Pinned so a contributor's own git config (quotePath off, signed commits) can't change the outcome.
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=true", "-c", "commit.gpgsign=false",
    "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

describe("who wrote the title", () => {
  it("is the author when the issue was never renamed", () => {
    expect(titleAuthor("alice", [])).toBe("alice");
  });
  it("is the last renamer when it was renamed", () => {
    expect(titleAuthor("alice", [{ actor: { login: "bob" } }, { actor: { login: "mallory" } }])).toBe("mallory");
  });
  it("is nobody — never the author — when the last renamer's account is gone", () => {
    expect(titleAuthor("alice", [{ actor: null }])).toBeUndefined();
  });
});

describe("the publish job's checks", () => {
  it("takes the workflow's issue number and refuses a run for another issue", () => {
    expect(publishIssueNumber(342, 342)).toBe(342);
    expect(() => publishIssueNumber(343, 342)).toThrow(/run is for issue 342/);
    expect(() => publishIssueNumber(undefined, -1)).toThrow(/not an issue number/);
  });
  it("accepts only well-formed run and commit ids", () => {
    expect(isRunId("202610162031")).toBe(true);
    expect(isRunId("../../etc")).toBe(false);
    expect(isCommitId("a".repeat(40))).toBe(true);
    expect(isCommitId("main")).toBe(false);
  });
  it("forbids .github/ and .git/ paths", () => {
    expect(forbiddenPaths(["packages/a.ts", ".github/workflows/x.yml", ".github/CODEOWNERS"])).toEqual([".github/workflows/x.yml", ".github/CODEOWNERS"]);
    expect(forbiddenPaths(["packages/.github-notes.md", "docs/.github/x"])).toEqual([]);
  });

  describe("reads the touched paths from git, not from the patch's headers", () => {
    let repo;
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "issue-agent-"));
      git(repo, "init", "-q");
      git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    });
    const patchOf = (write) => {
      const src = mkdtempSync(join(tmpdir(), "issue-agent-src-"));
      git(src, "init", "-q");
      git(src, "commit", "-q", "--allow-empty", "-m", "base");
      write(src);
      git(src, "add", "-A");
      return git(src, "diff", "--cached", "--binary", "HEAD");
    };
    // applyAndCheck is the publish job's single call: apply, then ask git what changed.
    it("catches a .github/ file whose name git quotes in the patch header", () => {
      const patch = patchOf((src) => {
        mkdirSync(join(src, ".github"), { recursive: true });
        writeFileSync(join(src, ".github", "CÖDEOWNERS"), "* @someone\n");
      });
      expect(patch).toMatch(/^diff --git "a\/\.github\//m); // git quotes it — a header regex misses it
      expect(applyAndCheck(repo, patch).forbidden).toEqual([".github/CÖDEOWNERS"]);
    });

    it("lists ordinary files as they are, and forbids nothing", () => {
      const patch = patchOf((src) => writeFileSync(join(src, "a.txt"), "x\n"));
      expect(applyAndCheck(repo, patch)).toEqual({ files: ["a.txt"], forbidden: [] });
    });
  });
});

describe("the gate baseline", () => {
  const lint = (n) => `\n/r/packages/x/a.ts\n${Array.from({ length: n }, (_, i) => `  ${10 + i}:3  error  Bad  no-unused-vars`).join("\n")}\n`;
  it("forgives main's own failure, even when it moved", () => {
    expect(withinBaseline(fingerprints("lint", lint(1), "/r"), fingerprints("lint", `\n/r/packages/x/a.ts\n  99:1  error  Bad  no-unused-vars\n`, "/r"))).toBe(true);
  });
  it("does not let a change add more of a failure main already has", () => {
    expect(withinBaseline(fingerprints("lint", lint(3), "/r"), fingerprints("lint", lint(1), "/r"))).toBe(false);
    const ts = (l) => `src/a.ts(${l},5): error TS2322: x\n`;
    expect(withinBaseline(fingerprints("build", ts(10) + ts(20), ""), fingerprints("build", ts(10), ""))).toBe(false);
  });
});

describe("agent text in a PR body", () => {
  const report = {
    id: "202610162031", model: "claude-opus-5-5", costUsd: 1, done: true, rounds: [{}],
    issue: { number: 1, title: "t", dropped: [] }, files: ["a.ts"],
    spec: { summary: "<!-- hide everything after", acceptance_criteria: [{ id: "AC1", text: "ping @someone" }] },
    last: { gates: [{ name: "test", ok: true, green: true }], impl: { summary: "uses `<script>` safely" }, reviews: [] },
    manifest: [{ kind: "image", side: "after", file: 'x.png" onerror="alert(1)', caption: "c" }, { kind: "image", side: "after", file: "ok-01.png", caption: "c" }],
  };
  const body = prBody(report, { mediaBase: "https://example.test/", repo: "o/r" });
  it("can't open an HTML comment or ping anyone", () => {
    expect(body).not.toContain("<!-- hide");
    expect(body).not.toMatch(/@someone/);
  });
  it("leaves code spans readable", () => {
    expect(body).toContain("`<script>`");
  });
  it("only puts plain media file names into an img src", () => {
    expect(body).toContain("https://example.test/ok-01.png");
    expect(body).not.toContain("onerror");
  });
  it("says why when it skips", () => {
    expect(issueComment({ kind: "skipped", reason: "it is closed" })).toMatch(/not starting this one.*it is closed/);
  });
});
