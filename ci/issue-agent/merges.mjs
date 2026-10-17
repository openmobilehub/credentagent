// Bringing main into an agent PR when it conflicts — the two halves that must agree exactly:
//   buildResolvedMerge  (fix job)  the merge commit a resolution makes; keeps copies of the resolved files
//   replayResolution    (push job) rebuilds that same merge from main + those copies, with its own checks
// The fix job's patch is taken on top of the first; the push job applies it on top of the second.
// Tested in issue-agent.test.mjs against a real conflict.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { forbiddenPaths } from "./checks.mjs";

const run = (cwd, args, { allowFail = false } = {}) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} (cwd ${cwd}) exited ${r.status}:\n${r.stdout}${r.stderr}`);
  return { code: r.status ?? 1, out: r.stdout };
};
const anon = ["-c", "user.name=issue-agent", "-c", "user.email=issue-agent@localhost"];
const conflictedFiles = (cwd) => run(cwd, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean).sort();
export const hasMarkers = (file) => existsSync(file) && /^(<{7}|={7}|>{7})( |$)/m.test(readFileSync(file, "utf8"));

/**
 * Merge `mainSha` into the checkout at `dir` (the PR head). Clean → committed, returns { clean: true }.
 * Conflicting → the merged tree with markers is left as an uncommitted change on the PR head (so the
 * agent can resolve it and every diff still reads against a normal HEAD); returns { conflicted }.
 */
export function startMerge(dir, head, mainSha) {
  const m = run(dir, [...anon, "merge", "--quiet", "--no-ff", "--no-edit", "--signoff", mainSha], { allowFail: true });
  if (m.code === 0) return { clean: true, conflicted: [] };
  const conflicted = conflictedFiles(dir);
  if (!conflicted.length) { run(dir, ["merge", "--abort"], { allowFail: true }); return { clean: false, conflicted: [], failed: true }; }
  run(dir, ["reset", "--quiet", "--mixed", head]);
  return { clean: false, conflicted };
}

/**
 * The merge commit the agent's resolution makes: PR head + main, each conflicted file taken from the
 * resolved working tree at `resolvedFrom`, everything else from git's own merge. Built in a scratch
 * worktree `scratch` of the same repository; copies the resolved files to `keepDir/<path>` for the
 * push job. Returns the commit id.
 */
export function buildResolvedMerge({ repo, scratch, head, mainSha, conflicted, resolvedFrom, keepDir }) {
  if (existsSync(scratch)) run(repo, ["worktree", "remove", "--force", scratch], { allowFail: true });
  run(repo, ["worktree", "add", "--quiet", "--detach", scratch, head]);
  try {
    run(scratch, [...anon, "merge", "--quiet", "--no-ff", "--no-commit", mainSha], { allowFail: true });
    for (const f of conflicted) {
      const from = join(resolvedFrom, f), to = join(scratch, f), keep = join(keepDir, f);
      if (existsSync(from)) {
        mkdirSync(dirname(to), { recursive: true }); cpSync(from, to);
        mkdirSync(dirname(keep), { recursive: true }); cpSync(from, keep);
      } else rmSync(to, { force: true });
    }
    run(scratch, ["add", "-A"]);
    run(scratch, [...anon, "commit", "--quiet", "--no-verify", "-m", "merge main (resolved)"]);
    return run(scratch, ["rev-parse", "HEAD"]).out.trim();
  } finally {
    run(repo, ["worktree", "remove", "--force", scratch], { allowFail: true });
  }
}

/**
 * In the push job's clean checkout `wt` (the PR head): merge `mainSha` and, if it conflicts, rebuild
 * the resolution from `resolvedDir` — but only for exactly the files git itself says conflict, never
 * a forbidden or escaping path, and never with markers left. Leaves the merge staged, uncommitted
 * (the caller commits it, signed off). Returns { ok: true } or { ok: false, why } (merge aborted).
 */
export function replayResolution(wt, mainSha, resolved, resolvedDir) {
  const m = run(wt, ["merge", "--quiet", "--no-ff", "--no-commit", mainSha], { allowFail: true });
  const fail = (why) => { run(wt, ["merge", "--abort"], { allowFail: true }); return { ok: false, why }; };
  const want = [...resolved].sort();
  if (m.code === 0) {
    if (want.length) return fail("main merges cleanly here but the fix resolved conflicts — refusing a mismatched resolution");
    return { ok: true };
  }
  const got = conflictedFiles(wt);
  if (JSON.stringify(got) !== JSON.stringify(want)) return fail(`bringing main in conflicts in ${got.join(", ") || "nothing git reports"}, not in the files the fix resolved`);
  if (forbiddenPaths(want).length || want.some((f) => f.startsWith("/") || f.split("/").includes(".."))) return fail("the conflict resolution touches paths the agent never changes");
  for (const f of want) {
    const from = join(resolvedDir, f);
    if (existsSync(from)) cpSync(from, join(wt, f));
    else run(wt, ["rm", "--quiet", "-f", "--", f], { allowFail: true });
  }
  if (want.some((f) => hasMarkers(join(wt, f)))) return fail("the conflict resolution still has conflict markers");
  run(wt, ["add", "-A"]);
  return { ok: true };
}
