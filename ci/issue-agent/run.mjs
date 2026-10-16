#!/usr/bin/env node
// Issue agent — turns a GitHub issue into a reviewed, evidenced draft pull request, unattended.
//
//   node ci/issue-agent/run.mjs 286                 # local: snapshot → implement → publish, in one go
//   node ci/issue-agent/run.mjs 286 --no-publish    # local: everything except pushing
//   node ci/issue-agent/run.mjs --poll              # local: every open `agent` issue with no PR yet
//
//   # CI runs the three phases as three jobs, so the agents never share a job with a GitHub token:
//   node ci/issue-agent/run.mjs snapshot 286 --out issue.json   # trusted code, read token
//   node ci/issue-agent/run.mjs implement issue.json            # agents + gates, NO GitHub token
//   node ci/issue-agent/run.mjs publish <run-dir>               # trusted code, write token, runs no agent code
//
// One way in (label an issue `agent`, or name it here), one way out (a draft PR + a comment on the
// issue). Separate Claude agents (Agent SDK) play separate roles; THIS SCRIPT checks their work:
//
//   snapshot   preflight (open? not needs-decision/epic? no open PR?) and FREEZE the request: only the
//              issue text and comments written by people with write access, as of the label
//   spec       an agent reads the request + code → acceptance criteria (or "not actionable")
//   implement  an agent writes the failing test first, then the fix
//   gates      this script runs build, typecheck, lint, root `npm test` — measured against main's own
//              failures, so a red main is never charged to the change
//   mutation   this script reverts the source change and re-runs the changed tests: they must FAIL
//   review     three agents in parallel — spec / security / DX — blocking findings → back to implement
//   evidence   before/after screenshots + video in a real browser (anything browser-visible), and a
//              recorded test-proof page for every change
//   publish    the REVIEWED change, as a patch, applied to a clean checkout: one signed-off commit, a
//              draft PR, a comment on the issue
//
// Trust: code an agent writes runs (gates, tests, the agents' own tools) — so it runs with every GitHub
// and Claude credential stripped from its environment, and git hooks disabled. The agents themselves
// need a Claude credential to run at all; what bounds that is the snapshot (only maintainers' words
// reach them) and, in CI, a job that holds no GitHub token. See README.md, "What it trusts".

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprints, stripAnsi, withinBaseline } from "./fingerprints.mjs";
import {
  TRUSTED_PERMISSIONS, titleAuthor, forbiddenPaths, applyAndCheck, changedSince, isRunId, isCommitId, publishIssueNumber,
  isReviewBot, parseVerdict, agentBranch, threadsToAnswer, reviewDecision, sharedChanges, filesBetween, cyclesDone,
} from "./checks.mjs";
import { reportHtml, prBody, issueComment, md } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const MODEL = process.env.ISSUE_AGENT_MODEL ?? "claude-opus-5-5";
const MAX_ROUNDS = Number(process.env.ISSUE_AGENT_MAX_ROUNDS ?? 3);
const MAX_FIXES = Number(process.env.ISSUE_AGENT_MAX_FIXES ?? 3);
const AGENT_BUDGET_USD = Number(process.env.ISSUE_AGENT_BUDGET_USD ?? 25);
const RUN_BUDGET_USD = Number(process.env.ISSUE_AGENT_RUN_BUDGET_USD ?? 100);
const TRIGGER_LABEL = process.env.ISSUE_AGENT_LABEL ?? "agent";
const BLOCKING_LABELS = ["needs-decision", "epic", "wontfix", "duplicate", "question"];
const EVIDENCE_BRANCH = "agent-evidence";
// The review loop (README, "The review loop") — on when the workflow has a token whose pushes start
// other workflows (AGENT_GH_TOKEN); with GITHUB_TOKEN a pushed fix would never be reviewed again.
const REVIEW_LOOP = process.env.ISSUE_AGENT_REVIEW_LOOP === "on";
const MAX_REVIEW_CYCLES = Number(process.env.ISSUE_AGENT_MAX_REVIEW_CYCLES ?? 3);
const LABELS = { inReview: "agent:in-review", ready: "agent:ready-for-human", needsHuman: "agent:needs-human" };

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const RUNS_HOME = resolve(opt("--runs", process.env.ISSUE_AGENT_HOME ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "credentagent-issue-agent")));
const REPO = opt("--repo", process.env.GITHUB_REPOSITORY ?? ghRepoFromRemote());
const [OWNER, NAME] = REPO.split("/");

// ── environments ─────────────────────────────────────────────────────────────────────────────────
const isGithubCred = (k) => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|AGENT_GH_TOKEN|ACTIONS_.*TOKEN.*|ACTIONS_ID_TOKEN_REQUEST_URL)$/.test(k);
const isClaudeCred = (k) => /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OAUTH_TOKEN|API_KEY)$/.test(k);
const envWithout = (drop) => Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop(k)));
// The agents: no GitHub credential. They keep the Claude credential — the SDK can't run without it.
const AGENT_ENV = envWithout(isGithubCred);
// Code the agents wrote (npm scripts, configs, tests): no credential of any kind.
const CODE_ENV = { ...envWithout((k) => isGithubCred(k) || isClaudeCred(k)), GIT_CONFIG_NOSYSTEM: "1" };

// ── shell helpers ────────────────────────────────────────────────────────────────────────────────
function sh(cmd, args, { cwd = REPO_ROOT, allowFail = false, env = process.env, input, timeout = 20 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (cwd ${cwd}) exited ${r.status}:\n${out.slice(-4000)}`);
  return { code: r.status ?? 1, out };
}
// Every git command this script runs ignores hooks: an agent can write files where hooks live, and
// this script's own commits must not run them.
const git = (args, o = {}) => sh("git", ["-c", "core.hooksPath=/dev/null", ...args], o);
// Agent-written code: no credentials in its environment.
const code = (cmd, args, o = {}) => sh(cmd, args, { ...o, env: CODE_ENV });
const gh = (args, o) => sh("gh", args, o).out.trim();
const ghJson = (args, o) => JSON.parse(gh(args, o));
function ghRepoFromRemote() {
  const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const m = url.match(/github\.com[:/](.+?\/.+?)(\.git)?$/);
  if (!m) throw new Error(`can't tell the GitHub repo from origin (${url}); pass --repo owner/name`);
  return m[1];
}
const tail = (s, n = 60) => s.split("\n").slice(-n).join("\n");
// Push/pull through gh's login (GH_TOKEN in CI, the keychain locally) without touching git config.
const GH_CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const modelName = (id) => {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : "Claude";
};
const actionsRunUrl = () => process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
const ensureLabels = () => {
  for (const [name, color, description] of [
    [LABELS.inReview, "FBCA04", "Issue agent: still iterating with the Claude reviewer — not ready for a human yet"],
    [LABELS.ready, "0E8A16", "Issue agent: every review is resolved — ready for a human review"],
    [LABELS.needsHuman, "D93F0B", "Issue agent: stopped — a human has to take this over"],
  ]) sh("gh", ["label", "create", name, "-R", REPO, "--color", color, "--description", description, "--force"], { allowFail: true });
};

let RUN; // per issue: { id, dir, costUsd, log() }
const newRun = (n, dir) => {
  const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  dir ??= join(RUNS_HOME, `issue-${n}-${id}`);
  mkdirSync(dir, { recursive: true });
  return { id, dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(join(dir, "run.log"), s + "\n"); } };
};

// ══ 1. snapshot (trusted; GitHub read access) ═════════════════════════════════════════════════════
//
// The agents' instructions are frozen here. Only words written by someone with write access reach
// them — the issue body if its author has it, and such people's comments — and nothing edited or
// added after the snapshot time (the label, in CI). Everything else is dropped and listed.
const permissionCache = new Map();
function permissionOf(login) {
  if (!login) return "none";
  if (!permissionCache.has(login)) {
    const r = sh("gh", ["api", `repos/${REPO}/collaborators/${login}/permission`, "--jq", ".permission"], { allowFail: true });
    permissionCache.set(login, r.code === 0 ? r.out.trim() : "none");
  }
  return permissionCache.get(login);
}
const trusted = (login) => TRUSTED_PERMISSIONS.includes(permissionOf(login));

