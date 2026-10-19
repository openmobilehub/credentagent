// The scope check (CONTRIBUTING.md, "Big changes"): a big pull request must be one ticket of a plan.
// Each test fails if its check is removed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { assess, comment, hasTask, linkedIssues, specTasks, counts, LIMITS, OVERRIDE_LABEL } from "./check.mjs";

const file = (filename, lines) => ({ filename, additions: lines, deletions: 0 });
const big = [file("packages/credentagent-gate/src/grants-serve.ts", 300), file("packages/credentagent-gate/src/grants.ts", 200)];
const small = [file("packages/credentagent-gate/src/grants.ts", 40)];

describe("size", () => {
  it("lets a small PR through with nothing to show", () => {
    expect(assess({ files: small }).ok).toBe(true);
  });
  it("refuses a big PR with no sign the work was broken down", () => {
    const r = assess({ files: big });
    expect(r).toMatchObject({ ok: false, big: true });
    expect(comment(r)).toMatch(/too big to review as one piece/);
    expect(comment(r)).toMatch(/to-tickets/);
  });
  it("counts files too, not just lines", () => {
    const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`src/f${i}.ts`, 1));
    expect(assess({ files: many }).ok).toBe(false);
  });
  it("doesn't count docs, specs or lockfiles — writing the plan down is the point", () => {
    expect(counts("package-lock.json")).toBe(false);
    expect(counts("specs/016-grant-activity/spec.md")).toBe(false);
    expect(counts("docs/reference/api.md")).toBe(false);
    expect(counts("packages/credentagent-gate/src/grants.ts")).toBe(true);
    expect(assess({ files: [file("package-lock.json", 5000), file("specs/016-x/plan.md", 900), ...small] }).ok).toBe(true);
  });
});

describe("evidence of a plan", () => {
  it("passes a big PR that delivers one sub-issue of an epic with several tickets", () => {
    const r = assess({ files: big, tickets: [{ number: 410, parent: 406, parentIsEpic: true, siblings: 4 }] });
    expect(r.ok).toBe(true);
    expect(r.evidence[0]).toMatch(/#410, one of 4 tickets of the plan in #406/);
  });
  it("doesn't count an issue that isn't a ticket, or a parent that isn't a plan", () => {
    expect(assess({ files: big, tickets: [{ number: 406 }] }).ok).toBe(false);
    expect(assess({ files: big, tickets: [{ number: 410, parent: 406, parentIsEpic: false, siblings: 4 }] }).ok).toBe(false);
    expect(assess({ files: big, tickets: [{ number: 410, parent: 406, parentIsEpic: true, siblings: 1 }] }).ok).toBe(false);
  });
  it("passes a task named in a spec's tasks.md, and not one the file doesn't have", () => {
    expect(assess({ files: big, specs: [{ dir: "specs/016-grant-activity", task: "T2", exists: true }] }).ok).toBe(true);
    expect(assess({ files: big, specs: [{ dir: "specs/016-grant-activity", task: "T9", exists: false }] }).ok).toBe(false);
  });
  it("matches a task by number, the way this repo writes them (T002), not by spelling", () => {
    const tasks = "- [ ] T001 Write the store\n- [ ] T002 [P] Serve it\n- [ ] T010 Docs";
    for (const id of ["T2", "T02", "T002", "T10"]) expect(hasTask(tasks, id)).toBe(true);
    for (const id of ["T3", "T100"]) expect(hasTask(tasks, id)).toBe(false);
    expect(hasTask("ST002 is not a task", "T2")).toBe(false);
    // Every tasks.md on main numbers its tasks; the documented example must be one that matches.
    expect(comment(assess({ files: big }))).toMatch(/tasks\.md T002/);
  });
  it("passes when a maintainer approved the size", () => {
    expect(assess({ files: big, labels: [OVERRIDE_LABEL] }).ok).toBe(true);
  });
});

describe("reading the PR description", () => {
  it("finds the issues it delivers, and ignores the template's comments", () => {
    expect(linkedIssues("Fixes #410\n\nPart of #406. Closes: #12")).toEqual([410, 406, 12]);
    expect(linkedIssues("<!-- \"Fixes #123\" (a sub-issue of an `epic`) -->")).toEqual([]);
    expect(linkedIssues("see #406")).toEqual([]);
  });
  it("finds a spec task named after its tasks.md", () => {
    expect(specTasks("Delivers specs/016-grant-activity/tasks.md T2.")).toEqual([{ dir: "specs/016-grant-activity", task: "T2" }]);
    expect(specTasks("specs/016-grant-activity/spec.md T2")).toEqual([]);
  });
});

describe("the workflow", () => {
  it("runs main's copy and never checks out the PR's code", () => {
    const wf = readFileSync(new URL("../../.github/workflows/pr-scope.yml", import.meta.url), "utf8");
    expect(wf).toMatch(/pull_request_target/);
    expect(wf).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(wf).not.toMatch(/pull_request\.head/);
  });
});
