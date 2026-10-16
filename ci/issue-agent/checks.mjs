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

/** Files that differ between two commits, from stdout only. */
export function filesBetween(cwd, from, to) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "diff", "--name-only", "--no-renames", "-z", from, to], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr}`);
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

// ── the review loop ──────────────────────────────────────────────────────────────────────────────

/** The Claude review's GitHub App account: a Bot, never a user who happens to be called "claude". */
export const isReviewBot = (author) => author?.__typename === "Bot" && author?.login === "claude";

/** "ready" (✅ Ready to merge), "notes" (💬 Ready — small notes), "changes" (⛔ Needs changes), or undefined. */
export function parseVerdict(body) {
  const m = String(body ?? "").match(/\*\*Verdict:\s*(✅|💬|⛔)/u);
  return m ? { "✅": "ready", "💬": "notes", "⛔": "changes" }[m[1]] : undefined;
}

/** An agent PR's branch → its issue number and run id; anything else is not the agent's to touch. */
export function agentBranch(ref) {
  const m = String(ref).match(/^agent\/issue-(\d+)-(\d{12})$/);
  return m ? { issue: Number(m[1]), run: m[2] } : undefined;
}

/**
 * The open review threads the agent must answer: started by the review bot or by someone trusted,
 * with only trusted (or bot) replies kept. Everything else is listed as ignored.
 */
export function threadsToAnswer(threads, isTrusted) {
  const ok = (a) => isReviewBot(a) || isTrusted(a?.login);
  const answer = [], ignored = [];
  for (const t of threads) {
    if (t.isResolved) continue;
    const [root, ...rest] = t.comments;
    if (!root || !ok(root.author)) { ignored.push(`a thread started by ${root?.author?.login ?? "a deleted user"} (no write access)`); continue; }
    answer.push({ id: t.id, path: t.path, line: t.line, comments: [root, ...rest.filter((c) => ok(c.author))].map((c) => ({ author: c.author?.login, body: c.body, databaseId: c.databaseId })) });
  }
  return { answer, ignored };
}

/**
 * What the loop does after a review. It keeps fixing until the reviewer is satisfied (✅, or 💬
 * with nothing left open). At the cycle cap, 💬 counts as ready — the reviewer calls it safe to
 * merge, and each review of a fix tends to find a new, smaller note — so the PR goes to a human
 * with the open notes listed. ⛔ at the cap is never "ready": the loop stops and says why.
 */
export function reviewDecision({ verdict, open, cycle, maxCycles }) {
  if (!verdict) return { action: "wait", reason: "there is no Claude review verdict for the PR's latest commit yet" };
  if ((verdict === "ready" || verdict === "notes") && open === 0) return { action: "done", reason: verdict === "ready" ? "the review says ✅ Ready to merge and every thread is resolved" : "the review says 💬 Ready — small notes, and every thread is resolved" };
  if (cycle >= maxCycles) {
    if (verdict === "ready" || verdict === "notes") return { action: "done", notes: open, reason: `after ${maxCycles} review cycles the review says ${verdict === "ready" ? "✅ Ready to merge" : "💬 Ready — small notes"}, with ${open} small note(s) still open (listed below)` };
    return { action: "give-up", reason: `${maxCycles} review cycles done and the review still says ⛔ Needs changes` };
  }
  return { action: "fix", reason: verdict === "changes" ? "the review says ⛔ Needs changes" : `${open} review thread(s) still open` };
}

/**
 * Review cycles already pushed: the loop's per-cycle comments (`<!-- issue-agent-review cycle=k`),
 * by someone trusted. The hand-over comments carry the same prefix but aren't cycles.
 */
export const cyclesDone = (comments, isTrustedAuthor) =>
  comments.filter((c) => /<!-- issue-agent-review cycle=\d+ /.test(c.body) && isTrustedAuthor(c.author)).length;

/**
 * Files main changed since the PR branched off that the PR changes too. When there are any, the
 * loop brings main in before fixing — the review reads the PR as merged onto main, so a stale copy
 * of such a file is something only a merge can fix.
 */
export const sharedChanges = (mainChanged, prChanged) => [...new Set(prChanged)].filter((f) => mainChanged.includes(f)).sort();

export const isRunId = (id) => /^\d{12}$/.test(String(id));
export const isCommitId = (sha) => /^[0-9a-f]{40}$/.test(String(sha));

/** The issue number to publish for: the workflow's, which the run must agree with. */
export function publishIssueNumber(trusted, fromRun) {
  if (trusted !== undefined && fromRun !== trusted) throw new Error(`the run is for issue ${fromRun}, but this workflow run is for issue ${trusted}`);
  const n = trusted ?? fromRun;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not an issue number: ${n}`);
  return n;
}