function snapshotIssue(n, snapshotAt = new Date().toISOString()) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
    number title body url state lastEditedAt author{login} labels(first:50){nodes{name}} assignees(first:10){nodes{login}}
    timelineItems(itemTypes:[RENAMED_TITLE_EVENT], last:20){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}
    comments(last:100){nodes{author{login} body createdAt lastEditedAt}}}}}`;
  const i = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`]).data.repository.issue;
  const after = (t) => t && t > snapshotAt;
  const dropped = [];
  // The title is words too: it's trusted when whoever wrote it last (the author, or the last renamer)
  // has write access. A rename after the label is refused like a body edit (lastEditedAt misses renames).
  const renames = i.timelineItems.nodes;
  if (renames.some((e) => after(e.createdAt))) return { skip: `the issue was renamed after it was labelled; remove and re-add the \`${TRIGGER_LABEL}\` label to run on the current title` };
  const titleBy = titleAuthor(i.author?.login, renames);
  let title = i.title;
  if (!trusted(titleBy)) { dropped.push(`the issue title (by ${titleBy ?? "a deleted user"}, who has no write access)`); title = `Issue #${i.number}`; }
  let body = i.body ?? "";
  if (!trusted(i.author?.login)) { dropped.push(`the issue body (by ${i.author?.login ?? "a deleted user"}, who has no write access)`); body = ""; }
  else if (after(i.lastEditedAt)) return { skip: `the issue was edited after it was labelled (${i.lastEditedAt}); remove and re-add the \`${TRIGGER_LABEL}\` label to run on the current text` };
  const comments = [];
  for (const c of i.comments.nodes) {
    if (c.body.includes("<!-- issue-agent -->")) continue;
    const who = c.author?.login;
    if (!trusted(who)) { dropped.push(`a comment by ${who ?? "a deleted user"} (no write access)`); continue; }
    if (after(c.createdAt) || after(c.lastEditedAt)) { dropped.push(`a comment by ${who} written or edited after the label`); continue; }
    comments.push({ author: who, body: c.body });
  }
  const issue = { number: i.number, title, body, url: i.url, state: i.state, author: i.author?.login,
    labels: i.labels.nodes.map((l) => l.name), assignees: i.assignees.nodes.map((a) => a.login), comments, dropped, snapshotAt };
  if (!body.trim() && !comments.length) return { issue, skip: "nothing on this issue was written by someone with write access — a maintainer can restate the request in a comment, then re-add the label" };
  return { issue, skip: preflight(issue) };
}

function openPrsFor(n) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number url state}}}}}`;
  const linked = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`])
    .data.repository.issue.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  const mention = new RegExp(`#${n}(?!\\d)`);
  const titled = ghJson(["pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json", "number,url,title,headRefName"])
    .filter((p) => mention.test(p.title) || p.headRefName.startsWith(`agent/issue-${n}-`));
  return [...new Map([...linked, ...titled].map((p) => [p.number, p])).values()];
}

function preflight(issue) {
  if (flag("--force")) return null;
  if (issue.state !== "OPEN") return `the issue is ${issue.state.toLowerCase()}`;
  const blocking = issue.labels.filter((l) => BLOCKING_LABELS.includes(l));
  if (blocking.length) return `it is labelled ${blocking.join(", ")} — a maintainer has to act first`;
  // Someone else has taken it: don't race them. (Assigned to whoever labelled it is fine.)
  const labeller = process.env.ISSUE_AGENT_LABELLER;
  const others = (issue.assignees ?? []).filter((a) => a !== labeller);
  if (others.length) return `it is assigned to ${others.join(", ")} — unassign them first if the agent should take it`;
  const prs = openPrsFor(issue.number);
  if (prs.length) return `it already has an open pull request: ${prs.map((p) => p.url).join(", ")}`;
  return null;
}

