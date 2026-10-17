// The issue agent's trust decisions, as small pure functions (and one git query) so they are tested
// in the root `npm test` (issue-agent.test.mjs) rather than only reasoned about.

import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG, testLabel } from "./config.mjs";

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

/**
 * The agent's own comments — its notices (`<!-- issue-agent -->`), its live status
 * (`<!-- issue-agent-status -->`), its review-loop notes (`<!-- issue-agent-review … -->`). They're
 * posted under a trusted account but carry text the agents wrote, so they must never come back to
 * the agents as a maintainer's instructions.
 */
export const isAgentComment = (body) => /^\s*<!-- issue-agent[\s>-]/.test(String(body)); // every agent comment starts with its marker; a maintainer merely mentioning one is not the agent

/**
 * Whether a PR the loop refused has left it for good while the agent still had it — a person took
 * it over (removed agent:in-review) or closed it — so its issue's agent:working label must come off.
 * Not for a fork or a non-agent branch (no issue of ours), nor for a PR already handed over
 * (ready / needs-human), which keeps the status the hand-over wrote.
 */
export const leftLoop = ({ headRefName, isCrossRepository, labels }) =>
  !isCrossRepository && Boolean(agentBranch(headRefName))
  && !labels.includes("agent:ready-for-human") && !labels.includes("agent:needs-human");

/**
 * The comments that become part of the agents' request: written by someone with write access, not
 * by the agent itself (its notices and status carry agent-written text under a trusted account),
 * and not written or edited after the snapshot (the label). Everything else is listed as dropped.
 */
