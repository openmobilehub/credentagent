// The issue agent's trust decisions (ci/issue-agent/README.md, "What it trusts"). These are the
// checks that keep an outsider's words away from the agents and keep the publish job from pushing
// what it shouldn't — each test fails if its check is removed.

import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  titleAuthor, forbiddenPaths, applyAndCheck, isRunId, isCommitId, publishIssueNumber,
  isReviewBot, parseVerdict, agentBranch, threadsToAnswer, reviewDecision, sharedChanges, cyclesDone, loopRefusal, latestVerdict, cycleCap,
  roleModel, testGateCommand, rootTestRefusal, publishVerdict, isMutableSource, sameLockfile,
} from "./checks.mjs";
import { reviewPrompt } from "./roles.mjs";
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
  it("doesn't show a root test that ran on an earlier version of the patch as passing", () => {
    const stale = prBody({ ...report, patchSha256: "bb", last: { ...report.last, gates: [{ name: "test", ok: true, green: true, patchSha256: "aa" }] } }, { mediaBase: "", repo: "o/r" });
    expect(stale).toMatch(/`test` ⚠️ ran on an earlier version/);
    expect(stale).not.toMatch(/`test` ✅/);
  });
  it("says why when it skips", () => {
    expect(issueComment({ kind: "skipped", reason: "it is closed" })).toMatch(/not starting this one.*it is closed/);
  });
});