// ══ 2. implement (agents + gates; needs NO GitHub access) ═════════════════════════════════════════
const READ_TOOLS = ["Read", "Grep", "Glob"];
const INSPECT_BASH = ["Bash(git diff *)", "Bash(git diff)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)", "Bash(git status)", "Bash(ls *)", "Bash(grep *)", "Bash(sed -n *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(cat *)"];
// Running the project's checks executes the implementer's code; reviewers may, but their tree is reset after.
const CHECK_BASH = ["Bash(npx vitest *)", "Bash(npm test *)", "Bash(npm test)", "Bash(npm run build*)", "Bash(npm run typecheck*)", "Bash(npm run lint*)"];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(mkdir *)"];
// Denies are a tidiness rule, not a security boundary: `node`/`npm` can do any of these. The boundary is
// that there is no GitHub credential to use and only the reviewed patch is ever published.
const NEVER = ["Bash(git push *)", "Bash(git commit *)", "Bash(git reset *)", "Bash(git checkout *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "WebFetch", "WebSearch"];

class BudgetSpent extends Error {}

// `cap`: a budget fixed by the caller — the 3 parallel reviewers each get a third of what's left when
// their round starts, retry included, so together they can't spend past the run's cap.
async function agent(role, prompt, { cwd, schema, write = false, check = false, resume, maxTurns = 120, additionalDirectories, cap } = {}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk"); // only the implement phase loads agent code
  const remaining = RUN_BUDGET_USD - RUN.costUsd;
  if (remaining <= 0) throw new BudgetSpent(`the run's $${RUN_BUDGET_USD} budget is spent`);
  if (cap !== undefined && cap <= 0) throw new BudgetSpent(`${role}'s share of the budget is spent`);
  const transcript = join(RUN.dir, "transcripts", `${role}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  RUN.log(`▶ ${role}${resume ? " (resumed)" : ""}`);
  let sessionId = resume, result, structured, cost = 0, error, sawResult = false;
  const allowed = Math.min(AGENT_BUDGET_USD, remaining, cap ?? Infinity);
  try {
  for await (const msg of query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      resume,
      env: AGENT_ENV,
      settingSources: ["project"], // the repo's CLAUDE.md + skills — the same guidance a human gets
      systemPrompt: { type: "preset", preset: "claude_code" },
      allowedTools: [...READ_TOOLS, ...INSPECT_BASH, ...(check || write ? CHECK_BASH : []), ...(write ? WRITE_TOOLS : [])],
      disallowedTools: NEVER,
      permissionMode: "dontAsk", // anything not allowed is denied — nobody is there to answer a prompt
      outputFormat: { type: "json_schema", schema },
      additionalDirectories,
      maxTurns,
      maxBudgetUsd: allowed,
    },
  })) {
    appendFileSync(transcript, JSON.stringify(msg) + "\n");
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "assistant") {
      for (const b of msg.message.content ?? []) if (b.type === "tool_use") RUN.log(`   ${role} · ${b.name} ${summarizeInput(b.input)}`);
    }
    if (msg.type === "result") {
      sawResult = true;
      cost = msg.total_cost_usd ?? 0;
      result = msg.result;
      structured = msg.structured_output;
      if (msg.subtype !== "success") error = `${msg.subtype}${msg.errors ? `: ${msg.errors.join("; ")}` : ""}`;
    }
  }
  } catch (e) {
    // The SDK died mid-session: what it spent is unknown, so count the whole allowance. Deliberately
    // conservative — the run cap holds and spend is never under-reported — at the price that a
    // reviewer which crashes this way isn't retried (one that ends with an error result still is).
    const charged = sawResult ? cost : allowed;
    RUN.costUsd += charged;
    throw Object.assign(e, { costUsd: charged });
  }
  RUN.costUsd += cost;
  const fail = (e) => Object.assign(e, { costUsd: cost });
  if (error?.startsWith("error_max_budget_usd")) throw fail(new BudgetSpent(`${role} hit its budget`));
  if (error || structured == null) throw fail(new Error(`${role} agent did not finish: ${error ?? "no structured output"}\n${result ?? ""}`));
  RUN.log(`✓ ${role} ($${cost.toFixed(2)}, run $${RUN.costUsd.toFixed(2)})`);
  writeFileSync(join(RUN.dir, `${role}.json`), JSON.stringify(structured, null, 2));
  return { out: structured, sessionId, costUsd: cost };
}
function summarizeInput(i = {}) {
  return String(i.command ?? i.file_path ?? i.pattern ?? i.path ?? "").replace(/\s+/g, " ").slice(0, 110);
}

function checkout(dir, ref) {
  git(["fetch", "--quiet", "origin", "main"]);
  if (existsSync(dir)) git(["worktree", "remove", "--force", dir], { allowFail: true });
  git(["worktree", "add", "--quiet", "--detach", dir, ref]);
  RUN.log(`  checkout ${ref} → ${dir}`);
  code("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir });
  code("npm", ["run", "build"], { cwd: dir, allowFail: true }); // a red main is measured by the baseline, not fatal here
}

// New files are invisible to `git diff <base>` until git knows about them: register them (without
// staging content) so the mutation check, the reviewers and the patch all see them.
const trackNew = (dir) => git(["add", "--all", "--intent-to-add"], { cwd: dir });
const diffPatch = (dir, base) => { trackNew(dir); return git(["diff", "--binary", base], { cwd: dir }).out; };
function restorePatch(dir, base, patch) {
  git(["reset", "--quiet", "--hard", base], { cwd: dir });
  git(["clean", "--quiet", "-fd"], { cwd: dir }); // untracked, not ignored (node_modules/dist stay)
  if (patch) git(["apply", "--whitespace=nowarn", "-"], { cwd: dir, input: patch });
  trackNew(dir);
}
// Point HEAD (and the index) back at `base` without touching the working tree.
function restoreHead(dir, base) {
  git(["reset", "--quiet", "--mixed", base], { cwd: dir });
  trackNew(dir);
}

// ── gates (this script runs them; an agent's claim that they pass is never taken) ────────────────
// Each failure becomes fingerprints (fingerprints.mjs). A gate passes when it is green, or when every
// failure it reports was already on main, no more often than on main (so a red main is never charged
// to the change, and the agent is told to leave it alone).
const GATES = [["build", ["run", "build"]], ["typecheck", ["run", "typecheck"]], ["lint", ["run", "lint"]], ["test", ["test"]]];

function runGates(dir, { baseline, stopOnFail = true } = {}) {
  const results = [];
  for (const [name, args] of GATES) {
    const r = code("npm", args, { cwd: dir, allowFail: true });
    const summary = name === "test" ? (r.out.match(/Tests\s+.+/g) ?? []).pop()?.trim() : undefined;
    const fps = r.code === 0 ? [] : fingerprints(name, r.out, dir);
    const base = baseline?.find((b) => b.name === name);
    const preexisting = r.code !== 0 && Boolean(base) && !base.green && fps.length > 0 && withinBaseline(fps, base.fingerprints);
    const ok = r.code === 0 || preexisting;
    results.push({ name, ok, green: r.code === 0, preexisting, fingerprints: fps, summary, tail: tail(r.out, 80) });
    if (baseline) RUN.log(`  gate ${name}: ${r.code === 0 ? "pass" : preexisting ? "pass (only main's own failures)" : "FAIL"}${summary ? ` — ${summary}` : ""}`);
    if (!ok && stopOnFail) break; // later gates on a broken build are noise
  }
  return results;
}

const baselineNote = (baseline) => {
  const red = baseline.filter((b) => !b.green);
  return red.length
    ? `\n\nNOTE — main is already red before your change. These failures are NOT yours: do not fix them, do not touch their files unless the issue requires it (the pipeline ignores exactly these, and no more of them):\n${red.map((b) => `- ${b.name}: ${b.fingerprints.join("; ") || "(failed with no parsable detail)"}`).join("\n")}`
    : "";
};

// The changed tests must fail on main's source and pass on the fix. Revert every changed non-test
// source file to the base (deleting added ones), run only the changed test files, then put the fix back.
function mutationCheck(dir, base, spec) {
  if (!spec.behavior_change) return { applicable: false, reason: "the spec marks this a docs-only / no-behavior change" };
  trackNew(dir);
  const changed = git(["diff", "--name-status", "--no-renames", base], { cwd: dir }).out.trim().split("\n").filter(Boolean)
    .map((l) => l.split("\t")).map(([s, f]) => ({ status: s[0], file: f }));
  const isTest = (f) => /\.test\.(ts|tsx|mjs|js)$/.test(f);
  const tests = changed.filter((c) => isTest(c.file) && c.status !== "D").map((c) => c.file);
  const src = changed.filter((c) => !isTest(c.file) && /^(packages|examples)\//.test(c.file) && !/\.md$/.test(c.file));
  if (!tests.length) return { applicable: true, ok: false, reason: "behavior changed but no test file was added or changed" };
  if (!src.length) return { applicable: true, ok: false, reason: "tests changed but no source file did — nothing to revert" };

  const patch = diffPatch(dir, base);
  let without;
  try {
    for (const c of src) {
      if (c.status === "A") rmSync(join(dir, c.file), { force: true });
      else git(["checkout", base, "--", c.file], { cwd: dir });
    }
    code("npm", ["run", "build"], { cwd: dir, allowFail: true });
    without = code("npx", ["vitest", "run", "--retry=0", ...tests], { cwd: dir, allowFail: true });
  } finally {
    restorePatch(dir, base, patch);
    code("npm", ["run", "build"], { cwd: dir, allowFail: true });
  }
  const withFix = code("npx", ["vitest", "run", "--retry=0", ...tests], { cwd: dir, allowFail: true });
  const ok = without.code !== 0 && withFix.code === 0;
  RUN.log(`  mutation: ${tests.length} changed test file(s) ${without.code !== 0 ? "FAIL" : "PASS"} without the fix, ${withFix.code === 0 ? "pass" : "FAIL"} with it → ${ok ? "ok" : "NOT OK"}`);
  return {
    applicable: true, ok, tests, reverted: src.map((c) => c.file),
    withoutFix: { code: without.code, tail: tail(stripAnsi(without.out), 70) },
    withFix: { code: withFix.code, tail: tail(stripAnsi(withFix.out), 30) },
    reason: ok ? undefined : without.code === 0 ? "the changed tests still PASS with the fix reverted — they don't guard it" : "the changed tests fail WITH the fix",
  };
}

// What the pipeline measured, handed to the reviewers so they judge it instead of guessing.
function pipelineFacts(r, baseline) {
  const m = r.mutation;
  return `\n\n<pipeline_facts>
These were measured by the pipeline (not claimed by the implementer):
- Gates from the repo root: ${r.gates.map((g) => `${g.name} ${g.green ? "green" : g.preexisting ? "red only with main's pre-existing failures" : "RED"}${g.summary ? ` (${g.summary})` : ""}`).join("; ")}.
- Main before the change: ${baseline.map((b) => `${b.name} ${b.green ? "green" : `red: ${b.fingerprints.join("; ")}`}`).join("; ")}. Pre-existing failures are not this change's to fix; a diff that "fixes" them unasked is out of scope.
- New files are part of \`git diff ${r.base}\` (registered with intent-to-add).
- Mutation check: ${m.applicable ? `with ${(m.reverted ?? []).join(", ")} reverted to main, the changed test files (${(m.tests ?? []).join(", ")}) ${m.withoutFix.code ? "FAILED" : "PASSED"}; with the change they ${m.withFix.code === 0 ? "pass" : "FAIL"}. This is per FILE: a file fails if any test in it fails, so judge whether each new test case would fail on its own. Output without the change:\n${m.withoutFix.tail.split("\n").slice(-40).join("\n")}` : `not applicable — ${m.reason}`}
</pipeline_facts>`;
}

async function review(lens, issue, spec, base, facts, cwd, round, roles, cap) {
  let left = cap; // this reviewer's share for the round, retry included
  for (let attempt = 1; ; attempt++) {
    try {
      const { out } = await agent(`review-${lens}-r${round}${attempt > 1 ? `-retry` : ""}`, roles.reviewPrompt(lens, issue, spec, base) + facts,
        { cwd, schema: roles.REVIEW_SCHEMA, check: true, maxTurns: 80, cap: left });
      return { lens, ...out };
    } catch (e) {
      left -= e.costUsd ?? 0;
      if (e instanceof BudgetSpent || attempt >= 2 || left <= 0) throw e;
      RUN.log(`  review-${lens} failed (${e.message.split("\n")[0]}); retrying once with $${left.toFixed(2)} left of its share`);
    }
  }
}

async function implementIssue(issue, { dir } = {}) {
  const roles = await import("./roles.mjs");
  const { renderHtml } = await import("./capture.mjs");
  const { proofHtml } = await import("./report.mjs");
  const n = issue.number;
  RUN = newRun(n, dir);
  RUN.log(`\n━━ issue #${n} · run ${RUN.id} · ${RUN.dir}`);
  if (issue.dropped?.length) RUN.log(`  left out of the request: ${issue.dropped.join("; ")}`);
  const outcome = (o) => { writeFileSync(join(RUN.dir, "outcome.json"), JSON.stringify({ n, id: RUN.id, ...o }, null, 2)); return { n, dir: RUN.dir, ...o }; };

  const repoDir = join(RUN.dir, "repo");
  checkout(repoDir, "origin/main");
  const base = git(["rev-parse", "HEAD"], { cwd: repoDir }).out.trim();
  const baseline = runGates(repoDir, { stopOnFail: false });
  RUN.log(`  baseline (main ${base.slice(0, 7)}): ${baseline.map((b) => `${b.name} ${b.green ? "green" : `RED (${b.fingerprints.length})`}`).join(" · ")}`);

  const { out: spec } = await agent("spec", roles.specPrompt(issue), { cwd: repoDir, schema: roles.SPEC_SCHEMA, maxTurns: 60 });
  if (!spec.actionable) {
    RUN.log(`  not actionable: ${spec.blocker}`);
    return outcome({ status: "blocked", reason: spec.blocker, spec });
  }

  const { rounds, reviewedPatch, stopped } = await iterate({
    issue, spec, roles, repoDir, baseline, diffBase: base, mutationBase: base,
    firstPrompt: roles.implementPrompt(issue, spec), schema: roles.IMPLEMENT_SCHEMA,
  });
  if (!rounds.length) return outcome({ status: "needs-human", reason: stopped ?? "no implementation round completed" });
  const last = rounds.at(-1);
  const done = Boolean(last.clean);
  const patch = reviewedPatch ?? diffPatch(repoDir, base);
  trackNew(repoDir);
  const touched = changedSince(repoDir, base);
  const forbidden = forbiddenPaths(touched);
  writeFileSync(join(RUN.dir, "change.patch"), patch);
  return finishImplement({ issue, spec, roles, n, repoDir, base, rounds, last, done, patch, touched, forbidden, stopped, outcome, renderHtml, proofHtml });
}

// implement → [gates → mutation, fixed in place up to MAX_FIXES times] → review, until clean or out of
// rounds. Mechanical failures are fixed inside a round, so review rounds go to what only a reviewer
// catches. Shared by a new issue and by the review loop:
//   diffBase      what the reviewers diff against and the patch is taken from (main, or the PR head)
//   mutationBase  what the test-proof check reverts the source to (always main's merge base)
async function iterate({ issue, spec, roles, repoDir, baseline, diffBase, mutationBase, firstPrompt, schema }) {
  const base = diffBase;
  let impl, session, feedback, reviewedPatch, stopped;
  const rounds = [];
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      RUN.log(`── round ${round}/${MAX_ROUNDS}`);
      let r;
      for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
        const first = round === 1 && attempt === 0;
        ({ out: impl, sessionId: session } = await agent(`implement-r${round}${attempt ? `-fix${attempt}` : ""}`,
          (first ? firstPrompt : roles.fixPrompt(feedback)) + baselineNote(baseline),
          { cwd: repoDir, schema, write: true, resume: first ? undefined : session, maxTurns: 200 }));
        trackNew(repoDir);
        const g = runGates(repoDir, { baseline });
        r = { round, attempt, base, gates: g, impl };
        const bad = g.find((x) => !x.ok);
        if (bad) {
          const baseFps = baseline.find((b) => b.name === bad.name)?.fingerprints ?? [];
          const fresh = bad.fingerprints.filter((f) => !baseFps.includes(f));
          feedback = `The \`npm run ${bad.name}\` gate FAILED when the pipeline ran it from the repo root.${fresh.length ? `\nFailures your change introduced:\n${fresh.map((f) => `- ${f}`).join("\n")}` : ""}\n\n\`\`\`\n${bad.tail}\n\`\`\``;
          continue;
        }
        r.mutation = mutationCheck(repoDir, mutationBase, spec);
        if (mutationBase !== base) restoreHead(repoDir, base); // mutationCheck leaves HEAD at its base
        if (r.mutation.applicable && !r.mutation.ok) {
          feedback = `Test-proof check failed: ${r.mutation.reason}.\nThe pipeline reverted your source changes (${(r.mutation.reverted ?? []).join(", ") || "none"}) and ran ${(r.mutation.tests ?? []).join(", ") || "no tests"}.\n\n\`\`\`\n${r.mutation.withoutFix?.tail ?? ""}\n\`\`\`\nA behavior change needs a test that fails without it.`;
          continue;
        }
        r.mechanicalOk = true;
        break;
      }
      rounds.push(r);
      if (!r.mechanicalOk) { RUN.log(`  round ${round}: gates/test proof still red after ${MAX_FIXES} fixes`); continue; }

      // Freeze what the reviewers review. Their test runs execute the change; whatever they leave
      // behind is thrown away, and this exact patch is what gets published.
      const patch = diffPatch(repoDir, base);
      const facts = pipelineFacts(r, baseline);
      const share = Math.min(AGENT_BUDGET_USD, (RUN_BUDGET_USD - RUN.costUsd) / 3);
      const settled = await Promise.allSettled(["spec", "security", "dx"].map((l) => review(l, issue, spec, base, facts, repoDir, round, roles, share)));
      if (diffPatch(repoDir, base) !== patch) { RUN.log("  reviewers' runs changed the tree — restoring the reviewed change"); restorePatch(repoDir, base, patch); }
      const failed = settled.filter((s) => s.status === "rejected");
      if (failed.length) {
        if (failed.some((s) => s.reason instanceof BudgetSpent)) throw failed.find((s) => s.reason instanceof BudgetSpent).reason;
        stopped = `a reviewer could not finish: ${failed[0].reason.message.split("\n")[0]}`;
        RUN.log(`  ${stopped}`);
        break;
      }
      const reviews = settled.map((s) => s.value);
      r.reviews = reviews;
      const blocking = reviews.flatMap((rv) => rv.findings.filter((f) => f.severity === "blocking").map((f) => ({ lens: rv.lens, ...f })));
      // Every criterion needs a "met" verdict with proof; a missing one counts as unmet.
      const verdicts = reviews.find((rv) => rv.lens === "spec")?.criteria ?? [];
      const unmet = spec.acceptance_criteria.map((ac) => verdicts.find((c) => c.id === ac.id) ?? { id: ac.id, met: false, evidence: "the spec reviewer gave no verdict for it" }).filter((c) => !c.met);
      RUN.log(`  review: ${reviews.map((rv) => `${rv.lens}=${rv.verdict}`).join(" ")} · ${blocking.length} blocking · ${unmet.length} unmet criteria`);
      if (!blocking.length && !unmet.length) { r.clean = true; reviewedPatch = patch; break; }
      feedback = [
        ...unmet.map((c) => `- [spec] ${c.id} is NOT met: ${c.evidence}`),
        ...blocking.map((f) => `- [${f.lens}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.summary}${f.fix ? `\n  fix: ${f.fix}` : ""}`),
      ].join("\n");
    }
  } catch (e) {
    if (!(e instanceof BudgetSpent)) throw e;
    stopped = e.message;
    RUN.log(`  stopped: ${stopped}`);
  }
  return { rounds, impl, reviewedPatch, stopped };
}

