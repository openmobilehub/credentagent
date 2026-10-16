// The issue agent's trust decisions, as small pure functions (and one git query) so they are tested
// in the root `npm test` (issue-agent.test.mjs) rather than only reasoned about.

import { spawnSync } from "node:child_process";

export const TRUSTED_PERMISSIONS = ["admin", "maintain", "write"];

/**
 * Who wrote the issue's current title: the last renamer, or the author if it was never renamed.
 * A renamer GitHub can't name (deleted account) is `undefined` — never the author.
 */
export function titleAuthor(author, renames) {
  return renames.length ? renames.at(-1)?.actor?.login ?? undefined : author;
}

/** Paths the agent may never publish a change to. */
export const forbiddenPaths = (paths) => [...new Set(paths.filter((p) => p === ".github" || p.startsWith(".github/") || p === ".git" || p.startsWith(".git/")))];

/**
 * The files a staged change actually touches, as git sees them after `git apply --index` — not as
 * a patch's headers spell them (git quotes unusual names there, and headers can disagree with the
 * body). NUL-separated, so no name is quoted or escaped.
 */
export function stagedPaths(cwd) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** Files changed since `base` in a working tree (new files included once registered), from stdout only. */
export function changedSince(cwd, base) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "diff", "--name-only", "--no-renames", "-z", base], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * Apply a patch to a clean checkout (`--index`, hooks off) and report what it touched, as git sees
 * it, and which of those the agent may never publish. The publish job's one call for both.
 */
export function applyAndCheck(cwd, patch) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--index", "--whitespace=nowarn", "-"], { cwd, input: patch, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git apply failed: ${r.stderr}`);
  const files = stagedPaths(cwd);
  return { files, forbidden: forbiddenPaths(files) };
}

export const isRunId = (id) => /^\d{12}$/.test(String(id));
export const isCommitId = (sha) => /^[0-9a-f]{40}$/.test(String(sha));

/** The issue number to publish for: the workflow's, which the run must agree with. */
export function publishIssueNumber(trusted, fromRun) {
  if (trusted !== undefined && fromRun !== trusted) throw new Error(`the run is for issue ${fromRun}, but this workflow run is for issue ${trusted}`);
  const n = trusted ?? fromRun;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not an issue number: ${n}`);
  return n;
}
