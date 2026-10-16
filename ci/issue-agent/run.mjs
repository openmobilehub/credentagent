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
import { reportHtml, prBody, issueComment } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const MODEL = process.env.ISSUE_AGENT_MODEL ?? "claude-opus-5-5";
const MAX_ROUNDS = Number(process.env.ISSUE_AGENT_MAX_ROUNDS ?? 3);
const MAX_FIXES = Number(process.env.ISSUE_AGENT_MAX_FIXES ?? 3);
const AGENT_BUDGET_USD = Number(process.env.ISSUE_AGENT_BUDGET_USD ?? 25);
const RUN_BUDGET_USD = Number(process.env.ISSUE_AGENT_RUN_BUDGET_USD ?? 100);
const TRIGGER_LABEL = process.env.ISSUE_AGENT_LABEL ?? "agent";
const BLOCKING_LABELS = ["needs-decision", "epic", "wontfix", "duplicate", "question"];
const TRUSTED_PERMISSIONS = ["admin", "maintain", "write"];
const EVIDENCE_BRANCH = "agent-evidence";

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
  const titleBy = renames.at(-1)?.actor?.login ?? i.author?.login;
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

// `share`: how many agents run at once from the same remaining budget (the 3 reviewers), so together
// they can't spend past the run's cap.
async function agent(role, prompt, { cwd, schema, write = false, check = false, resume, maxTurns = 120, additionalDirectories, share = 1 } = {}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk"); // only the implement phase loads agent code
  const remaining = RUN_BUDGET_USD - RUN.costUsd;
  if (remaining <= 0) throw new BudgetSpent(`the run's $${RUN_BUDGET_USD} budget is spent`);
  const transcript = join(RUN.dir, "transcripts", `${role}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  RUN.log(`▶ ${role}${resume ? " (resumed)" : ""}`);
  let sessionId = resume, result, structured, cost = 0, error;
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
      maxBudgetUsd: Math.min(AGENT_BUDGET_USD, remaining / share),
    },
  })) {
    appendFileSync(transcript, JSON.stringify(msg) + "\n");
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "assistant") {
      for (const b of msg.message.content ?? []) if (b.type === "tool_use") RUN.log(`   ${role} · ${b.name} ${summarizeInput(b.input)}`);
    }
    if (msg.type === "result") {
      cost = msg.total_cost_usd ?? 0;
      result = msg.result;
      structured = msg.structured_output;
      if (msg.subtype !== "success") error = `${msg.subtype}${msg.errors ? `: ${msg.errors.join("; ")}` : ""}`;
    }
  }
  RUN.costUsd += cost;
  if (error?.startsWith("error_max_budget_usd")) throw new BudgetSpent(`${role} hit its budget`);
  if (error || structured == null) throw new Error(`${role} agent did not finish: ${error ?? "no structured output"}\n${result ?? ""}`);
  RUN.log(`✓ ${role} ($${cost.toFixed(2)}, run $${RUN.costUsd.toFixed(2)})`);
  writeFileSync(join(RUN.dir, `${role}.json`), JSON.stringify(structured, null, 2));
  return { out: structured, sessionId };
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

async function review(lens, issue, spec, base, facts, cwd, round, roles) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { out } = await agent(`review-${lens}-r${round}${attempt > 1 ? `-retry` : ""}`, roles.reviewPrompt(lens, issue, spec, base) + facts,
        { cwd, schema: roles.REVIEW_SCHEMA, check: true, maxTurns: 80, share: 3 });
      return { lens, ...out };
    } catch (e) {
      if (e instanceof BudgetSpent || attempt >= 2) throw e;
      RUN.log(`  review-${lens} failed (${e.message.split("\n")[0]}); retrying once`);
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

  // implement → [gates → mutation, fixed in place up to MAX_FIXES times] → review, until clean or out of
  // rounds. Mechanical failures are fixed inside a round, so review rounds go to what only a reviewer catches.
  let impl, session, feedback, reviewedPatch, stopped;
  const rounds = [];
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      RUN.log(`── round ${round}/${MAX_ROUNDS}`);
      let r;
      for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
        const first = round === 1 && attempt === 0;
        ({ out: impl, sessionId: session } = await agent(`implement-r${round}${attempt ? `-fix${attempt}` : ""}`,
          (first ? roles.implementPrompt(issue, spec) : roles.fixPrompt(feedback)) + baselineNote(baseline),
          { cwd: repoDir, schema: roles.IMPLEMENT_SCHEMA, write: true, resume: first ? undefined : session, maxTurns: 200 }));
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
        r.mutation = mutationCheck(repoDir, base, spec);
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
      const settled = await Promise.allSettled(["spec", "security", "dx"].map((l) => review(l, issue, spec, base, facts, repoDir, round, roles)));
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
  if (!rounds.length) return outcome({ status: "needs-human", reason: stopped ?? "no implementation round completed" });
  const last = rounds.at(-1);
  const done = Boolean(last.clean);
  const patch = reviewedPatch ?? diffPatch(repoDir, base);
  const touched = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  const forbidden = touched.filter((f) => f.startsWith(".github/"));
  writeFileSync(join(RUN.dir, "change.patch"), patch);

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
// files touched are recomputed from the patch itself. What's left on trust — the report's text and
// its "ready" verdict — only shapes a DRAFT PR's description, which a human reviews like any other.
function publishRun(dir) {
  const outcomeFile = join(dir, "outcome.json");
  const trustedN = opt("--issue") ? Number(opt("--issue")) : undefined;
  if (!existsSync(outcomeFile)) {
    if (trustedN) gh(["issue", "comment", String(trustedN), "-R", REPO, "--body", issueComment({ kind: "error", where: actionsRunUrl() })]);
    return { n: trustedN, status: "error", reason: "the implement phase produced no outcome" };
  }
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  if (trustedN !== undefined && outcome.n !== trustedN) throw new Error(`the run is for issue ${outcome.n}, but this workflow run is for issue ${trustedN}`);
  const n = trustedN ?? outcome.n;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not an issue number: ${n}`);
  if (!/^\d{12}$/.test(String(outcome.id))) throw new Error(`not a run id: ${outcome.id}`);
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
  if (!/^[0-9a-f]{40}$/.test(String(report.base))) throw new Error(`not a commit id: ${report.base}`);
  git(["fetch", "--quiet", "origin", "main"]);
  if (git(["merge-base", "--is-ancestor", report.base, "FETCH_HEAD"], { allowFail: true }).code !== 0) throw new Error(`the run's base ${report.base} is not a commit on main`);
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((m) => [m[1], m[2]]);
  const forbidden = [...new Set(files.filter((f) => f.startsWith(".github/") || f.startsWith(".git/")))];
  if (forbidden.length) {
    const reason = `the change touches ${forbidden.join(", ")} — the agent never publishes changes to workflows`;
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason, where: actionsRunUrl() })]);
    return { n, status: "needs-human", reason };
  }
  const fresh = snapshotIssue(n).issue;
  const issue = { ...report.issue, number: n, title: fresh?.title ?? `Issue #${n}`, url: fresh?.url ?? report.issue.url };
  Object.assign(report, { issue, files: [...new Set(files)] });
  const done = report.done === true;
  const branch = `agent/issue-${n}-${id}`;
  // The DCO sign-off is the committer's identity: refuse git's guess (user@hostname).
  const email = process.env.GIT_COMMITTER_EMAIL || git(["config", "user.email"], { allowFail: true }).out.trim();
  if (!email) throw new Error("no git identity to sign off with: set git config user.name / user.email (or GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL)");

  // Commit the patch on a clean worktree of the base.
  const wt = join(dir, "publish");
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt], { allowFail: true });
  git(["worktree", "add", "--quiet", "--detach", wt, report.base]);
  git(["apply", "--index", "--whitespace=nowarn", "-"], { cwd: wt, input: patch });
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
    const bodyFile = join(dir, "pr-body.md");
    writeFileSync(bodyFile, prBody(report, { mediaBase, repo: REPO }));
    prUrl = gh(["pr", "create", "-R", REPO, "--draft", "--base", "main", "--head", branch,
      "--title", done ? issue.title : `[needs human] ${issue.title}`, "--body-file", bodyFile]);
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: done ? "pr" : "needs-human", prUrl, report })]);
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