async function finishImplement({ issue, spec, roles, n, repoDir, base, rounds, last, done, patch, touched, forbidden, stopped, outcome, renderHtml, proofHtml }) {

  // evidence — after the patch is frozen, so nothing the evidence agent does can reach the PR
  const evidenceDir = join(RUN.dir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  let evidence;
  if (done && spec.touches_ui) {
    const beforeDir = join(RUN.dir, "before");
    checkout(beforeDir, base);
    try {
      ({ out: evidence } = await agent("evidence", roles.evidencePrompt({
        issue, spec, captureModule: join(HERE, "capture.mjs"), beforeDir, afterDir: repoDir, evidenceDir, portBase: 4100 + (n % 50) * 10,
      }), { cwd: evidenceDir, schema: roles.EVIDENCE_SCHEMA, write: true, additionalDirectories: [beforeDir, repoDir], maxTurns: 150 }));
    } catch (e) {
      evidence = { demonstrates: "", captures: [], limitations: `the evidence agent failed: ${e.message.slice(0, 500)}` };
      RUN.log(`  evidence agent failed: ${e.message.split("\n")[0]}`);
    }
  }
  await renderHtml({
    outDir: evidenceDir, name: "test-proof", side: "proof",
    html: proofHtml({ issue, spec, last, base }),
    caption: last.mutation?.applicable
      ? "Test proof: the pipeline's own gate runs, and the changed tests failing on main's code and passing on the fix"
      : "Test proof: the pipeline's own gate runs (no failing-test check: the spec found no behavior change)",
  });
  const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
  const report = {
    issue, spec, rounds, last, done: done && !forbidden.length, evidence, manifest, base, model: MODEL, costUsd: RUN.costUsd, id: RUN.id,
    stopped: forbidden.length ? `the change touches ${forbidden.join(", ")} — workflow changes are never published by the agent` : stopped,
    patchSha256: createHash("sha256").update(patch).digest("hex"), files: touched,
  };
  writeFileSync(join(RUN.dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(evidenceDir, "index.html"), reportHtml(report, { mediaBase: "" }));
  RUN.log(`  report → ${join(evidenceDir, "index.html")}`);
  return outcome({ status: report.done ? "ready" : "needs-human", reason: report.stopped, report: join(evidenceDir, "index.html") });
}

// ══ 3. publish (trusted; GitHub write access; never runs agent-written code) ══════════════════════
//
// Applies the reviewed patch to a clean checkout of the run's base, so nothing else from the run's
// working tree (evidence edits, files a test wrote, hooks) can reach the PR.
//
// The run directory comes from the job that ran agent code, so publish treats it as UNTRUSTED input:
// the issue number comes from the workflow (`--issue`) and must match; the title is re-read from
// GitHub through the same trust filter as the snapshot; the base must be a commit on main; the
// files touched are read from git after applying the patch. What's left on trust — the report's text and
// its "ready" verdict — only shapes a DRAFT PR's description, which a human reviews like any other.
function publishRun(dir) {
  const outcomeFile = join(dir, "outcome.json");
  const trustedN = opt("--issue") ? Number(opt("--issue")) : undefined;
  if (!existsSync(outcomeFile)) {
    if (trustedN) gh(["issue", "comment", String(trustedN), "-R", REPO, "--body", issueComment({ kind: "error", where: actionsRunUrl() })]);
    return { n: trustedN, status: "error", reason: "the implement phase produced no outcome" };
  }
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  const n = publishIssueNumber(trustedN, outcome.n);
  if (!isRunId(outcome.id)) throw new Error(`not a run id: ${outcome.id}`);
  RUN ??= { id: outcome.id, dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(join(dir, "run.log"), s + "\n"); } };
  if (outcome.status === "blocked") {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "blocked", reason: outcome.reason })]);
    return { n, status: "blocked", reason: outcome.reason };
  }
  if (!existsSync(join(dir, "report.json"))) {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason: outcome.reason, where: actionsRunUrl() })]);
    return { n, status: outcome.status, reason: outcome.reason };
  }
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const id = outcome.id;
  const patch = readFileSync(join(dir, "change.patch"), "utf8");
  // A consistency check against an accident, not a seal: both files come from the same job.
  if (createHash("sha256").update(patch).digest("hex") !== report.patchSha256) throw new Error("change.patch does not match the reviewed patch recorded in report.json");
  if (!patch.trim()) {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason: "the agents produced no change", where: actionsRunUrl() })]);
    return { n, status: "needs-human", reason: "empty change" };
  }
  // Re-derived here, not taken from the report.
  if (!isCommitId(report.base)) throw new Error(`not a commit id: ${report.base}`);
  git(["fetch", "--quiet", "origin", "main"]);
  if (git(["merge-base", "--is-ancestor", report.base, "FETCH_HEAD"], { allowFail: true }).code !== 0) throw new Error(`the run's base ${report.base} is not a commit on main`);
  // The DCO sign-off is the committer's identity: refuse git's guess (user@hostname).
  const email = process.env.GIT_COMMITTER_EMAIL || git(["config", "user.email"], { allowFail: true }).out.trim();
  if (!email) throw new Error("no git identity to sign off with: set git config user.name / user.email (or GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL)");

  // Apply the patch on a clean worktree of the base, then ask git what it actually changed — the
  // patch's own headers can quote or misstate paths.
  const wt = join(dir, "publish");
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt], { allowFail: true });
  git(["worktree", "add", "--quiet", "--detach", wt, report.base]);
  const { files, forbidden } = applyAndCheck(wt, patch);
  if (forbidden.length) {
    git(["worktree", "remove", "--force", wt], { allowFail: true });
    const reason = `the change touches ${forbidden.join(", ")} — the agent never publishes changes under .github/`;
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason, where: actionsRunUrl() })]);
    return { n, status: "needs-human", reason };
  }
  const fresh = snapshotIssue(n).issue;
  const issue = { ...report.issue, number: n, title: fresh?.title ?? `Issue #${n}`, url: fresh?.url ?? report.issue.url };
  Object.assign(report, { issue, files });
  const done = report.done === true;
  const branch = `agent/issue-${n}-${id}`;
  const commitMsg = `${issue.title} (#${n})\n\n${report.last.impl.summary}\n\nFixes #${n}\n\nCo-Authored-By: ${modelName(report.model)} <noreply@anthropic.com>`;
  git(["commit", "--quiet", "-s", "-F", "-"], { cwd: wt, input: commitMsg });
  if (flag("--dry-run")) {
    const stat = git(["show", "--stat", "--format=%H%n%an <%ae>%n%(trailers:only)", "HEAD"], { cwd: wt }).out;
    writeFileSync(join(dir, "pr-body.md"), prBody(report, { mediaBase: `https://raw.githubusercontent.com/${REPO}/${EVIDENCE_BRANCH}/issue-${n}/${id}/`, repo: REPO }));
    git(["worktree", "remove", "--force", wt], { allowFail: true });
    RUN.log(`  dry run — would push ${branch}:\n${stat}\n  PR body → ${join(dir, "pr-body.md")}`);
    return { n, status: "dry-run", branch };
  }

  // Idempotent: a retry finds the branch already pushed with the same tree, and the PR already open.
  const remote = git(["ls-remote", "--heads", "origin", branch]).out.trim().split(/\s/)[0];
  if (!remote) git([...GH_CREDENTIALS, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
  else {
    git(["fetch", "--quiet", "origin", branch], { cwd: wt });
    const same = git(["rev-parse", "FETCH_HEAD^{tree}"], { cwd: wt }).out.trim() === git(["rev-parse", "HEAD^{tree}"], { cwd: wt }).out.trim();
    if (!same) throw new Error(`${branch} already exists on origin with different content — not overwriting it`);
    RUN.log(`  ${branch} already pushed with this change`);
  }
  git(["worktree", "remove", "--force", wt], { allowFail: true });

  const mediaBase = publishEvidence(n, id, join(dir, "evidence"), report);
  const existing = ghJson(["pr", "list", "-R", REPO, "--head", branch, "--state", "all", "--json", "url"]);
  let prUrl = existing[0]?.url;
  if (!prUrl) {
    // With the review loop on, a converged change opens as a real (non-draft) PR so the Claude review
    // runs on it — labelled agent:in-review and bannered as not ready for a human until the loop
    // hands it over. Without the loop (or not converged), it stays a draft for a human, as before.
    const loop = REVIEW_LOOP && done;
    const labeller = process.env.ISSUE_AGENT_LABELLER;
    const bodyFile = join(dir, "pr-body.md");
    const banner = loop ? `> [!NOTE]\n> **The agent is still working on this with the Claude reviewer** — it fixes each review, replies to and resolves the threads, and asks for a human review only once the review is ✅/💬 with nothing left open (at most ${MAX_REVIEW_CYCLES} cycles). No need to review it yet.\n\n` : "";
    writeFileSync(bodyFile, banner + prBody(report, { mediaBase, repo: REPO }) + (labeller ? `\n<!-- issue-agent labeller=${labeller} -->\n` : ""));
    prUrl = gh(["pr", "create", "-R", REPO, ...(loop ? [] : ["--draft"]), "--base", "main", "--head", branch,
      "--title", done ? issue.title : `[needs human] ${issue.title}`, "--body-file", bodyFile]);
    if (loop) { ensureLabels(); gh(["pr", "edit", prUrl, "-R", REPO, "--add-label", LABELS.inReview]); }
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: loop ? "pr-in-review" : done ? "pr" : "needs-human", prUrl, report })]);
  }
  RUN.log(`  PR → ${prUrl}`);
  return { n, status: done ? "pr-open" : "needs-human", pr: prUrl };
}