export function requestComments(comments, { isTrusted, snapshotAt }) {
  const after = (t) => Boolean(t) && Date.parse(t) > Date.parse(snapshotAt);
  const kept = [], dropped = [];
  for (const c of comments) {
    if (isAgentComment(c.body)) continue; // never instructions — not even "dropped": it isn't a request
    const who = c.author?.login;
    if (!isTrusted(who)) { dropped.push(`a comment by ${who ?? "a deleted user"} (no write access)`); continue; }
    if (after(c.createdAt) || after(c.lastEditedAt)) { dropped.push(`a comment by ${who} written or edited after the label`); continue; }
    kept.push({ author: who, body: c.body });
  }
  return { comments: kept, dropped };
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
 * The review verdict that applies to the PR's head. `summaries` are the review bot's summary
 * comments, oldest first. Times are compared as instants (GitHub reports a commit's time in the
 * committer's own zone). A head that only merges main in (two parents) gets no new summary — the
 * review skips a push that leaves the PR's own diff unchanged — so the last verdict still applies.
 */
export function latestVerdict({ summaries, headAt, headIsMerge, conclusion }) {
  const fresh = summaries.filter((s) => Date.parse(s.createdAt) >= Date.parse(headAt)).at(-1);
  if (fresh) return { verdict: parseVerdict(fresh.body), summary: fresh.body };
  const previous = summaries.at(-1);
  if (headIsMerge && conclusion === "success" && previous) return { verdict: parseVerdict(previous.body), summary: previous.body, reused: true };
  return { verdict: undefined, summary: "" };
}

/**
 * What the loop does after a review. It keeps fixing until the reviewer is satisfied (✅, or 💬
 * with nothing left open). At the cycle cap, 💬 counts as ready — the reviewer calls it safe to
 * merge, and each review of a fix tends to find a new, smaller note — so the PR goes to a human
 * with the open notes listed. ⛔ at the cap is never "ready": the loop stops and says why.
 */
export function reviewDecision({ verdict, open, cycle, maxCycles, conclusion, loopOn, conflicting = false, verified = false }) {
  // Without a token whose pushes start workflows a fix could never be reviewed: spend no fix
  // session, and hand the PR (still marked in review) to a human rather than leave it stranded.
  if (!loopOn) return { action: "give-up", reason: "the review loop is off — there is no AGENT_GH_TOKEN, so a pushed fix would never be reviewed again" };
  // A PR that conflicts with main gets no review at all (GitHub runs no pull_request workflow on
  // it), so waiting would stall forever: resolve it now, or hand over at the cap.
  if (conflicting) {
    if (cycle >= maxCycles) return { action: "give-up", reason: `the PR conflicts with main and ${maxCycles} review cycles are done` };
    return { action: "fix", conflict: true, reason: "the PR conflicts with main — merging main in and resolving the conflicts" };
  }
  const decided = decideOnVerdict({ verdict, open, cycle, maxCycles, conclusion });
  // "Done" means the reviewer is satisfied; before a human is asked, the issue's own acceptance
  // criteria are checked on the final code too (once per head).
  if (decided.action === "done" && !verified) return { action: "verify", then: decided, reason: "the review is satisfied — checking the issue's acceptance criteria on the final code before handing over" };
  return decided;
}

function decideOnVerdict({ verdict, open, cycle, maxCycles, conclusion }) {
  if (!verdict) {
    // No verdict for the head: wait if no review has finished (started by hand), otherwise hand the
    // PR to a human — a failed or verdict-less review would leave it "in review" forever.
    if (!conclusion) return { action: "wait", reason: "there is no Claude review verdict for the PR's latest commit yet" };
    return { action: "give-up", reason: conclusion === "success" ? "the Claude review finished without a verdict for the latest commit (it may be paused)" : `the Claude review ${conclusion === "failure" ? "failed" : `ended as ${conclusion}`} on the latest commit` };
  }
  if ((verdict === "ready" || verdict === "notes") && open === 0) return { action: "done", reason: verdict === "ready" ? "the review says ✅ Ready to merge and every thread is resolved" : "the review says 💬 Ready — small notes, and every thread is resolved" };
  if (cycle >= maxCycles) {
    if (verdict === "ready" || verdict === "notes") return { action: "done", notes: open, reason: `after ${maxCycles} review cycles the review says ${verdict === "ready" ? "✅ Ready to merge" : "💬 Ready — small notes"}, with ${open} small note(s) still open (listed below)` };
    return { action: "give-up", reason: `${maxCycles} review cycles done and the review still says ⛔ Needs changes` };
  }
  return { action: "fix", reason: verdict === "changes" ? "the review says ⛔ Needs changes" : `${open} review thread(s) still open` };
}

// ── the acceptance-criteria checklist in an agent PR's description ──────────────────────────────
// publish writes it as "- [ ] **AC1** text"; verification ticks it as "- [x] **AC1** text — _evidence_".
const AC_LINE = /^- \[( |x)\] \*\*(AC\d+)\*\* (.*)$/gm;

/** The criteria in a PR description: [{ id, text, met }] (evidence stripped from the text). */
export function parseCriteria(body) {
  return [...String(body ?? "").matchAll(AC_LINE)].map(([, box, id, rest]) => ({ id, text: rest.replace(/ — _[^\n]*_$/, ""), met: box === "x" }));
}

/** The description with each criterion's box and evidence set from `verdicts` [{ id, met, evidence }]. */
export function tickCriteria(body, verdicts, escape = (s) => s) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return String(body).replace(AC_LINE, (line, _box, id, rest) => {
    const v = byId.get(id);
    if (!v) return line;
    const text = rest.replace(/ — _[^\n]*_$/, "");
    return `- [${v.met ? "x" : " "}] **${id}** ${text}${v.evidence ? ` — _${escape(String(v.evidence).replace(/\s+/g, " ").replace(/_/g, "\\_"))}_` : ""}`;
  });
}

/**
 * A review or verify cycle that meets a conflict with main: it becomes a conflict cycle — unless
 * the cycle cap is already reached, where the PR goes to a human instead of a cycle past it.
 */
export const conflictMidCycle = ({ cycle, maxCycles }) => (cycle >= maxCycles ? "give-up" : "resolve");

/**
 * What follows a criteria check: all met → verified; some not → a fix cycle to make them true — but
 * not past the cycle cap, where the PR goes to a human with the unmet ones named.
 */
export function afterVerification({ verdicts, cycle, maxCycles }) {
  const unmet = verdicts.filter((v) => !v.met);
  if (!unmet.length) return { action: "verified" };
  if (cycle >= maxCycles) return { action: "give-up", reason: `${maxCycles} review cycles are done and these acceptance criteria aren't met yet: ${unmet.map((v) => v.id).join(", ")}` };
  return { action: "fix", unmet };
}

/**
 * Whether the push job may believe a "verified" result from the agents' job: only when the trusted
 * decision asked for verification, and only if every criterion in it is met — or the trusted assess
 * step found no checklist at all (then nothing was claimed).
 */
export function acceptVerified({ decision, checklist, verdicts }) {
  if (decision !== "verify") return false;
  if (!checklist.length) return true;
  return checklist.every((c) => verdicts.find((v) => v.id === c.id)?.met === true);
}

/** Whether the loop already verified the criteria on exactly this head (a marker comment by the loop). */
export const verifiedFor = (comments, head, isTrusted) =>
  comments.some((c) => String(c.body).startsWith(`<!-- issue-agent-verified sha=${head} `) && isLoopAuthor(c.author, isTrusted));

/**
 * Who can post the loop's cycle comments: the push job — as the AGENT_GH_TOKEN's user (someone with
 * write access) or as the github-actions app. Not any bot.
 */
export const isLoopAuthor = (author, isTrusted) =>
  (author?.__typename === "Bot" && author?.login === "github-actions") || (author?.__typename !== "Bot" && isTrusted(author?.login));

/**
 * Review cycles already pushed: the loop's per-cycle comments (`<!-- issue-agent-review cycle=k`)
 * by the loop's own author. The hand-over comments carry the same prefix but aren't cycles.
 */
export const cyclesDone = (comments, isTrusted) =>
  comments.filter((c) => /<!-- issue-agent-review cycle=\d+ /.test(c.body) && isLoopAuthor(c.author, isTrusted)).length;

/**
 * Whether the review loop may act on a PR at all: an issue-agent branch in THIS repository (never a
 * fork — its code would be run, then pushed here with a write token), still open, and opted into
 * the loop by publish (`agent:in-review`). Returns the reason it may not, or undefined.
 */
export function loopRefusal({ headRefName, isCrossRepository, state, labels }) {
  if (isCrossRepository) return "the PR comes from a fork — the loop only works on branches in this repository";
  if (!agentBranch(headRefName)) return `${headRefName} is not an issue-agent branch`;
  if (state !== "OPEN") return `the PR is ${String(state).toLowerCase()}`;
  if (!labels.includes("agent:in-review")) return "the PR isn't in the review loop (no agent:in-review label) — a human may be working on it";
  return undefined;
}

/**
 * Files main changed since the PR branched off that the PR changes too. When there are any, the
 * loop brings main in before fixing — the review reads the PR as merged onto main, so a stale copy
 * of such a file is something only a merge can fix.
 */
export const sharedChanges = (mainChanged, prChanged) => [...new Set(prChanged)].filter((f) => mainChanged.includes(f)).sort();

/** The review-cycle cap from a setting: a whole number ≥ 1, else the default — never NaN (no cap). */
export function cycleCap(value, fallback = 3) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

// ── speed without weakening the checks ───────────────────────────────────────────────────────────

/**
 * The model a role runs on: the spec agent and the three reviewers (`review-<lens>-r<n>`) on the
 * faster review model; the implementer (every attempt, and the review loop's fixes) and evidence on
 * the main one.
 */
export const roleModel = (role, { main, review }) => (role === "spec" || role.startsWith("review-") ? review : main);

/**
 * The test command a gate run uses. Before the reviews (`pre-review`): the authoritative root
 * `npm test`. During a fix attempt (`fix`): only the tests of what changed — each touched workspace
 * (`packages/<name>/`, `ci/issue-agent/`) and any changed root-level test file — or every workspace
 * when nothing localizes. Always through the root vitest config, from the root, so failure paths match
 * the baseline's; `--passWithNoTests`, so a filter that matches nothing (a deleted test, a package with
 * no tests) isn't a failure the agent can't fix. `scope` is recorded with the result, so publish can
 * tell the two apart.
 */
export function testGateCommand({ phase, changed }, cfg = DEFAULT_CONFIG) {
  const [cmd, ...args] = cfg.gates.find((g) => g.name === "test").cmd;
  if (phase !== "fix") return { cmd, args, scope: "root" };
  // No quick way to pick a subset (config `fastTest: null`): the same command, recorded as a quick run —
  // it still never counts as the root run publish needs.
  if (cfg.fastTest !== "vitest-workspaces") return { cmd, args, scope: "fast" };
  const scopes = new Set();
  for (const f of changed) {
    const ws = f.match(/^(packages\/[^/]+\/|ci\/issue-agent\/)/)?.[1];
    if (ws) scopes.add(ws);
    else if (!f.includes("/") && /\.test\.[mc]?[jt]sx?$/.test(f)) scopes.add(f);
  }
  if (!scopes.size) scopes.add("packages/").add("ci/issue-agent/");
  return { cmd: "npx", args: ["vitest", "run", "--passWithNoTests", ...scopes], scope: "fast" };
}

/**
 * Why a change hasn't passed the root `npm test` (CLAUDE.md's authoritative run): the round's last
 * gate run, which must include a passing root run on exactly the patch being published
 * (`patchSha256`). The fast tests a fix attempt runs never count. Names the gate that actually
 * stopped the round. Returns the reason, or undefined.
 */
export function rootTestRefusal(round, patchSha256, label = testLabel()) {
  const root = `the root \`${label}\``;
  if (!round) return `no round finished, so ${root} never ran`;
  const stuck = round.gates?.find((g) => !g.ok && g.name !== "test");
  if (stuck) return `the \`${stuck.name}\` gate failed, so ${root} never ran`;
  const t = round.gates?.find((g) => g.name === "test");
  if (!t) return `the change has no root \`${label}\` result`;
  if (t.scope !== "root") return t.ok ? `the change passed only the fast tests; the round stopped before ${root}` : `the fast tests failed, so ${root} never ran`;
  if (!t.ok) return `${root} failed on the change`;
  if (patchSha256 && t.patchSha256 !== patchSha256) return `the change was edited after its last root \`${label}\` (a later round stopped early), so it has not passed one`;
  return undefined;
}

/**
 * What publish does with a change, given its root-test record. A "ready" change must have passed the
 * root `npm test` on exactly this patch, or it is refused outright. An unfinished one still opens as
 * a `[needs human]` draft — the hand-off — with the missing root run added to why it stopped.
 */
export function publishVerdict({ done, last, patchSha256, stopped, label }) {
  const untested = rootTestRefusal(last, patchSha256, label);
  if (!untested) return { open: true, done, stopped };
  if (done) return { open: false, reason: `${untested} — nothing is published as ready without a passing one` };
  return { open: true, done: false, stopped: stopped ? `${stopped}; ${untested}` : untested };
}

/**
 * A source file the test-proof check reverts: under the config's `source`, not `sourceExclude` (by
 * default docs), never a test file. By default the library's packages and examples, and the harness.
 */
export const isMutableSource = (f, cfg = DEFAULT_CONFIG) =>
  new RegExp(cfg.source).test(f) && !(cfg.sourceExclude && new RegExp(cfg.sourceExclude).test(f)) && !new RegExp(cfg.testFile).test(f);

/** Two checkouts can share installed dependencies only with byte-identical lockfiles. */
export const sameLockfile = (a, b) => typeof a === "string" && a.length > 0 && a === b;

export const isRunId = (id) => /^\d{12}$/.test(String(id));
export const isCommitId = (sha) => /^[0-9a-f]{40}$/.test(String(sha));

/** The issue number to publish for: the workflow's, which the run must agree with. */
export function publishIssueNumber(trusted, fromRun) {
  if (trusted !== undefined && fromRun !== trusted) throw new Error(`the run is for issue ${fromRun}, but this workflow run is for issue ${trusted}`);
  const n = trusted ?? fromRun;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not an issue number: ${n}`);
  return n;
}