describe("the review loop", () => {
  const bot = { __typename: "Bot", login: "claude" };
  const maintainer = { __typename: "User", login: "dzuluaga" };
  const outsider = { __typename: "User", login: "mallory" };
  const isTrusted = (login) => login === "dzuluaga";

  it("reads the review's verdict", () => {
    expect(parseVerdict("## Claude review\n**Verdict: ✅ Ready to merge**")).toBe("ready");
    expect(parseVerdict("**Verdict: 💬 Ready — small notes**")).toBe("notes");
    expect(parseVerdict("**Verdict: ⛔ Needs changes**")).toBe("changes");
    expect(parseVerdict("no verdict here")).toBeUndefined();
  });

  it("touches only issue-agent branches", () => {
    expect(agentBranch("agent/issue-286-202610161901")).toEqual({ issue: 286, run: "202610161901" });
    expect(agentBranch("feat/issue-agent")).toBeUndefined();
    expect(agentBranch("agent/issue-286-202610161901/../main")).toBeUndefined();
  });

  it("trusts the review bot, not a user who calls themselves claude", () => {
    expect(isReviewBot(bot)).toBe(true);
    expect(isReviewBot({ __typename: "User", login: "claude" })).toBe(false);
  });

  it("answers threads from the bot and maintainers only, and drops outsiders' replies", () => {
    const thread = (id, root, ...replies) => ({ id, isResolved: false, path: "a.ts", line: 1, comments: [root, ...replies].map((author, i) => ({ databaseId: i, author, body: `${author.login} says` })) });
    const { answer, ignored } = threadsToAnswer([
      thread("T1", bot, outsider, maintainer),
      thread("T2", outsider),
      { ...thread("T3", bot), isResolved: true },
      thread("T4", maintainer),
    ], isTrusted);
    expect(answer.map((t) => t.id)).toEqual(["T1", "T4"]);
    expect(answer[0].comments.map((c) => c.author)).toEqual(["claude", "dzuluaga"]);
    expect(ignored).toEqual(["a thread started by mallory (no write access)"]);
  });

  it("counts pushed cycles — not hand-overs, outsiders' copies, or another bot's", () => {
    const c = (author, body) => ({ author, body });
    const comments = [
      c(maintainer, "<!-- issue-agent-review cycle=1 sha=abc -->\n🔁"),
      c({ __typename: "Bot", login: "github-actions" }, "<!-- issue-agent-review cycle=2 sha=def -->\n🔁"),
      c(maintainer, "<!-- issue-agent-review stopped -->\n⚠️"),
      c(outsider, "<!-- issue-agent-review cycle=9 sha=x -->"),
      c({ __typename: "Bot", login: "some-other-app" }, "<!-- issue-agent-review cycle=9 sha=y -->"),
      c({ __typename: "Bot", login: "dzuluaga" }, "<!-- issue-agent-review cycle=9 sha=z -->"),
    ];
    expect(cyclesDone(comments, isTrusted)).toBe(2);
  });

  it("refuses forks, non-agent branches, closed PRs and PRs out of the loop", () => {
    const pr = { headRefName: "agent/issue-1-202610162031", isCrossRepository: false, state: "OPEN", labels: ["agent:in-review"] };
    expect(loopRefusal(pr)).toBeUndefined();
    expect(loopRefusal({ ...pr, isCrossRepository: true })).toMatch(/fork/);
    expect(loopRefusal({ ...pr, headRefName: "feat/x" })).toMatch(/not an issue-agent branch/);
    expect(loopRefusal({ ...pr, state: "MERGED" })).toMatch(/merged/);
    expect(loopRefusal({ ...pr, labels: ["agent:needs-human"] })).toMatch(/isn't in the review loop/);
  });

  it("brings main in only when main changed a file the PR changes too", () => {
    expect(sharedChanges(["README.md", "docs/a.md"], ["README.md", "src/x.ts"])).toEqual(["README.md"]);
    expect(sharedChanges(["docs/a.md"], ["src/x.ts"])).toEqual([]);
  });

  // The loop's normal state: the token is there. (loopOn has no default — forgetting it means "off".)
  const rd = (o) => reviewDecision({ loopOn: true, ...o });

  it("hands over only when the review is satisfied and nothing is open", () => {
    const d = (verdict, open, cycle = 0) => rd({ verdict, open, cycle, maxCycles: 3 }).action;
    expect(d("ready", 0)).toBe("done");
    expect(d("notes", 0)).toBe("done");
    expect(d("notes", 2)).toBe("fix"); // small notes still get fixed before a human is asked
    expect(d("ready", 1)).toBe("fix");
    expect(d("changes", 0)).toBe("fix");
    expect(d(undefined, 0)).toBe("wait");
  });

  it("finds the verdict for the head — reusing the last one only when the head just merges main in", () => {
    const s = (createdAt, v) => ({ createdAt, body: `## Claude review\n**Verdict: ${v}**` });
    const summaries = [s("2026-10-16T10:00:00Z", "⛔ Needs changes"), s("2026-10-16T12:00:00Z", "💬 Ready — small notes")];
    expect(latestVerdict({ summaries, headAt: "2026-10-16T11:00:00Z", headIsMerge: false, conclusion: "success" }).verdict).toBe("notes");
    // a commit time in the committer's zone: 13:30+02:00 is 11:30Z — still before the 12:00Z summary
    expect(latestVerdict({ summaries, headAt: "2026-10-16T13:30:00+02:00", headIsMerge: false, conclusion: "success" }).verdict).toBe("notes");
    // a newer fix commit with no review of it yet: no verdict
    expect(latestVerdict({ summaries, headAt: "2026-10-16T13:00:00Z", headIsMerge: false, conclusion: "success" }).verdict).toBeUndefined();
    // "Update branch" (a merge of main, which the review skips): the last verdict still applies
    expect(latestVerdict({ summaries, headAt: "2026-10-16T13:00:00Z", headIsMerge: true, conclusion: "success" })).toMatchObject({ verdict: "notes", reused: true });
    // …but not when the review failed
    expect(latestVerdict({ summaries, headAt: "2026-10-16T13:00:00Z", headIsMerge: true, conclusion: "failure" }).verdict).toBeUndefined();
  });

  it("hands a PR over, spending nothing, when the loop has no token", () => {
    expect(reviewDecision({ loopOn: false, verdict: "changes", open: 3, cycle: 0, maxCycles: 3 })).toMatchObject({ action: "give-up", reason: expect.stringMatching(/AGENT_GH_TOKEN/) });
    expect(reviewDecision({ verdict: "changes", open: 3, cycle: 0, maxCycles: 3 }).action).toBe("give-up"); // not told it's on → off
    expect(rd({ verdict: "changes", open: 3, cycle: 0, maxCycles: 3 }).action).toBe("fix");
  });

  it("reads the cycle cap as a whole number ≥ 1, never as no cap", () => {
    expect(cycleCap("4")).toBe(4);
    expect(cycleCap("")).toBe(3);
    expect(cycleCap(undefined)).toBe(3);
    expect(cycleCap("four")).toBe(3);
    expect(cycleCap("2.5")).toBe(3);
    expect(cycleCap("0")).toBe(3);
  });

  it("hands a PR over when the review failed or gave no verdict, instead of waiting forever", () => {
    expect(rd({ verdict: undefined, open: 0, cycle: 0, maxCycles: 3, conclusion: "failure" })).toMatchObject({ action: "give-up", reason: expect.stringMatching(/failed/) });
    expect(rd({ verdict: undefined, open: 0, cycle: 0, maxCycles: 3, conclusion: "success" })).toMatchObject({ action: "give-up", reason: expect.stringMatching(/without a verdict/) });
    expect(rd({ verdict: undefined, open: 0, cycle: 0, maxCycles: 3 }).action).toBe("wait"); // started by hand, no review finished
  });

  it("at the cycle cap, counts 💬 as ready (notes listed) but never ⛔", () => {
    const at = (verdict, open) => rd({ verdict, open, cycle: 3, maxCycles: 3 });
    expect(at("notes", 2)).toMatchObject({ action: "done", notes: 2 });
    expect(at("ready", 1)).toMatchObject({ action: "done", notes: 1 });
    expect(at("changes", 0).action).toBe("give-up");
    expect(at("changes", 4).action).toBe("give-up");
    // before the cap, open notes are still fixed
    expect(rd({ verdict: "notes", open: 2, cycle: 2, maxCycles: 3 }).action).toBe("fix");
  });
});

describe("the internal reviewers", () => {
  const issue = { number: 1, url: "u", title: "t", body: "b", comments: [] };
  const spec = { summary: "s", acceptance_criteria: [{ id: "AC1", text: "x", verified_by: "test" }] };
  // REVIEW.md's checks, which the Claude review on GitHub applies: every lens applies them too, so the
  // internal round catches what that review would.
  for (const lens of ["spec", "security", "dx"]) {
    const text = reviewPrompt(lens, issue, spec, "abc123");
    it(`${lens}: is grounded in REVIEW.md`, () => {
      expect(text).toContain("REVIEW.md");
    });
    it(`${lens}: carries the stale-docs rule`, () => {
      expect(text).toMatch(/stale ones are findings/i);
    });
    it(`${lens}: carries the fix-it-or-flag-it rule, as REVIEW.md's "flag, don't block alone"`, () => {
      expect(text).toMatch(/fix it or flag it/i);
      expect(text).toMatch(/flag, don't block alone/i);
    });
    it(`${lens}: asks which test fails if the line is reverted`, () => {
      expect(text).toMatch(/which test fails if this line is reverted\?/i);
    });
  }
});

describe("models per role", () => {
  const models = { main: "claude-opus-5-5", review: "claude-sonnet-5-5" };
  it("runs the spec agent and the three reviewers on the review model", () => {
    for (const role of ["spec", "review-spec-r1", "review-security-r2", "review-dx-r3-retry"]) expect(roleModel(role, models)).toBe("claude-sonnet-5-5");
  });
  it("keeps the implementer (first try, fixes, review-loop fixes) and evidence on the main model", () => {
    for (const role of ["implement-r1", "implement-r2-fix3", "evidence"]) expect(roleModel(role, models)).toBe("claude-opus-5-5");
  });
  it("honors each setting", () => {
    const other = { main: "claude-fable-5-1", review: "claude-haiku-5-5" };
    expect(roleModel("spec", other)).toBe("claude-haiku-5-5");
    expect(roleModel("implement-r1", other)).toBe("claude-fable-5-1");
  });
});

describe("which tests a gate run uses", () => {
  it("runs the root npm test before the reviews", () => {
    expect(testGateCommand({ phase: "pre-review", changed: ["packages/credentagent-gate/src/a.ts"] })).toEqual({ cmd: "npm", args: ["test"], scope: "root" });
  });
  it("runs only the affected workspaces' tests during a fix attempt", () => {
    const c = testGateCommand({ phase: "fix", changed: ["packages/credentagent-gate/src/a.ts", "packages/credentagent-gate/test/a.test.ts", "ci/issue-agent/run.mjs", "README.md"] });
    expect(c).toEqual({ cmd: "npx", args: ["vitest", "run", "--passWithNoTests", "packages/credentagent-gate/", "ci/issue-agent/"], scope: "fast" });
  });
  it("runs a changed root-level test file itself — and a deleted one matching nothing isn't a failure", () => {
    expect(testGateCommand({ phase: "fix", changed: ["storefront-gate.test.ts"] }).args).toEqual(["vitest", "run", "--passWithNoTests", "storefront-gate.test.ts"]);
  });
  it("falls back to every workspace, still from the root (so failure paths match the baseline's)", () => {
    expect(testGateCommand({ phase: "fix", changed: ["docs/x.md"] })).toEqual({ cmd: "npx", args: ["vitest", "run", "--passWithNoTests", "packages/", "ci/issue-agent/"], scope: "fast" });
  });
});

describe("publish needs a root npm test on the published patch", () => {
  const round = (test, other = { name: "build", ok: true, green: true }) => ({ gates: [other, ...(test ? [test] : [])] });
  const root = (o = {}) => ({ name: "test", scope: "root", ok: true, green: true, patchSha256: "aa", ...o });
  it("allows a round whose root npm test passed on this patch", () => {
    expect(rootTestRefusal(round(root()), "aa")).toBeUndefined();
  });
  it("refuses a round with no root npm test", () => {
    expect(rootTestRefusal(round())).toMatch(/no root `npm test`/);
    expect(rootTestRefusal(undefined)).toMatch(/never ran/);
  });
  it("refuses a round that only ran the fast tests", () => {
    expect(rootTestRefusal(round({ name: "test", scope: "fast", ok: true, green: true }))).toMatch(/only the fast/);
    expect(rootTestRefusal(round({ name: "test", scope: "fast", ok: false, green: false }))).toMatch(/fast tests failed/);
  });
  it("names the gate that actually stopped the round", () => {
    expect(rootTestRefusal(round(undefined, { name: "build", ok: false, green: false }))).toMatch(/`build` gate failed/);
  });
  it("refuses a round whose root npm test failed", () => {
    expect(rootTestRefusal(round(root({ ok: false, green: false })), "aa")).toMatch(/failed on the change/);
  });
  it("refuses a patch edited after its root npm test (a later round stopped on budget)", () => {
    expect(rootTestRefusal(round(root()), "bb")).toMatch(/edited after/);
  });
});

describe("what publish does without a root npm test", () => {
  const passed = { gates: [{ name: "test", scope: "root", ok: true, green: true, patchSha256: "aa" }] };
  const stuck = { gates: [{ name: "build", ok: false, green: false }] };
  it("publishes a ready change that passed it on this patch", () => {
    expect(publishVerdict({ done: true, last: passed, patchSha256: "aa" })).toEqual({ open: true, done: true, stopped: undefined });
  });
  it("refuses a ready change that didn't", () => {
    const v = publishVerdict({ done: true, last: passed, patchSha256: "bb" });
    expect(v.open).toBe(false);
    expect(v.reason).toMatch(/edited after/);
  });
  it("still hands an unfinished change to a human as a draft, naming the real failing gate", () => {
    expect(publishVerdict({ done: false, last: stuck, patchSha256: "aa", stopped: "gates still red" }))
      .toEqual({ open: true, done: false, stopped: "gates still red; the `build` gate failed, so the root `npm test` never ran" });
  });
  it("says so on a draft whose patch changed after its last root run", () => {
    expect(publishVerdict({ done: false, last: passed, patchSha256: "bb", stopped: "budget spent" }).stopped).toMatch(/^budget spent; .*edited after/);
  });
});

describe("the pipeline's reuse", () => {
  it("reverts the harness's own source in the test-proof check, but not tests or docs", () => {
    expect(isMutableSource("ci/issue-agent/run.mjs")).toBe(true);
    expect(isMutableSource("packages/credentagent-gate/src/a.ts")).toBe(true);
    expect(isMutableSource("examples/delegated/server.ts")).toBe(true);
    expect(isMutableSource("docs/x.ts")).toBe(false);
    expect(isMutableSource("ci/issue-agent/issue-agent.test.mjs")).toBe(false);
    expect(isMutableSource("ci/issue-agent/README.md")).toBe(false);
  });
  it("skips a second npm ci only for an identical lockfile", () => {
    expect(sameLockfile('{"a":1}', '{"a":1}')).toBe(true);
    expect(sameLockfile('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameLockfile(undefined, undefined)).toBe(false);
    expect(sameLockfile("", "")).toBe(false);
  });
});