// Evidence goes on a separate orphan branch so the PR's diff stays code-only; the PR embeds it from
// there (public repo → raw URLs render inline). Media and report files are copied, never executed.
function publishEvidence(n, id, evidenceDir, report) {
  const rel = `issue-${n}/${id}`;
  const mediaBase = `https://raw.githubusercontent.com/${REPO}/${EVIDENCE_BRANCH}/${rel}/`;
  const wt = join(RUN.dir, "evidence-branch");
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt], { allowFail: true });
  const has = git(["ls-remote", "--exit-code", "--heads", "origin", EVIDENCE_BRANCH], { allowFail: true }).code === 0;
  if (has) {
    git(["fetch", "--quiet", "origin", EVIDENCE_BRANCH]);
    git(["worktree", "add", "--quiet", "--detach", wt, "FETCH_HEAD"]);
  } else {
    git(["worktree", "add", "--quiet", "--orphan", "-b", `${EVIDENCE_BRANCH}-${id}`, wt]);
    writeFileSync(join(wt, "README.md"), "Screenshots, videos and reports recorded by the issue agent (ci/issue-agent). Not code — never merge this branch.\n");
  }
  const dest = join(wt, rel);
  mkdirSync(dest, { recursive: true });
  const MEDIA = /\.(png|webm|json|log|html)$/;
  for (const f of readdirSync(evidenceDir)) if (MEDIA.test(f)) cpSync(join(evidenceDir, f), join(dest, f));
  // The published report is read through an HTML preview proxy, so its media need absolute URLs.
  writeFileSync(join(dest, "index.html"), reportHtml(report, { mediaBase }));
  git(["add", "-A"], { cwd: wt });
  if (git(["status", "--porcelain"], { cwd: wt }).out.trim()) {
    git(["commit", "--quiet", "-s", "-m", `evidence: issue #${n}, run ${id}`], { cwd: wt });
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = git([...GH_CREDENTIALS, "push", "--quiet", "origin", `HEAD:refs/heads/${EVIDENCE_BRANCH}`], { cwd: wt, allowFail: true });
      if (p.code === 0) break;
      if (attempt === 2) throw new Error(`could not push ${EVIDENCE_BRANCH}:\n${p.out}`);
      git([...GH_CREDENTIALS, "pull", "--quiet", "--rebase", "origin", EVIDENCE_BRANCH], { cwd: wt });
    }
  }
  git(["worktree", "remove", "--force", wt], { allowFail: true });
  return mediaBase;
}

// ══ 4. the review loop (README, "The review loop") ════════════════════════════════════════════════
//
// After every Claude review of an agent PR: assess (trusted) → fix (agents, no GitHub token) → push
// (trusted). The loop hands the PR to a human only when the review is ✅, or 💬 with every thread
// resolved — or when it stops (cycle cap, budget, a change it may not publish), saying why.

const REVIEW_MARK = "<!-- issue-agent-review";

function loadPr(number) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
    number url state isDraft headRefName headRefOid body title labels(first:30){nodes{name}}
    commits(last:1){nodes{commit{oid committedDate}}}
    comments(last:100){nodes{author{__typename login} body createdAt}}
    reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{databaseId author{__typename login} body createdAt}}}}}}}`;
  return ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${number}`]).data.repository.pullRequest;
}

function assessReview(prNumber) {
  const pr = loadPr(prNumber);
  const branch = agentBranch(pr.headRefName);
  const skip = (reason) => ({ pr: pr.number, decision: { action: "skip", reason } });
  if (!branch) return skip(`${pr.headRefName} is not an issue-agent branch`);
  if (pr.state !== "OPEN") return skip(`the PR is ${pr.state.toLowerCase()}`);
  const labels = pr.labels.nodes.map((l) => l.name);
  if (labels.includes(LABELS.ready) || labels.includes(LABELS.needsHuman)) return skip("the PR was already handed to a human");
  const expected = process.env.ISSUE_AGENT_HEAD_SHA;
  if (expected && expected !== pr.headRefOid) return skip("the PR has moved on since this review ran");

  const headAt = pr.commits.nodes[0].commit.committedDate;
  const summary = pr.comments.nodes.filter((c) => isReviewBot(c.author) && c.body.startsWith("## Claude review") && c.createdAt >= headAt).at(-1);
  const verdict = parseVerdict(summary?.body);
  const { answer, ignored } = threadsToAnswer(pr.reviewThreads.nodes.map((t) => ({ ...t, comments: t.comments.nodes })), trusted);
  const cycle = cyclesDone(pr.comments.nodes, (a) => a?.__typename === "Bot" || trusted(a?.login));
  const decision = reviewDecision({ verdict, open: answer.length, cycle, maxCycles: MAX_REVIEW_CYCLES });
  const issue = snapshotIssue(branch.issue).issue ?? { number: branch.issue, title: `Issue #${branch.issue}`, body: "", comments: [], dropped: [] };
  return {
    pr: pr.number, url: pr.url, headRef: pr.headRefName, head: pr.headRefOid, isDraft: pr.isDraft, issueNumber: branch.issue, issue,
    verdict, summary: (summary?.body ?? "").slice(0, 30_000), threads: answer, ignored, cycle, maxCycles: MAX_REVIEW_CYCLES, decision,
    labeller: pr.body.match(/<!-- issue-agent labeller=([A-Za-z0-9-]+) -->/)?.[1], body: pr.body,
  };
}

// Hand the PR to a human: ready (every review resolved) or needs-human (the loop stopped).
function handOver(review, kind, reason) {
  ensureLabels();
  const url = review.url;
  if (kind === "ready" && review.isDraft) sh("gh", ["pr", "ready", url, "-R", REPO], { allowFail: true });
  sh("gh", ["pr", "edit", url, "-R", REPO, "--remove-label", LABELS.inReview, "--add-label", kind === "ready" ? LABELS.ready : LABELS.needsHuman], { allowFail: true });
  if (review.labeller) sh("gh", ["pr", "edit", url, "-R", REPO, "--add-reviewer", review.labeller], { allowFail: true });
  // Drop the "still working" banner.
  const body = review.body.replace(/^> \[!NOTE\]\n> \*\*The agent is still working on this[^\n]*\n\n/, "");
  if (body !== review.body) sh("gh", ["pr", "edit", url, "-R", REPO, "--body", body], { allowFail: true });
  const who = review.labeller ? `@${review.labeller} ` : "";
  // Open threads, each as a link a reviewer can click: the file and the note's first line.
  const open = (review.threads ?? []).map((t) => {
    const first = String(t.comments[0].body).replace(/[*_`#>]/g, "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? "";
    return `- [${md(t.path ?? "general")}${t.line ? `:${t.line}` : ""}](${url}#discussion_r${t.comments[0].databaseId}) — ${md(first)}`;
  }).join("\n");
  const text = kind === "ready"
    ? (review.threads?.length
      ? `${REVIEW_MARK} done -->\n✅ **${who}this is ready for your review — with ${review.threads.length} small note(s) left open.** ${md(reason)}. The reviewer calls it safe to merge; each review of a fix found a new, smaller note, so the agent stopped at the cycle cap rather than chase them:\n\n${open}`
      : `${REVIEW_MARK} done -->\n✅ **Every review is resolved — ${who}this is ready for your review.** ${md(reason)} after ${review.cycle} fix cycle(s).`)
    : `${REVIEW_MARK} stopped -->\n⚠️ **The agent stopped iterating — ${who}this needs a human.** ${md(reason)}.${open ? `\n\nStill open:\n${open}` : ""}`;
  gh(["pr", "comment", url, "-R", REPO, "--body", text]);
  RUN?.log?.(`  handed over (${kind}): ${reason}`);
  return { pr: review.pr, status: kind === "ready" ? "ready-for-human" : "needs-human", reason };
}

async function fixReview(review, { dir } = {}) {
  const roles = await import("./roles.mjs");
  RUN = newRun(review.issueNumber, dir);
  RUN.log(`\n━━ PR #${review.pr} review cycle ${review.cycle + 1}/${review.maxCycles} · ${review.threads.length} thread(s) · verdict ${review.verdict} · ${RUN.dir}`);
  const outcome = (o) => { writeFileSync(join(RUN.dir, "outcome.json"), JSON.stringify({ pr: review.pr, id: RUN.id, head: review.head, ...o }, null, 2)); return { pr: review.pr, dir: RUN.dir, ...o }; };
  const repoDir = join(RUN.dir, "repo");
  git(["fetch", "--quiet", "origin", review.head]);
  checkout(repoDir, review.head);
  let head = review.head;
  // If main has since changed files this PR changes too, bring main in first (the review reads the
  // PR merged onto main). The push job re-does this same merge itself before applying the patch.
  const mainSha = git(["rev-parse", "origin/main"], { cwd: repoDir }).out.trim();
  const forkPoint = git(["merge-base", "origin/main", head], { cwd: repoDir }).out.trim();
  const shared = sharedChanges(filesBetween(repoDir, forkPoint, mainSha), filesBetween(repoDir, forkPoint, head));
  let mergedMain;
  if (shared.length) {
    const m = git(["-c", "user.name=issue-agent", "-c", "user.email=issue-agent@localhost", "merge", "--quiet", "--no-ff", "--no-edit", "--signoff", mainSha], { cwd: repoDir, allowFail: true });
    if (m.code !== 0) {
      git(["merge", "--abort"], { cwd: repoDir, allowFail: true });
      return outcome({ status: "needs-human", reason: `main has changed ${shared.join(", ")} since this PR branched off, and merging it conflicts — a human has to resolve that` });
    }
    mergedMain = mainSha;
    head = git(["rev-parse", "HEAD"], { cwd: repoDir }).out.trim();
    RUN.log(`  merged main ${mainSha.slice(0, 7)} (it changed ${shared.join(", ")})`);
    code("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repoDir });
    code("npm", ["run", "build"], { cwd: repoDir, allowFail: true });
  }
  const mainBase = git(["merge-base", "origin/main", head], { cwd: repoDir }).out.trim();
  const baseline = runGates(repoDir, { stopOnFail: false });
  RUN.log(`  baseline (PR head ${head.slice(0, 7)}): ${baseline.map((b) => `${b.name} ${b.green ? "green" : `RED (${b.fingerprints.length})`}`).join(" · ")}`);

  // The "spec" for this round: every review thread answered (fixed, or declined with a reason).
  const firstLine = (s) => String(s).replace(/[*_`#>]/g, "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
  const criteria = review.threads.map((t, i) => ({ id: `T${i + 1}`, text: `Review thread ${t.id} (${t.path ?? "general"}${t.line ? `:${t.line}` : ""}) is fixed, or declined with a concrete reason a reviewer would accept — "${firstLine(t.comments[0].body)}"`, verified_by: "review" }));
  if (!criteria.length) criteria.push({ id: "S1", text: "Every item under 'Fix before merging' in the review summary is fixed, or declined with a concrete reason", verified_by: "review" });
  const prChangesSource = () => changedSince(repoDir, mainBase).some((f) => /^(packages|examples)\//.test(f) && !/\.md$/.test(f) && !/\.test\.[mc]?[jt]sx?$/.test(f));
  const spec = { actionable: true, summary: `Answer the Claude review of PR #${review.pr} (${review.verdict}).`, acceptance_criteria: criteria, behavior_change: prChangesSource(), touches_ui: false, evidence_plan: "test proof", test_plan: "as the review asks" };

  const { rounds, impl, reviewedPatch, stopped } = await iterate({
    issue: review.issue, spec, roles, repoDir, baseline, diffBase: head, mutationBase: mainBase,
    firstPrompt: roles.reviewFixPrompt(review.issue, review), schema: roles.REVIEW_FIX_SCHEMA,
  });
  const last = rounds.at(-1);
  const patch = reviewedPatch ?? (last ? diffPatch(repoDir, head) : "");
  writeFileSync(join(RUN.dir, "fix.patch"), patch);
  const final = last?.impl ?? impl ?? {};
  writeFileSync(join(RUN.dir, "fix.json"), JSON.stringify({
    rounds, last, responses: final.responses ?? [], summary: final.summary ?? "", summary_items: final.summary_items ?? [],
    description_update: final.description_update ?? "", open_questions: final.open_questions ?? [], costUsd: RUN.costUsd,
  }, null, 2));
  return outcome({ status: last?.clean ? "ready" : "needs-human", reason: stopped ?? (last?.clean ? undefined : "the fix did not pass the pipeline's own checks and reviews"), patchSha256: createHash("sha256").update(patch).digest("hex"), mergedMain });
}

// Trusted: review.json is from the assess job; the run directory is from the agents' job (untrusted).
function pushReview(dir, review) {
  const prN = Number(opt("--pr"));
  if (prN && prN !== review.pr) throw new Error(`review.json is for PR ${review.pr}, this run is for PR ${prN}`);
  RUN ??= { id: "push", dir, costUsd: 0, log: console.log };
  const pr = loadPr(review.pr);
  if (pr.headRefOid !== review.head) return { pr: review.pr, status: "skipped", reason: "the PR moved on while the fix was being made" };
  if (pr.headRefName !== review.headRef || !agentBranch(pr.headRefName)) throw new Error(`unexpected PR branch ${pr.headRefName}`);
  if (!REVIEW_LOOP) return handOver(review, "needs-human", "the review loop needs an AGENT_GH_TOKEN secret: a fix pushed with the default token would never be reviewed again");
  const outcomeFile = join(dir, "outcome.json");
  if (!existsSync(outcomeFile)) return handOver(review, "needs-human", `the fix job produced nothing${actionsRunUrl() ? ` (logs: ${actionsRunUrl()})` : ""}`);
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  if (outcome.pr !== review.pr || outcome.head !== review.head) throw new Error("the fix run is for a different PR or head");
  if (outcome.status !== "ready") return handOver(review, "needs-human", outcome.reason ?? "the fix did not pass the pipeline's own checks");
  const patch = readFileSync(join(dir, "fix.patch"), "utf8");
  const fix = JSON.parse(readFileSync(join(dir, "fix.json"), "utf8"));
  if (createHash("sha256").update(patch).digest("hex") !== outcome.patchSha256) throw new Error("fix.patch does not match the checked patch");
  const k = review.cycle + 1;

  let sha;
  if (patch.trim()) {
    const email = process.env.GIT_COMMITTER_EMAIL || git(["config", "user.email"], { allowFail: true }).out.trim();
    if (!email) throw new Error("no git identity to sign off with");
    const wt = join(dir, "push");
    if (existsSync(wt)) git(["worktree", "remove", "--force", wt], { allowFail: true });
    git(["fetch", "--quiet", "origin", review.head]);
    git(["worktree", "add", "--quiet", "--detach", wt, review.head]);
    if (outcome.mergedMain) {
      // Re-do the fix job's merge of main here, from a commit we check is really on main — the
      // patch was made on top of exactly that merge.
      if (!isCommitId(outcome.mergedMain)) throw new Error(`not a commit id: ${outcome.mergedMain}`);
      git(["fetch", "--quiet", "origin", "main"]);
      if (git(["merge-base", "--is-ancestor", outcome.mergedMain, "FETCH_HEAD"], { allowFail: true }).code !== 0) throw new Error(`${outcome.mergedMain} is not a commit on main`);
      if (git(["merge", "--quiet", "--no-ff", "--no-edit", "--signoff", outcome.mergedMain], { cwd: wt, allowFail: true }).code !== 0) {
        git(["merge", "--abort"], { cwd: wt, allowFail: true });
        git(["worktree", "remove", "--force", wt], { allowFail: true });
        return handOver(review, "needs-human", "bringing main into the branch conflicts");
      }
    }
    const { forbidden } = applyAndCheck(wt, patch);
    if (forbidden.length) { git(["worktree", "remove", "--force", wt], { allowFail: true }); return handOver(review, "needs-human", `the fix touches ${forbidden.join(", ")}, which the agent never publishes`); }
    const msg = `Address review, cycle ${k}: ${String(fix.summary).split("\n")[0].slice(0, 120)}\n\n${fix.summary}\n\nCo-Authored-By: ${modelName(MODEL)} <noreply@anthropic.com>`;
    git(["commit", "--quiet", "-s", "-F", "-"], { cwd: wt, input: msg });
    sha = git(["rev-parse", "HEAD"], { cwd: wt }).out.trim();
    if (flag("--dry-run")) { RUN.log(`  dry run — would push ${sha} to ${review.headRef}`); git(["worktree", "remove", "--force", wt], { allowFail: true }); return { pr: review.pr, status: "dry-run", sha }; }
    git([...GH_CREDENTIALS, "push", "--quiet", "origin", `HEAD:refs/heads/${review.headRef}`], { cwd: wt }); // fast-forward only: no force
    git(["worktree", "remove", "--force", wt], { allowFail: true });
  }

  // Reply to every thread the review loop was given, with the agent's answer; resolve the answered ones.
  const byId = new Map(fix.responses.map((r) => [r.thread_id, r]));
  let answered = 0;
  for (const t of review.threads) {
    const r = byId.get(t.id);
    const root = t.comments[0].databaseId;
    const body = r
      ? `${md(r.reply)}\n\n— ${r.action === "fixed" ? (sha ? `fixed in ${sha.slice(0, 7)}` : "fixed") : "declined"} (issue agent, review cycle ${k})`
      : `Not addressed in review cycle ${k} — the agent gave no answer for this thread. (issue agent)`;
    sh("gh", ["api", `repos/${REPO}/pulls/${review.pr}/comments/${root}/replies`, "-f", `body=${body}`], { allowFail: true });
    if (r) { gh(["api", "graphql", "-f", `query=mutation{resolveReviewThread(input:{threadId:"${t.id}"}){thread{isResolved}}}`]); answered++; }
  }
  // The agent can't edit the PR description; this trusted job writes its corrections into it, as
  // one "Updated after review" section that each cycle replaces (escaped like all agent text).
  const update = String(fix.description_update ?? fix.last?.impl?.description_update ?? "").trim().replace(/^#{1,6} [^\n]*\n+/, ""); // our heading, not the agent's
  if (update) {
    const section = `<!-- issue-agent-update -->\n### Updated after review cycle ${k}\n\n${md(update)}\n<!-- /issue-agent-update -->`;
    const current = loadPr(review.pr).body;
    const body = /<!-- issue-agent-update -->[\s\S]*?<!-- \/issue-agent-update -->/.test(current)
      ? current.replace(/<!-- issue-agent-update -->[\s\S]*?<!-- \/issue-agent-update -->/, section)
      : current.replace(/\n## In plain terms\n/, `\n${section}\n\n## In plain terms\n`);
    if (body !== current) sh("gh", ["pr", "edit", review.url, "-R", REPO, "--body", body], { allowFail: true });
  }
  const declined = fix.responses.filter((r) => r.action === "declined").length;
  fix.summary_items = fix.summary_items?.length ? fix.summary_items : fix.last?.impl?.summary_items ?? [];
  gh(["pr", "comment", review.url, "-R", REPO, "--body",
    `${REVIEW_MARK} cycle=${k} sha=${sha ?? "none"} -->\n🔁 **Review cycle ${k}/${review.maxCycles}:** ${sha ? `pushed ${sha.slice(0, 7)}` : "no code change"}${outcome.mergedMain ? ` (with main ${outcome.mergedMain.slice(0, 7)} merged in)` : ""} ·${answered}/${review.threads.length} thread(s) answered and resolved${declined ? ` (${declined} declined with a reason)` : ""}${(fix.summary_items ?? []).length ? ` · summary items: ${md(fix.summary_items.join("; "))}` : ""}.${sha ? " Waiting for the next review." : ""}`]);
  // No push means no new review would ever come: hand over now rather than wait forever.
  if (!sha) return handOver({ ...review, cycle: k, threads: review.threads.filter((t) => !byId.has(t.id)) }, "needs-human", "the agent answered the review without changing code, so no new review will run");
  return { pr: review.pr, status: "pushed", sha };
}

// ══ main ══════════════════════════════════════════════════════════════════════════════════════════
const [mode, arg] = argv;
if (mode === "snapshot") {
  // CI phase 1. Exit 0 either way; `skip` in the output tells the workflow to stop.
  const n = Number(arg);
  const { issue, skip } = snapshotIssue(n, process.env.ISSUE_AGENT_SNAPSHOT_AT || undefined);
  writeFileSync(resolve(opt("--out", "issue.json")), JSON.stringify({ issue, skip }, null, 2));
  console.log(skip ? `skip #${n}: ${skip}` : `snapshot #${n}: ${issue.comments.length} trusted comment(s)${issue.dropped.length ? `; left out: ${issue.dropped.join("; ")}` : ""}`);
  if (skip && flag("--comment")) gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "skipped", reason: skip })]);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip ? "true" : "false"}\n`);
} else if (mode === "implement") {
  // CI phase 2. No GitHub calls; the run directory is the hand-off to `publish`.
  const { issue, skip } = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (skip) { console.log(`skip: ${skip}`); process.exit(0); }
  mkdirSync(RUNS_HOME, { recursive: true });
  const o = await implementIssue(issue, { dir: opt("--dir") && resolve(opt("--dir")) });
  console.log(`\n━━ #${o.n} ${o.status}${o.reason ? ` — ${o.reason}` : ""} · ${o.dir}`);
} else if (mode === "publish") {
  // CI phase 3 (also `run.mjs publish <dir>` after a local --no-publish run). Any failure still
  // tells the issue, so a run never ends silently.
  try {
    const o = publishRun(resolve(arg));
    console.log(`\n━━ #${o.n} ${o.status}${o.pr ? ` ${o.pr}` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
  } catch (e) {
    console.error(e);
    const n = Number(opt("--issue"));
    if (n && !flag("--dry-run")) sh("gh", ["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "error", where: actionsRunUrl() })], { allowFail: true });
    process.exitCode = 1;
  }
} else if (mode === "assess-review") {
  // Review loop, phase 1 (trusted): what does the latest review ask for — and is the PR done?
  const review = assessReview(Number(arg));
  writeFileSync(resolve(opt("--out", "review.json")), JSON.stringify(review, null, 2));
  const { action, reason } = review.decision;
  console.log(`PR #${review.pr}: ${action} — ${reason}${review.threads ? ` · ${review.threads.length} thread(s) to answer${review.ignored?.length ? `, ignored: ${review.ignored.join("; ")}` : ""}` : ""}`);
  if (!flag("--dry-run")) {
    if (action === "done") handOver(review, "ready", reason);
    if (action === "give-up") handOver(review, "needs-human", reason);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `decision=${action}\n`);
} else if (mode === "fix-review") {
  // Review loop, phase 2: agents answer the review. No GitHub calls.
  const review = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (review.decision?.action !== "fix") { console.log(`nothing to fix: ${review.decision?.reason}`); process.exit(0); }
  mkdirSync(RUNS_HOME, { recursive: true });
  const o = await fixReview(review, { dir: opt("--dir") && resolve(opt("--dir")) });
  console.log(`\n━━ PR #${o.pr} ${o.status}${o.reason ? ` — ${o.reason}` : ""} · ${o.dir}`);
} else if (mode === "push-review") {
  // Review loop, phase 3 (trusted): push the checked fix, answer and resolve the threads.
  const review = JSON.parse(readFileSync(resolve(opt("--review", "review.json")), "utf8"));
  try {
    const o = pushReview(resolve(arg), review);
    console.log(`\n━━ PR #${o.pr} ${o.status}${o.sha ? ` ${o.sha}` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
  } catch (e) {
    console.error(e);
    if (!flag("--dry-run")) handOver(review, "needs-human", `the review loop failed${actionsRunUrl() ? ` (logs: ${actionsRunUrl()})` : ""}: ${e.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
} else if (mode === "publish-evidence") {
  // Re-publish a run's media + report (same paths, so a PR's links keep working).
  const dir = resolve(arg);
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  RUN = { id: report.id, dir, costUsd: report.costUsd, log: console.log };
  console.log(publishEvidence(report.issue.number, report.id, join(dir, "evidence"), report));
} else {
  // Local: all three phases in one process.
  const numbers = flag("--poll")
    ? ghJson(["issue", "list", "-R", REPO, "--state", "open", "--label", TRIGGER_LABEL, "--limit", "50", "--json", "number"]).map((i) => i.number)
    : argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!numbers.length) {
    console.error("usage: run.mjs <issue>… | --poll  [--no-publish] [--force] [--repo owner/name] [--runs dir]\n       run.mjs snapshot <n> --out f | implement <f> | publish <run-dir> | publish-evidence <run-dir>");
    process.exit(flag("--poll") ? 0 : 2);
  }
  mkdirSync(RUNS_HOME, { recursive: true });
  const outcomes = [];
  for (const n of numbers) {
    try {
      const { issue, skip } = snapshotIssue(n);
      if (skip) { console.log(`\n━━ #${n} skipped — ${skip}`); outcomes.push({ n, status: "skipped", reason: skip }); continue; }
      const o = await implementIssue(issue);
      outcomes.push(flag("--no-publish") ? o : { ...o, ...publishRun(o.dir) });
    } catch (e) {
      console.error(e);
      outcomes.push({ n, status: "error", reason: e.message.split("\n")[0], dir: RUN?.dir });
    }
  }
  console.log("\n━━ outcomes");
  for (const o of outcomes) console.log(`  #${o.n} ${o.status}${o.pr ? ` ${o.pr}` : ""}${o.reason ? ` — ${o.reason}` : ""}${o.report ? `\n     report: ${o.report}` : ""}`);
  writeFileSync(join(RUNS_HOME, "last-outcomes.json"), JSON.stringify(outcomes, null, 2));
  process.exitCode = outcomes.some((o) => o.status === "error") ? 1 : 0;
}
