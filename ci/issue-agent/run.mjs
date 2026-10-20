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
//   # Another repo: --target <its checkout> (or ISSUE_AGENT_TARGET). Its .github/issue-agent.json says how
//   # to install, build and test it (config.mjs); without one, this repo's own setup applies.
//
// One way in (label an issue `agent`, or name it here), one way out (a draft PR + a comment on the
// issue). Separate Claude agents (Agent SDK) play separate roles; THIS SCRIPT checks their work:
//
//   snapshot   preflight (open? not needs-decision/epic? no open PR?) and FREEZE the request: only the
//              issue text and comments written by people with write access, as of the label
//   spec       an agent reads the request + code → acceptance criteria (or "not actionable")
//   implement  an agent writes the failing test first, then the fix
//   gates      this script runs build, typecheck, lint and the tests of what changed — measured against
//              main's own failures (measured once per commit per process, so `--poll` reuses it), so a
//              red main is never charged to the change
//   mutation   this script reverts the source change and re-runs the changed tests: they must FAIL
//   root test  once per round, before the reviews: the authoritative root `npm test` (publish opens
//              nothing as ready without a passing one on exactly the published patch)
//   review     three agents in parallel — spec / security / DX, grounded in REVIEW.md and handed the
//              diff — blocking findings → back to implement
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
  isReviewBot, parseVerdict, agentBranch, threadsToAnswer, reviewDecision, sharedChanges, filesBetween, cyclesDone, loopRefusal, latestVerdict, cycleCap,
  parseCriteria, tickCriteria, verifiedFor, afterVerification, acceptVerified, conflictMidCycle,
  reviewFixCriteria, threadReplies, reReviewCalls,
  isAgentComment, requestComments, leftLoop, isLoopAuthor, labelledBy, requestBody, updateSection,
  roleModel, testGateCommand, rootTestRefusal, publishVerdict, isMutableSource, sameLockfile, publishRefusalHint,
} from "./checks.mjs";
import { reportHtml, prBody, issueComment, md, statusBody, STATUS_MARK, REVIEW_MARK, handOverComment } from "./report.mjs";
import { briefBody, replyBody, challengeBody, briefState, briefOutcome, briefFailure, planRun, specFromBrief, splitConversation, clampBrief, sweepWanted, approvalRefusal, LABEL_AWAITING, LABEL_APPROVED, BRIEF_MARK } from "./brief.mjs";
import { blockersLeft, isSplit, parseTicket, pastLimits, planProgress, scopeProblems, ticketAsBrief, ticketBody, ticketHeader, ticketOrder, ticketSpec, STOPPED_LABEL } from "./scope.mjs";
import { cardProblems } from "./card.mjs";
import { validateExample, runExample, exampleHtml } from "./example.mjs";
import { loadConfig, testLabel } from "./config.mjs";
import { startMerge, buildResolvedMerge, rebuildForPush, hasMarkers, treeOf } from "./merges.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

// The repo the agent works on: this one, or --target (a checkout of another repo's main — trusted, since
// its config decides which commands run). The harness itself always runs from HERE.
const REPO_ROOT = resolve(opt("--target", process.env.ISSUE_AGENT_TARGET || resolve(HERE, "../..")));
const CONFIG = loadConfig(REPO_ROOT);
const TEST = testLabel(CONFIG); // the authoritative test command, as people type it
// The PR's "How to test" (publish reads the config from its own trusted checkout), and where this
// harness lives when it isn't the target repo (the PR's footer links it).
const PR_COMMANDS = { reproduce: CONFIG.reproduce, focused: CONFIG.focusedTest, build: Boolean(CONFIG.build) };
const HARNESS_REPO = process.env.ISSUE_AGENT_HARNESS_REPO || undefined;
const MODEL = process.env.ISSUE_AGENT_MODEL || "claude-opus-5-5"; // the implementer (and evidence)
const REVIEW_MODEL = process.env.ISSUE_AGENT_REVIEW_MODEL || "claude-sonnet-5-5"; // the spec agent and the three reviewers
const MODELS = { main: MODEL, review: REVIEW_MODEL };
const MAX_ROUNDS = Number(process.env.ISSUE_AGENT_MAX_ROUNDS ?? 3);
const MAX_FIXES = Number(process.env.ISSUE_AGENT_MAX_FIXES ?? 3);
const AGENT_BUDGET_USD = Number(process.env.ISSUE_AGENT_BUDGET_USD ?? 25);
const RUN_BUDGET_USD = Number(process.env.ISSUE_AGENT_RUN_BUDGET_USD ?? 100);
const TRIGGER_LABEL = process.env.ISSUE_AGENT_LABEL ?? "agent";
const SCOPE_WAIVER = "scope:approved"; // ci/pr-scope/check.mjs, OVERRIDE_LABEL
const BLOCKING_LABELS =["needs-decision", "epic", "wontfix", "duplicate", "question"];
const EVIDENCE_BRANCH = "agent-evidence";
// The review loop (README, "The review loop") — on when the workflow has a token whose pushes start
// other workflows (AGENT_GH_TOKEN); with GITHUB_TOKEN a pushed fix would never be reviewed again.
const REVIEW_LOOP = process.env.ISSUE_AGENT_REVIEW_LOOP === "on";
const MAX_REVIEW_CYCLES = cycleCap(process.env.ISSUE_AGENT_MAX_REVIEW_CYCLES); // unset ("") or not a whole number ≥ 1 → 2
const LABELS = { working: "agent:working", inReview: "agent:in-review", ready: "agent:ready-for-human", needsHuman: STOPPED_LABEL, awaiting: LABEL_AWAITING, approved: LABEL_APPROVED };
// Briefs first (config `brief: "pause"`): what started this run — the `agent` label, `agent:approved`,
// a comment while a brief waits, or a run by hand (README.md, "The brief").
const PAUSE = CONFIG.brief === "pause";
// Locally: `--trigger comment` answers the latest comment on a brief, `--trigger approved` builds the approved one.
const TRIGGER = process.env.ISSUE_AGENT_TRIGGER || { comment: "comment", approved: `label:${LABEL_APPROVED}` }[opt("--trigger")] || "label:agent";
const STARTS_OVER = TRIGGER === "label:agent" || TRIGGER === "dispatch"; // (re-)adding `agent` starts a new round of briefs

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
    [LABELS.working, "1D76DB", "Issue agent: working on this issue now (see the status comment)"],
    [LABELS.inReview, "FBCA04", "Issue agent: still iterating with the Claude reviewer — not ready for a human yet"],
    [LABELS.ready, "0E8A16", "Issue agent: every review is resolved — ready for a human review"],
    [LABELS.needsHuman, "D93F0B", "Issue agent: stopped — a human has to take this over"],
    ...(PAUSE ? [
      [LABELS.awaiting, "C5DEF5", "Issue agent: a brief is waiting — approve it, or reply to it"],
      [LABELS.approved, "0E8A16", "Issue agent: a person approved the latest brief — build it (never added by the agent)"],
    ] : []),
  ]) sh("gh", ["label", "create", name, "-R", REPO, "--color", color, "--description", description, "--force"], { allowFail: true });
};

let RUN; // per issue: { id, dir, costUsd, log() }
// `quiet`: the log goes to run.log only, not the job's public console (a brief may turn out to be about
// a security hole, which is never described in public — see briefIssue).
const newRun = (n, dir, { quiet = false } = {}) => {
  const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  dir ??= join(RUNS_HOME, `${typeof n === "number" ? `issue-${n}` : n}-${id}`); // n: an issue number, or e.g. "pr-396"
  mkdirSync(dir, { recursive: true });
  return { id, dir, costUsd: 0, models: {}, log: (s) => { if (!quiet) console.log(s); appendFileSync(join(dir, "run.log"), s + "\n"); } };
};

// ── the issue's live status (README, "Seeing what it's working on") ─────────────────────────────
// One comment on the issue, edited in place, and the agent:working label while work is in flight.
// Only the trusted jobs call this (the agents' job holds no token). A status update never fails a run.
function setStatus(n, state, { working } = {}) {
  if (!n || flag("--dry-run") || flag("--no-publish")) return;
  try {
    const comments = ghJson(["api", "--paginate", "--slurp", `repos/${REPO}/issues/${n}/comments?per_page=100`]).flat();
    // Ours: the marker, written by the workflow's bot or by the token's (write-access) user — never
    // an outsider's comment that copies the marker.
    const mine = comments.filter((c) => String(c.body).startsWith(STATUS_MARK)
      && (c.user?.type === "Bot" ? c.user.login === "github-actions[bot]" : trusted(c.user?.login))).at(-1);
    const body = statusBody(mine?.body, state, { link: actionsRunUrl() });
    if (mine) gh(["api", "-X", "PATCH", `repos/${REPO}/issues/comments/${mine.id}`, "-f", `body=${body}`]);
    else gh(["issue", "comment", String(n), "-R", REPO, "--body", body]);
  } catch (e) {
    console.error(`(status comment for #${n} failed: ${e.message.split("\n")[0]})`);
  }
  // Separately, so a failed comment write can't leave the label stale.
  if (working !== undefined) {
    ensureLabels();
    sh("gh", ["issue", "edit", String(n), "-R", REPO, working ? "--add-label" : "--remove-label", LABELS.working], { allowFail: true });
  }
}

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
    number title body url state lastEditedAt author{login __typename} labels(first:50){nodes{name}} assignees(first:10){nodes{login}}
    timelineItems(itemTypes:[RENAMED_TITLE_EVENT], last:20){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}
    comments(last:100){nodes{author{login __typename} body createdAt lastEditedAt}}}}}`;
  const i = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`]).data.repository.issue;
  const after = (t) => Boolean(t) && Date.parse(t) > Date.parse(snapshotAt);
  const dropped = [];
  // The title is words too: it's trusted when whoever wrote it last (the author, or the last renamer)
  // has write access. A rename after the label is refused like a body edit (lastEditedAt misses renames).
  const renames = i.timelineItems.nodes;
  if (renames.some((e) => after(e.createdAt))) return { skip: `the issue was renamed after it was labelled; remove and re-add the \`${TRIGGER_LABEL}\` label to run on the current title` };
  // A ticket the pipeline opened from an approved plan (scope.mjs): its words are the approved brief's.
  const ticket = isLoopAuthor(i.author, trusted) ? parseTicket(i.body) : undefined;
  const titleBy = titleAuthor(i.author?.login, renames);
  let title = i.title;
  if (ticket && !renames.length) { /* the pipeline's own title, never renamed */ }
  else if (!trusted(titleBy)) { dropped.push(`the issue title (by ${titleBy ?? "a deleted user"}, who has no write access)`); title = `Issue #${i.number}`; }
  let body = i.body ?? "";
  // A ticket edited by hand gets a brief like any issue. If the github-actions app opened it, its author
  // has no permission to check, but only someone with write access can edit it: keep its words.
  const editedTicket = !ticket && isLoopAuthor(i.author, trusted) && Boolean(ticketHeader(i.body));
  if (!ticket && !editedTicket && !trusted(i.author?.login)) { dropped.push(`the issue body (by ${i.author?.login ?? "a deleted user"}, who has no write access)`); body = ""; }
  else if (after(i.lastEditedAt)) return { skip: `the issue was edited after it was labelled (${i.lastEditedAt}); remove and re-add the \`${TRIGGER_LABEL}\` label to run on the current text` };
  const nodes = i.comments.nodes;
  const { comments, dropped: droppedComments } = requestComments(nodes, { isTrusted: trusted, snapshotAt });
  dropped.push(...droppedComments);
  const issue = { number: i.number, title, body, url: i.url, state: i.state, author: i.author?.login,
    labels: i.labels.nodes.map((l) => l.name), assignees: i.assignees.nodes.map((a) => a.login), comments, dropped, snapshotAt };
  if (!body.trim() && !comments.length) return { issue, skip: "nothing on this issue was written by someone with write access — a maintainer can restate the request in a comment, then re-add the label" };
  // Briefs first: what this trigger starts, and the talk so far. The request is what came before the
  // first brief; everything after it is the conversation, the agents' own answers included.
  const state = briefState(nodes, trusted);
  const plan = planRun({ trigger: TRIGGER, pause: PAUSE, labels: issue.labels, state, issueEditedAt: i.lastEditedAt, ticket: ticket && ticketAsBrief(ticket) });
  if (ticket && plan.phase === "implement") {
    // Done means closed as completed: a blocker dropped as not planned never delivered what this needs.
    // The label comes off (`unlabel`), so `unblock` can put it back when the blockers are done.
    const left = blockersLeft((ticket.blockedBy ?? []).map((b) => ({ number: b, ...ghJson(["issue", "view", String(b), "-R", REPO, "--json", "state,stateReason"]) })));
    const [open, dropped] = [left.open, left.dropped].map((ns) => ns.map((b) => `#${b}`));
    if (dropped.length) return { issue, unlabel: true, skip: `this ticket is blocked by ${dropped.join(", ")}, which ${dropped.length > 1 ? "were" : "was"} closed without being completed, so it won't start on its own. Reopen and finish ${dropped.length > 1 ? "them" : "it"}, or edit this ticket (it then gets a brief of its own) and re-add \`${TRIGGER_LABEL}\`` };
    if (open.length) return { issue, unlabel: true, skip: `this ticket is blocked by ${open.join(", ")} — it starts on its own when ${open.length > 1 ? "they are" : "that is"} closed as completed` };
  }
  if (plan.skip) return { issue, skip: plan.skip, quiet: plan.quiet };
  if (PAUSE && state.firstAt && !STARTS_OVER) {
    const { before, conversation } = splitConversation(nodes, { isTrusted: trusted, isOurs: (a) => isLoopAuthor(a, trusted), snapshotAt, fromVersion: state.roundStart });
    issue.comments = requestComments(before, { isTrusted: trusted, snapshotAt }).comments;
    issue.conversation = conversation;
    issue.previousBrief = state.latest;
  }
  if (plan.brief) issue.brief = plan.brief;
  return { issue, phase: plan.phase, skip: preflight(issue) };
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
  // With briefs, a decision is what the brief is for: approving it decides.
  const blocking = issue.labels.filter((l) => BLOCKING_LABELS.includes(l) && !(PAUSE && l === "needs-decision"));
  if (blocking.length) return `it is labelled ${blocking.join(", ")} — a maintainer has to act first`;
  // Someone else has taken it: don't race them. (Assigned to whoever labelled it is fine.)
  const labeller = process.env.ISSUE_AGENT_LABELLER;
  // Checked when work starts; a reply to a brief or its approval continues what that check allowed.
  const others = (issue.assignees ?? []).filter((a) => a !== labeller);
  if (others.length && (TRIGGER === "label:agent" || TRIGGER === "dispatch")) return `it is assigned to ${others.join(", ")} — unassign them first if the agent should take it`;
  const prs = openPrsFor(issue.number);
  if (prs.length) return `it already has an open pull request: ${prs.map((p) => p.url).join(", ")}`;
  return null;
}

// ══ 2. implement (agents + gates; needs NO GitHub access) ═════════════════════════════════════════
const READ_TOOLS = ["Read", "Grep", "Glob"];
const INSPECT_BASH = ["Bash(git diff *)", "Bash(git diff)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)", "Bash(git status)", "Bash(ls *)", "Bash(grep *)", "Bash(sed -n *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(cat *)"];
// Running the project's checks executes the implementer's code; reviewers may, but their tree is reset after.
const CHECK_BASH = CONFIG.checkTools;
// Claude Code refuses writes under .claude/ unless a rule names the path, so skills get explicit rules
// (both the cwd-relative `path` form and the project-root-relative `/path` form). Nothing else under .claude/ is allowed, and the
// publish step refuses it anyway (checks.mjs, forbiddenPaths). Unconfirmed that the SDK honours these
// over its .claude/ protection: check with a local --no-publish run on an issue that edits a skill.
const SKILL_EDITS = ["Edit", "Write", "MultiEdit"].flatMap((t) => [`${t}(.claude/skills/**)`, `${t}(/.claude/skills/**)`]);
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", ...SKILL_EDITS, "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(mkdir *)"];
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
  const model = roleModel(role, MODELS);
  RUN.models[role] = model;
  RUN.log(`▶ ${role} · ${model}${resume ? " (resumed)" : ""}`);
  let sessionId = resume, result, structured, cost = 0, error, sawResult = false;
  const allowed = Math.min(AGENT_BUDGET_USD, remaining, cap ?? Infinity);
  try {
  for await (const msg of query({
    prompt,
    options: {
      model,
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

// The repo's build (config.mjs), if it has one. Never fatal: a red main is measured by the baseline.
const build = (dir) => CONFIG.build && code(CONFIG.build[0], CONFIG.build.slice(1), { cwd: dir, allowFail: true });

// `reuseFrom`: a checkout whose dependencies are already installed. With a byte-identical lockfile its
// node_modules are copied instead of running `npm ci` again — copied, not linked: workspace packages
// are relative symlinks, which must resolve to THIS checkout's packages (main's code, for "before").
function checkout(dir, ref, { reuseFrom } = {}) {
  git(["fetch", "--quiet", "origin", "main"]);
  if (existsSync(dir)) git(["worktree", "remove", "--force", dir], { allowFail: true });
  git(["worktree", "add", "--quiet", "--detach", dir, ref]);
  RUN.log(`  checkout ${ref} → ${dir}`);
  const lock = (d) => (existsSync(join(d, "package-lock.json")) ? readFileSync(join(d, "package-lock.json"), "utf8") : undefined);
  if (reuseFrom && existsSync(join(reuseFrom, "node_modules")) && sameLockfile(lock(dir), lock(reuseFrom))) {
    const workspaces = existsSync(join(reuseFrom, "packages")) ? readdirSync(join(reuseFrom, "packages")).map((p) => join("packages", p, "node_modules")) : [];
    for (const rel of ["node_modules", ...workspaces]) {
      if (existsSync(join(reuseFrom, rel))) cpSync(join(reuseFrom, rel), join(dir, rel), { recursive: true, verbatimSymlinks: true });
    }
    RUN.log(`  same package-lock.json as ${reuseFrom} — reused its installed dependencies, skipped npm ci`);
  } else if (CONFIG.install) {
    code(CONFIG.install[0], CONFIG.install.slice(1), { cwd: dir });
  }
  build(dir); // a red main is measured by the baseline, not fatal here
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
// The gates are the repo's (config.mjs; by default build, typecheck, lint, test). `test` picks the test
// command (testGateCommand): the root one unless a fix attempt asks for the fast one; `only` runs a
// subset (the once-per-round root test run).
const GATES = CONFIG.gates;
const ROOT_TEST = testGateCommand({ phase: "pre-review" }, CONFIG);
const SUMMARY = CONFIG.testSummary ? new RegExp(CONFIG.testSummary, "gm") : undefined;

function runGates(dir, { baseline, stopOnFail = true, test = ROOT_TEST, only } = {}) {
  const results = [];
  for (const { name, cmd: gateCmd } of GATES) {
    if (only && !only.includes(name)) continue;
    const [cmd, cmdArgs] = name === "test" ? [test.cmd, test.args] : [gateCmd[0], gateCmd.slice(1)];
    const r = code(cmd, cmdArgs, { cwd: dir, allowFail: true });
    const summary = name === "test" && SUMMARY ? testSummary(r.out) : undefined;
    const fps = r.code === 0 ? [] : fingerprints(name, r.out, dir);
    const base = baseline?.find((b) => b.name === name);
    const preexisting = r.code !== 0 && Boolean(base) && !base.green && fps.length > 0 && withinBaseline(fps, base.fingerprints);
    const ok = r.code === 0 || preexisting;
    results.push({ name, ok, green: r.code === 0, preexisting, fingerprints: fps, summary, tail: tail(r.out, 80), ...(name === "test" ? { scope: test.scope } : {}) });
    if (baseline) RUN.log(`  gate ${name}${name === "test" ? ` (${test.scope === "root" ? `root ${TEST}` : `fast: ${cmd} ${cmdArgs.join(" ")}`})` : ""}: ${r.code === 0 ? "pass" : preexisting ? "pass (only failures the starting code already had)" : "FAIL"}${summary ? ` — ${summary}` : ""}`);
    if (!ok && stopOnFail) break; // later gates on a broken build are noise
  }
  return results;
}

// The test run's summary line(s) for the PR, e.g. vitest's "Tests  95 passed (95)" — every distinct
// match, without terminal colour codes.
const testSummary = (out) => [...new Set(stripAnsi(out).match(SUMMARY) ?? [])].map((s) => s.trim()).join(" · ") || undefined;

// A commit's own gate results (the baseline) don't change: measure each commit once per process, and
// reuse it for a later run in the same process (`--poll` working through several issues on one main).
// Kept in memory, never on disk: agent-written code runs unsandboxed between runs, and a file it could
// write would let one run's code tell the next which failures are "main's own".
const BASELINES = new Map();
function baselineFor(dir, sha, label) {
  if (isCommitId(sha) && BASELINES.has(sha)) {
    RUN.log(`  baseline (${label} ${sha.slice(0, 7)}): reused — this commit was already measured in this process`);
    return BASELINES.get(sha);
  }
  const baseline = runGates(dir, { stopOnFail: false });
  if (isCommitId(sha)) BASELINES.set(sha, baseline);
  return baseline;
}

const baselineNote = (baseline) => {
  const red = baseline.filter((b) => !b.green);
  return red.length
    ? `\n\nNOTE — the code you start from (main, or in a review cycle the PR's head) is already red before your change. These failures are NOT yours: do not fix them, do not touch their files unless the issue requires it (the pipeline ignores exactly these, and no more of them):\n${red.map((b) => `- ${b.name}: ${b.fingerprints.join("; ") || "(failed with no parsable detail)"}`).join("\n")}`
    : "";
};

// The changed tests must fail on main's source and pass on the fix. Revert every changed non-test
// source file to the base (deleting added ones), run only the changed test files, then put the fix back.
function mutationCheck(dir, base, spec) {
  if (!spec.behavior_change) return { applicable: false, reason: "the spec marks this a docs-only / no-behavior change" };
  trackNew(dir);
  const changed = git(["diff", "--name-status", "--no-renames", base], { cwd: dir }).out.trim().split("\n").filter(Boolean)
    .map((l) => l.split("\t")).map(([s, f]) => ({ status: s[0], file: f }));
  const isTest = (f) => new RegExp(CONFIG.testFile).test(f);
  const tests = changed.filter((c) => isTest(c.file) && c.status !== "D").map((c) => c.file);
  const src = changed.filter((c) => !isTest(c.file) && isMutableSource(c.file, CONFIG));
  if (!tests.length) return { applicable: true, ok: false, reason: "behavior changed but no test file was added or changed" };
  // Only tests changed: there is no behavior here for them to guard, and no retry could change that —
  // so this isn't a failure to fix (on #362 it cost a whole run of retries), just nothing to check.
  if (!src.length) return { applicable: false, reason: "only tests changed (no source file the check can revert)" };

  const patch = diffPatch(dir, base);
  let without;
  try {
    for (const c of src) {
      if (c.status === "A") rmSync(join(dir, c.file), { force: true });
      else git(["checkout", base, "--", c.file], { cwd: dir });
    }
    build(dir);
    without = runTests(dir, tests);
  } finally {
    restorePatch(dir, base, patch);
    build(dir);
  }
  const withFix = runTests(dir, tests);
  const ok = without.code !== 0 && withFix.code === 0;
  RUN.log(`  mutation: ${tests.length} changed test file(s) ${without.code !== 0 ? "FAIL" : "PASS"} without the fix, ${withFix.code === 0 ? "pass" : "FAIL"} with it → ${ok ? "ok" : "NOT OK"}`);
  return {
    applicable: true, ok, tests, reverted: src.map((c) => c.file),
    withoutFix: { code: without.code, tail: tail(stripAnsi(without.out), 70) },
    withFix: { code: withFix.code, tail: tail(stripAnsi(withFix.out), 30) },
    reason: ok ? undefined : without.code === 0 ? "the changed tests still PASS with the fix reverted — they don't guard it" : "the changed tests fail WITH the fix",
  };
}

const runTests = (dir, files) => code(CONFIG.testRunner[0], [...CONFIG.testRunner.slice(1), ...files], { cwd: dir, allowFail: true });

// The change itself, handed to the reviewers up front so they spend their turns reviewing, not
// running git. Capped: a cut diff says so, and `git diff` still shows the rest.
const DIFF_CAP = 80_000;
function reviewDiff(dir, base) {
  trackNew(dir);
  const stat = git(["diff", "--stat", base], { cwd: dir }).out.trim();
  const patch = git(["diff", base], { cwd: dir }).out;
  const cut = patch.length > DIFF_CAP;
  return `\n\n<diff base="${base}">\n${stat}\n\n${cut ? patch.slice(0, DIFF_CAP) : patch}${cut ? `\n… [cut at ${DIFF_CAP} of ${patch.length} characters — run \`git diff ${base}\` for the rest]` : ""}\n</diff>`;
}

// What the pipeline measured, handed to the reviewers so they judge it instead of guessing.
function pipelineFacts(r, baseline) {
  const m = r.mutation;
  return `\n\n<pipeline_facts>
These were measured by the pipeline (not claimed by the implementer):
- Gates from the repo root (\`test\` is the root \`${TEST}\`, run once this round after the fix attempts passed): ${r.gates.map((g) => `${g.name} ${g.green ? "green" : g.preexisting ? "red only with failures the starting code already had" : "RED"}${g.summary ? ` (${g.summary})` : ""}`).join("; ")}.
- The code this change starts from (main, or in a review cycle the PR's head), before the change: ${baseline.map((b) => `${b.name} ${b.green ? "green" : `red: ${b.fingerprints.join("; ")}`}`).join("; ")}. Pre-existing failures are not this change's to fix; a diff that "fixes" them unasked is out of scope.
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
  const roles = (await import("./roles.mjs")).forRepo(CONFIG);
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
  const baseline = baselineFor(repoDir, base, "main");
  RUN.log(`  baseline (main ${base.slice(0, 7)}): ${baseline.map((b) => `${b.name} ${b.green ? "green" : `RED (${b.fingerprints.length})`}`).join(" · ")}`);

  // An approved brief IS the spec, word for word (brief.mjs); without one, the spec agent writes it.
  const spec = issue.brief
    ? { ...specFromBrief(issue.brief.brief), from_brief: issue.brief.v }
    : (await agent("spec", roles.specPrompt(issue), { cwd: repoDir, schema: roles.SPEC_SCHEMA, maxTurns: 60 })).out;
  if (issue.brief) { RUN.log(`  spec: the approved brief v${issue.brief.v} (${spec.acceptance_criteria.length} criteria)`); writeFileSync(join(RUN.dir, "spec.json"), JSON.stringify(spec, null, 2)); }
  if (!spec.actionable) {
    RUN.log(`  not actionable: ${spec.blocker}`);
    return outcome({ status: "blocked", reason: spec.blocker, spec });
  }

  const { rounds, reviewedPatch, stopped, challenge } = await iterate({
    issue, spec, roles, repoDir, baseline, diffBase: base, mutationBase: base,
    firstPrompt: roles.implementPrompt(issue, spec), schema: roles.IMPLEMENT_SCHEMA, allowChallenge: Boolean(spec.from_brief),
  });
  if (challenge) {
    RUN.log(`  the implementer challenges ${challenge.criterion} of the approved brief — back to the maintainer`);
    return outcome({ status: "challenged", challenge, brief: issue.brief.v, ...(issue.brief.ticket ? { ticket: issue.brief.ticket } : {}), reason: `${challenge.criterion}: ${challenge.why}` });
  }
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

// implement → [gates (fast tests) → mutation → root test, fixed in place up to MAX_FIXES times] →
// review, until clean or out of rounds. Mechanical failures are fixed inside a round, so review rounds go to what only a reviewer
// catches. Shared by a new issue and by the review loop:
//   diffBase      what the reviewers diff against and the patch is taken from (main, or the PR head)
//   mutationBase  what the test-proof check reverts the source to (always main's merge base)
//   allowChallenge  the first build of an approved brief: the implementer may hand a criterion back
async function iterate({ issue, spec, roles, repoDir, baseline, diffBase, mutationBase, firstPrompt, schema, allowChallenge = false }) {
  const base = diffBase;
  let impl, session, feedback, reviewedPatch, stopped, challenge;
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
        // A criterion of an approved brief is the maintainer's to change, not the implementer's.
        if (allowChallenge && impl.challenge?.criterion) { challenge = impl.challenge; break; }
        trackNew(repoDir);
        // Between attempts, only the tests of what changed; the root test run comes once, below.
        const fast = testGateCommand({ phase: "fix", changed: changedSince(repoDir, mutationBase) }, CONFIG);
        const g = runGates(repoDir, { baseline, test: fast });
        r = { round, attempt, base, gates: g, impl };
        const gateFailed = (bad) => {
          const baseFps = baseline.find((b) => b.name === bad.name)?.fingerprints ?? [];
          const fresh = bad.fingerprints.filter((f) => !baseFps.includes(f));
          const cmd = bad.name !== "test" ? GATES.find((x) => x.name === bad.name).cmd.join(" ") : bad.scope === "root" ? TEST : `${fast.cmd} ${fast.args.join(" ")}`;
          return `The \`${cmd}\` gate FAILED when the pipeline ran it from the repo root.${fresh.length ? `\nFailures your change introduced:\n${fresh.map((f) => `- ${f}`).join("\n")}` : ""}\n\n\`\`\`\n${bad.tail}\n\`\`\``;
        };
        const bad = g.find((x) => !x.ok);
        if (bad) { feedback = gateFailed(bad); continue; }
        r.mutation = mutationCheck(repoDir, mutationBase, spec);
        if (mutationBase !== base) restoreHead(repoDir, base); // mutationCheck leaves HEAD at its base
        if (r.mutation.applicable && !r.mutation.ok) {
          feedback = `Test-proof check failed: ${r.mutation.reason}.\nThe pipeline reverted your source changes (${(r.mutation.reverted ?? []).join(", ") || "none"}) and ran ${(r.mutation.tests ?? []).join(", ") || "no tests"}.\n\n\`\`\`\n${r.mutation.withoutFix?.tail ?? ""}\n\`\`\`\nA behavior change needs a test that fails without it.`;
          continue;
        }
        // Once per round, before the reviews: the authoritative root test run (CLAUDE.md). It replaces
        // the fast run in the round's record — publish won't open as ready a patch it didn't pass on.
        const [root] = runGates(repoDir, { baseline, only: ["test"] });
        root.patchSha256 = createHash("sha256").update(diffPatch(repoDir, base)).digest("hex"); // what it ran on
        r.gates = [...g.filter((x) => x.name !== "test"), root];
        if (!root.ok) { feedback = gateFailed(root); continue; }
        r.mechanicalOk = true;
        break;
      }
      if (challenge) break;
      rounds.push(r);
      if (!r.mechanicalOk) { RUN.log(`  round ${round}: gates/test proof still red after ${MAX_FIXES} fixes`); continue; }

      // Freeze what the reviewers review. Their test runs execute the change; whatever they leave
      // behind is thrown away, and this exact patch is what gets published.
      const patch = diffPatch(repoDir, base);
      const facts = reviewDiff(repoDir, base) + pipelineFacts(r, baseline);
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
  return { rounds, impl, reviewedPatch, stopped, challenge };
}

async function finishImplement({ issue, spec, roles, n, repoDir, base, rounds, last, done, patch, touched, forbidden, stopped, outcome, renderHtml, proofHtml }) {

  // evidence — after the patch is frozen, so nothing the evidence agent does can reach the PR
  const evidenceDir = join(RUN.dir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  let evidence, example;
  const beforeDir = join(RUN.dir, "before");
  if (done) checkout(beforeDir, base, { reuseFrom: repoDir });
  // Before and after for a developer (README, "Before and after"): an agent proposes the example, the
  // pipeline runs it on main and on the change and records what each printed. A page change gets its
  // screenshots below instead.
  // On with briefs (`"brief": "pause"`), so another repo keeps today's PRs until it opts in.
  if (done && !spec.touches_ui && PAUSE) {
    try {
      const { out } = await agent("example", roles.examplePrompt({ issue, spec, beforeDir, afterDir: repoDir, reproduced: issue.brief?.brief?.reproduced }),
        { cwd: evidenceDir, schema: roles.EXAMPLE_SCHEMA, write: true, additionalDirectories: [beforeDir, repoDir], maxTurns: 60 });
      const ex = validateExample(out);
      if (ex.error) throw new Error(`the example was refused: ${ex.error}`);
      if (ex.notApplicable) example = { notApplicable: ex.notApplicable };
      else {
        example = runExample(ex, { beforeDir, afterDir: repoDir }, (cmd, args, o) => code(cmd, args, { ...o, allowFail: true, timeout: 120_000 }));
        RUN.log(`  before and after: exit ${example.before.code} on main, ${example.after.code} with the change${example.same ? " — SAME output" : ""}`);
        await renderHtml({ outDir: evidenceDir, name: "before-after", side: "example", html: exampleHtml(example), caption: `Before and after: ${example.title}` });
      }
    } catch (e) {
      example = { failed: e.message.split("\n")[0].slice(0, 300) };
      RUN.log(`  before and after: ${example.failed}`);
    }
  }
  if (done && spec.touches_ui) {
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
    html: proofHtml({ issue, spec, last, base, patchSha256: createHash("sha256").update(patch).digest("hex") }),
    caption: last.mutation?.applicable
      ? "Test proof: the pipeline's own gate runs, and the changed tests failing on main's code and passing on the fix"
      : "Test proof: the pipeline's own gate runs (no failing-test check: the spec found no behavior change)",
  });
  const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
  const report = {
    issue, spec, rounds, last, done: done && !forbidden.length, evidence, example, manifest, base, model: MODEL, models: RUN.models, costUsd: RUN.costUsd, id: RUN.id,
    stopped: forbidden.length ? `the change touches ${forbidden.join(", ")} — the agent never publishes changes under .github/, or under .claude/ outside its skills` : stopped,
    patchSha256: createHash("sha256").update(patch).digest("hex"), files: touched,
  };
  writeFileSync(join(RUN.dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(evidenceDir, "index.html"), reportHtml(report, { mediaBase: "" }));
  RUN.log(`  report → ${join(evidenceDir, "index.html")}`);
  return outcome({ status: report.done ? "ready" : "needs-human", reason: report.stopped, report: join(evidenceDir, "index.html") });
}

// ══ 2b. brief (agents; needs NO GitHub access) — README.md, "The brief" ═══════════════════════════
//
// Before any code: an agent reproduces the problem on main, works out how bad it is and how to fix it,
// and writes the brief a person approves. The plain-language check (card.mjs) sends the card back
// until it passes (twice at most; publish posts what's left flagged). Everything it writes in the
// checkout is thrown away: only the brief's text leaves this job.
//
// A brief about a security hole in code people can use today (isPrivate) is never posted: the run
// keeps nothing but its outcome, and its log never reaches the job's public console.
async function briefIssue(issue, { dir } = {}) {
  const roles = (await import("./roles.mjs")).forRepo(CONFIG);
  const n = issue.number;
  RUN = newRun(n, dir, { quiet: true });
  console.log(`━━ issue #${n} · brief · run ${RUN.id} — the log is in run.log, not here: a brief can be about a security hole`);
  const outcome = (o) => { writeFileSync(join(RUN.dir, "outcome.json"), JSON.stringify({ n, id: RUN.id, ...o }, null, 2)); return { n, dir: RUN.dir, ...o }; };
  const repoDir = join(RUN.dir, "repo");
  checkout(repoDir, "origin/main");
  const base = git(["rev-parse", "HEAD"], { cwd: repoDir }).out.trim();
  const previous = issue.previousBrief;
  const problemsOf = (b) => (b.actionable ? [...cardProblems(b.card, { criteria: b.acceptance_criteria, behaviorChange: b.behavior_change }), ...scopeProblems(b)] : []);
  let { out: brief, sessionId } = await agent("brief", roles.briefPrompt(issue, { previous }), { cwd: repoDir, schema: roles.BRIEF_SCHEMA, write: true, maxTurns: 100 });
  let problems = problemsOf(brief);
  for (let fix = 1; problems.length && fix <= 2; fix++) {
    RUN.log(`  plain-language check: ${problems.length} problem(s) — rewrite ${fix}: ${problems.join("; ")}`);
    ({ out: brief } = await agent(`brief-fix${fix}`, roles.briefFixPrompt(problems), { cwd: repoDir, schema: roles.BRIEF_SCHEMA, write: true, resume: sessionId, maxTurns: 30 }));
    problems = problemsOf(brief);
  }
  const decided = briefOutcome(brief);
  if (decided.status === "security-stop") {
    for (const f of readdirSync(RUN.dir)) if (f !== "repo") rmSync(join(RUN.dir, f), { recursive: true, force: true });
    return outcome(decided);
  }
  if (decided.status === "blocked") return outcome(decided);
  writeFileSync(join(RUN.dir, "brief-result.json"), JSON.stringify({ brief, base, asOf: issue.snapshotAt }, null, 2));
  return outcome({ status: "brief", revised: !previous || brief.revised !== false });
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
    setStatus(trustedN, "the run failed before it could open a PR", { working: false });
    return { n: trustedN, status: "error", reason: "the implement phase produced no outcome" };
  }
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  const n = publishIssueNumber(trustedN, outcome.n);
  if (!isRunId(outcome.id)) throw new Error(`not a run id: ${outcome.id}`);
  RUN ??= { id: outcome.id, dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(join(dir, "run.log"), s + "\n"); } };
  if (outcome.status === "challenged") {
    // The implementer questions a criterion of the approved brief: back to the maintainer, nothing built.
    const v = Number(outcome.brief);
    if (!Number.isInteger(v) || v < 1) throw new Error(`not a brief version: ${outcome.brief}`);
    const challenge = { v, criterion: String(outcome.challenge?.criterion ?? "").slice(0, 200), why: String(outcome.challenge?.why ?? "").slice(0, 2000), asOf: readAt() };
    if (outcome.ticket) {
      // A ticket has no brief of its own to revise: the ticket is edited — which makes it an ordinary
      // issue that gets its own brief — or the plan is replaced on the parent. Until then it is marked
      // stopped, so a sibling closing never restarts it (scope.mjs, frontier).
      const parent = Number(outcome.ticket.parent);
      gh(["issue", "comment", String(n), "-R", REPO, "--body", `${challengeBody(challenge).split("\n\nReply to settle it")[0]}\n\nThis is a ticket of the plan approved on #${parent}, so there is no brief here to reply to. To settle it:\n\n- **Change this ticket:** edit this issue (it then gets a brief of its own) and re-add \`${TRIGGER_LABEL}\`. The tickets after it still wait for it to be completed.\n- **Build it as approved anyway:** say in a comment here why the criterion stands (your comment reaches the builder), then remove \`${LABELS.needsHuman}\` and re-add \`${TRIGGER_LABEL}\`.\n- **Change the whole plan:** close the plan's open tickets as *not planned* and their open pull requests, remove \`epic\` from #${parent} and re-add \`${TRIGGER_LABEL}\` there — it gets a new brief, and approving it opens a new set of tickets.`]);
      relabel(n, { add: [LABELS.needsHuman], remove: [TRIGGER_LABEL] });
    } else {
      gh(["issue", "comment", String(n), "-R", REPO, "--body", challengeBody(challenge)]);
      relabel(n, { add: [LABELS.awaiting], remove: [LABELS.approved] });
    }
    setStatus(n, `stopped before building — the agents question part of brief v${v}; reply to settle it`, { working: false });
    return { n, status: "challenged" };
  }
  if (outcome.status === "blocked") {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "blocked", reason: outcome.reason })]);
    setStatus(n, `not started — not actionable yet: ${outcome.reason}`, { working: false });
    return { n, status: "blocked", reason: outcome.reason };
  }
  if (!existsSync(join(dir, "report.json"))) {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason: outcome.reason, where: actionsRunUrl() })]);
    setStatus(n, `stopped, no PR — ${outcome.reason ?? "the run stopped early"}`, { working: false });
    return { n, status: outcome.status, reason: outcome.reason };
  }
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const id = outcome.id;
  const patch = readFileSync(join(dir, "change.patch"), "utf8");
  // A consistency check against an accident, not a seal: both files come from the same job.
  if (createHash("sha256").update(patch).digest("hex") !== report.patchSha256) throw new Error("change.patch does not match the reviewed patch recorded in report.json");
  if (!patch.trim()) {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason: "the agents produced no change", where: actionsRunUrl() })]);
    setStatus(n, "stopped, no PR — the agents produced no change", { working: false });
    return { n, status: "needs-human", reason: "empty change" };
  }
  // Never a "ready" change that didn't pass the root `npm test` on exactly this patch (a fast run
  // doesn't count); an unfinished one still opens as a `[needs human]` draft, saying it wasn't run.
  const verdict = publishVerdict({ done: report.done === true, last: report.last, patchSha256: report.patchSha256, stopped: report.stopped, label: TEST });
  if (!verdict.open) {
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason: verdict.reason, where: actionsRunUrl() })]);
    setStatus(n, `stopped, no PR — ${verdict.reason}`, { working: false });
    return { n, status: "needs-human", reason: verdict.reason };
  }
  Object.assign(report, { done: verdict.done, stopped: verdict.stopped });
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
    const reason = `the change touches ${forbidden.join(", ")} — the agent never publishes changes under .github/, or under .claude/ outside its skills`;
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "needs-human-nopr", reason, where: actionsRunUrl() })]);
    setStatus(n, `stopped, no PR — ${reason}`, { working: false });
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
    writeFileSync(join(dir, "pr-body.md"), prBody(report, { mediaBase: `https://raw.githubusercontent.com/${REPO}/${EVIDENCE_BRANCH}/issue-${n}/${id}/`, repo: REPO, harnessRepo: HARNESS_REPO ?? REPO, commands: PR_COMMANDS }));
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
    const banner = loop ? `> [!NOTE]\n> **The agent is still working on this with the Claude reviewer** — it fixes what the review marks ⛔ as blocking, asks for one re-review, and asks for a human review once the review is ✅ (at most ${MAX_REVIEW_CYCLES} cycles). No need to review it yet.\n\n` : "";
    writeFileSync(bodyFile, banner + prBody(report, { mediaBase, repo: REPO, harnessRepo: HARNESS_REPO ?? REPO, commands: PR_COMMANDS }) + (labeller ? `\n<!-- issue-agent labeller=${labeller} -->\n` : ""));
    // A single brief past SCOPE_LIMITS passed only by saying why it can't be split; approving it is the
    // size waiver the scope check asks a maintainer for (ci/pr-scope/check.mjs). Read from the issue's
    // own comments, never the run's report.
    const briefs = PAUSE ? briefState(issueComments(n), trusted) : undefined;
    // The brief this run built (a comment since approval doesn't un-approve it; one edited by hand isn't the agents').
    const waived = Boolean(briefs?.latest) && !briefs.latestEdited && !isSplit(briefs.latest.brief) && pastLimits(briefs.latest.brief);
    if (waived) sh("gh", ["label", "create", SCOPE_WAIVER, "-R", REPO, "--color", "BFD4F2", "--description", "Too big for one review, and a maintainer approved it anyway (pr-scope)"], { allowFail: true });
    const created = sh("gh", ["pr", "create", "-R", REPO, ...(loop ? [] : ["--draft"]), "--base", "main", "--head", branch,
      "--title", done ? issue.title : `[needs human] ${issue.title}`, "--body-file", bodyFile, ...(waived ? ["--label", SCOPE_WAIVER] : [])], { allowFail: true });
    if (created.code !== 0) throw Object.assign(new Error(`gh pr create failed:\n${created.out.slice(-2000)}`), { hint: publishRefusalHint(created.out, branch, { harnessRepo: HARNESS_REPO ?? REPO, done }) });
    prUrl = created.out.trim();
    if (loop) { ensureLabels(); gh(["pr", "edit", prUrl, "-R", REPO, "--add-label", LABELS.inReview]); }
    gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: loop ? "pr-in-review" : done ? "pr" : "needs-human", prUrl, report })]);
    setStatus(n, loop ? `PR opened: ${prUrl} — now working through the Claude review on it` : done ? `draft PR opened: ${prUrl}` : `draft PR opened, but it needs a human: ${prUrl}`, { working: loop });
  }
  RUN.log(`  PR → ${prUrl}`);
  return { n, status: done ? "pr-open" : "needs-human", pr: prUrl };
}

// ── publishing a brief (trusted; GitHub write access; never runs agent-written code) ──────────────
// The run directory is untrusted input, as for publishRun: the issue number must match, the brief is
// re-checked here (its shape, the plain-language rules, and whether it may be public at all), and the
// version comes from the issue's own comments.
const issueComments = (n) => {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){comments(last:100){nodes{id author{login __typename} body createdAt lastEditedAt}}}}}`;
  return ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`]).data.repository.issue.comments.nodes;
};
const relabel = (n, { add = [], remove = [] }) => {
  if (flag("--dry-run") || flag("--no-publish")) return;
  ensureLabels();
  for (const l of remove) sh("gh", ["issue", "edit", String(n), "-R", REPO, "--remove-label", l], { allowFail: true });
  for (const l of add) {
    if (l === LABELS.approved) throw new Error("the pipeline never approves a brief"); // only a person does (README, "The brief")
    sh("gh", ["issue", "edit", String(n), "-R", REPO, "--add-label", l], { allowFail: true });
  }
};
const postComment = (n, body, dir) => {
  if (flag("--dry-run") || flag("--no-publish")) { writeFileSync(join(dir, "comment.md"), body); return RUN?.log?.(`  dry run — comment → ${join(dir, "comment.md")}`); }
  const file = join(dir, "comment.md");
  writeFileSync(file, body);
  gh(["issue", "comment", String(n), "-R", REPO, "--body-file", file]);
};

// When the run read the issue: the snapshot job's time in CI (trusted), never later than now. A comment
// written after it is still unanswered.
const readAt = (fallback) => {
  const read = Date.parse(process.env.ISSUE_AGENT_BRIEF_ASOF || fallback);
  return new Date(Number.isFinite(read) ? Math.min(read, Date.now()) : Date.now()).toISOString();
};

function securityStopNotice(n, dir) {
  postComment(n, issueComment({ kind: "security-stop" }), dir);
  relabel(n, { add: [LABELS.needsHuman], remove: [LABELS.working, LABELS.awaiting, LABELS.approved] });
  setStatus(n, "stopped — this looks like a security problem in code people use today; it is handled privately, not here");
  return { n, status: "security-stop" };
}

// The live-discussion link (README, "Talking it through"): a Claude Code routine the maintainer set up,
// fired with the issue and the brief's version; it answers with the session's URL. Optional, and never
// fatal — without it the brief says "reply here".
async function fireDiscuss(n, v) {
  const routine = process.env.ISSUE_AGENT_DISCUSS_ROUTINE, token = process.env.ISSUE_AGENT_DISCUSS_TOKEN;
  if (!routine || !token || flag("--dry-run") || flag("--no-publish")) return undefined;
  try {
    if (!/^trig_[A-Za-z0-9]+$/.test(routine)) throw new Error("ISSUE_AGENT_DISCUSS_ROUTINE is not a routine id (trig_…)");
    const r = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${routine}/fire`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ text: `Repository: ${REPO}\nIssue: https://github.com/${REPO}/issues/${n}\nBrief: version ${v}, the comment on that issue starting with "${BRIEF_MARK} v=${v} " (posted moments after this message).` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const url = (await r.json()).claude_code_session_url;
    if (!/^https:\/\/claude\.ai\/\S+$/.test(String(url))) throw new Error("no session URL in the answer");
    return url;
  } catch (e) {
    console.error(`(no live-discussion link: ${e.message}) — the brief goes up without it`);
    return undefined;
  }
}

async function publishBrief(dir) {
  const trustedN = opt("--issue") ? Number(opt("--issue")) : undefined;
  const outcomeFile = join(dir, "outcome.json");
  if (!existsSync(outcomeFile)) {
    if (trustedN) postComment(trustedN, issueComment({ kind: "error", where: actionsRunUrl() }), dir);
    setStatus(trustedN, "the brief run failed before it wrote anything", { working: false });
    return { n: trustedN, status: "error", reason: "the brief phase produced no outcome" };
  }
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  const n = publishIssueNumber(trustedN, outcome.n);
  RUN ??= { id: outcome.id, dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(join(dir, "publish.log"), s + "\n"); } };
  if (outcome.status === "security-stop") return securityStopNotice(n, dir);
  if (outcome.status === "blocked") {
    postComment(n, issueComment({ kind: "blocked", reason: String(outcome.reason ?? "").slice(0, 2000) }), dir);
    relabel(n, { remove: [LABELS.awaiting] });
    setStatus(n, `not started — not actionable yet: ${outcome.reason}`, { working: false });
    return { n, status: "blocked", reason: outcome.reason };
  }
  const file = join(dir, "brief-result.json");
  if (!existsSync(file)) throw new Error("the brief run left no brief");
  const result = JSON.parse(readFileSync(file, "utf8"));
  if (!result.brief?.card || typeof result.brief.card !== "object" || !Array.isArray(result.brief.acceptance_criteria)) throw new Error("brief-result.json is not a brief");
  const brief = clampBrief(result.brief), base = result.base;
  if (!isCommitId(base)) throw new Error(`not a commit id: ${base}`);
  if (briefOutcome(brief).status === "security-stop") return securityStopNotice(n, dir); // decided here again, never taken from the run
  const asOf = readAt(result.asOf);
  const state = briefState(issueComments(n), trusted);
  if (state.latest && !STARTS_OVER && outcome.revised === false && String(brief.reply ?? "").trim()) {
    postComment(n, replyBody({ v: state.latest.v, reply: brief.reply, asOf }), dir);
    relabel(n, { add: [LABELS.awaiting], remove: [LABELS.working] });
    setStatus(n, `answered your comment — brief v${state.latest.v} stands: approve it, or reply again`, { working: false });
    return { n, status: "replied", v: state.latest.v };
  }
  const v = state.versions + 1;
  const start = STARTS_OVER || !state.latest ? v : state.latest.start ?? 1;
  const lintProblems = [...cardProblems(brief.card, { criteria: brief.acceptance_criteria, behaviorChange: brief.behavior_change }), ...scopeProblems(brief)];
  const discussUrl = await fireDiscuss(n, v);
  postComment(n, briefBody({ v, start, asOf, brief, base, lintProblems, ...(discussUrl ? { discussUrl } : {}) }), dir);
  // Older versions fold away (GitHub's "outdated"), so the thread reads as the latest brief plus the talk.
  if (!flag("--dry-run") && !flag("--no-publish")) {
    for (const c of issueComments(n)) {
      if (!String(c.body).startsWith(`${BRIEF_MARK} v=`) || String(c.body).startsWith(`${BRIEF_MARK} v=${v} `) || !isLoopAuthor(c.author, trusted)) continue;
      sh("gh", ["api", "graphql", "-f", `query=mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}`, "-f", `id=${c.id}`], { allowFail: true });
    }
  }
  relabel(n, { add: [LABELS.awaiting], remove: [LABELS.working, LABELS.approved] });
  // A comment written while this brief was being prepared started no run (the brief wasn't waiting yet).
  const missed = !flag("--dry-run") && !flag("--no-publish") && briefState(issueComments(n), trusted).unanswered;
  setStatus(n, missed
    ? `brief v${v} posted — a comment arrived while it was being written; the agents answer it next (within the hour), and approval waits until they do`
    : `brief v${v} posted — waiting for your approval (\`${LABELS.approved}\`) or your reply`, { working: false });
  return { n, status: "brief", v };
}

// The safety net for a lost comment event: every hour, an issue whose brief waits on a comment the
// agents haven't answered gets a brief run — but not while a run is working on it, and not when a run
// already saw that comment (brief.mjs, sweepWanted).
function sweepBriefs() {
  if (!PAUSE) return [];
  const started = [];
  for (const { number, labels } of ghJson(["issue", "list", "-R", REPO, "--state", "open", "--label", LABELS.awaiting, "--limit", "100", "--json", "number,labels"])) {
    if (labels.some((l) => l.name === LABELS.working)) continue;
    if (!sweepWanted(briefState(issueComments(number), trusted))) continue;
    const r = sh("gh", ["workflow", "run", "issue-agent.yml", "-R", REPO, "-f", `issue=${number}`, "-f", "trigger=comment"], { allowFail: true });
    if (r.code === 0) started.push(number);
    else console.error(`(could not start a brief run for #${number}: ${r.out.trim().split("\n")[0]})`);
  }
  return started;
}

// ── splitting a big issue (trusted; GitHub write access; no agent runs) ───────────────────────────
// README.md, "Splitting a big issue". Approving a split brief opens its tickets as sub-issues, in an
// order where each comes after its blockers, and labels the ones nothing blocks: each is then built
// like an approved brief. Everything is re-read and re-checked here from the issue's own comments —
// approval, the brief's seal, the plan's shape — never taken from a run. A retry finds the tickets it
// already opened (by their markers) and opens only the rest.
const subIssues = (n) => {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){subIssues(first:50){nodes{id number state stateReason body author{login __typename} labels(first:30){nodes{name}}}}}}}`;
  return ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`]).data.repository.issue.subIssues.nodes
    .map((i) => {
      const ours = isLoopAuthor(i.author, trusted);
      // `head`: which plan it is a ticket of, edited or not; `ticket`: what to build, only while sealed.
      return { ...i, labels: i.labels.nodes.map((l) => l.name), head: ours ? ticketHeader(i.body) : undefined, ticket: ours ? parseTicket(i.body) : undefined };
    });
};
const DRY = () => flag("--dry-run") || flag("--no-publish");

function publishSplit(n, dir) {
  RUN ??= { id: "split", dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(join(dir, "publish.log"), s + "\n"); } };
  mkdirSync(dir, { recursive: true });
  const state = briefState(issueComments(n), trusted);
  const refusal = approvalRefusal(state);
  if (refusal || !isSplit(state.latest?.brief)) throw new Error(`not opening tickets for #${n}: ${refusal ?? "the latest brief is not a split"}`);
  const { v, brief } = state.latest;
  const problems = scopeProblems(brief);
  if (problems.length) {
    const reason = `the approved plan doesn't hold together (${problems.join("; ")}) — reply on the brief so the agents post a version that does, then approve that one`;
    postComment(n, issueComment({ kind: "blocked", reason }), dir);
    relabel(n, { add: [LABELS.awaiting], remove: [LABELS.working] });
    setStatus(n, `not split — ${reason}`, { working: false });
    return { n, status: "blocked", reason };
  }
  const existing = DRY() ? [] : subIssues(n);
  const opened = new Map(existing.filter((i) => i.head?.parent === n && i.head.v === v).map((i) => [i.head.id, i]));
  const numbers = new Map([...opened].map(([id, i]) => [id, i.number]));
  for (const t of ticketOrder(brief.scope.tickets)) {
    if (numbers.has(t.id)) continue;
    const blockedBy = (t.blocked_by ?? []).map((b) => numbers.get(b));
    const body = ticketBody({ parent: n, v, id: t.id, spec: ticketSpec(brief, t), blockedBy });
    const title = `${t.title} (#${n}, ${t.id})`;
    if (DRY()) {
      writeFileSync(join(dir, `ticket-${t.id}.md`), `# ${title}\n\n${body}`);
      numbers.set(t.id, 100000 + numbers.size); // a stand-in, so later tickets can name it
      RUN.log(`  dry run — ticket ${t.id} → ${join(dir, `ticket-${t.id}.md`)}`);
      continue;
    }
    const file = join(dir, `ticket-${t.id}.md`);
    writeFileSync(file, body);
    const url = gh(["issue", "create", "-R", REPO, "--title", title, "--body-file", file]).trim();
    const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
    if (!number) throw new Error(`gh issue create gave no issue number: ${url}`);
    const id = ghJson(["api", `repos/${REPO}/issues/${number}`]).id;
    // The plan's tickets are found only as sub-issues (a retry, unblock, pr-scope): an unlinked one would
    // be opened again on retry and never unblock what waits on it. So the link must hold, or the ticket goes.
    let link;
    for (let i = 0; i < 3 && link?.code !== 0; i++) link = sh("gh", ["api", "-X", "POST", `repos/${REPO}/issues/${n}/sub_issues`, "-F", `sub_issue_id=${id}`], { allowFail: true });
    if (link.code !== 0) {
      sh("gh", ["issue", "close", String(number), "-R", REPO, "--reason", "not planned", "--comment", `Could not link this ticket to #${n}; closed so a retry opens it cleanly.`], { allowFail: true });
      throw new Error(`could not link ticket ${t.id} (#${number}) to #${n} as a sub-issue — closed it; re-run publish-split to retry:\n${link.out.slice(-1000)}`);
    }
    numbers.set(t.id, number);
    RUN.log(`  ticket ${t.id} → #${number}`);
  }
  const tickets = ticketOrder(brief.scope.tickets);
  const start = tickets.filter((t) => !(t.blocked_by ?? []).length).map((t) => numbers.get(t.id));
  if (!DRY()) {
    sh("gh", ["label", "create", "epic", "-R", REPO, "--color", "3E4B9E", "--description", "A plan of several tickets (sub-issues)"], { allowFail: true });
    for (const t of start) sh("gh", ["issue", "edit", String(t), "-R", REPO, "--add-label", TRIGGER_LABEL], { allowFail: true });
    sh("gh", ["issue", "edit", String(n), "-R", REPO, "--add-label", "epic"], { allowFail: true });
  }
  relabel(n, { remove: [LABELS.working, LABELS.awaiting, LABELS.approved, TRIGGER_LABEL] });
  postComment(n, `${"<!-- issue-agent -->"}\n🤖 **The approved plan (brief v${v}) is now ${tickets.length} tickets.** Each is built and reviewed as its own pull request; a ticket starts on its own once everything blocking it is closed.\n\n${tickets.map((t, i) => `${i + 1}. #${numbers.get(t.id)} — ${t.title}${(t.blocked_by ?? []).length ? ` _(after ${t.blocked_by.map((b) => `#${numbers.get(b)}`).join(", ")})_` : " _(starting now)_"}`).join("\n")}\n\nThis issue is labelled \`epic\`: the agents won't build it as a whole.`, dir);
  setStatus(n, `split into ${tickets.length} tickets — ${start.map((s) => `#${s}`).join(", ")} started; the rest follow as their blockers close`, { working: false });
  return { n, status: "split", tickets: Object.fromEntries(numbers) };
}

// A ticket closed (its PR merged): start the tickets it was blocking whose other blockers are closed
// too, and say so on the plan's issue when the last one is done.
function unblock(n, dir) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){body author{login __typename}}}}`;
  const closed = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`]).data.repository.issue;
  // Edited or not: a ticket edited by hand still blocks what the plan put after it (scope.mjs, ticketHeader).
  const head = isLoopAuthor(closed.author, trusted) ? ticketHeader(closed.body) : undefined;
  if (!head) return { n, status: "skipped", reason: "not a ticket of an approved plan" };
  const parent = head.parent;
  const { plan: siblings, start: next, open: left, dropped } = planProgress(subIssues(parent), head, TRIGGER_LABEL);
  if (!DRY()) for (const t of next) sh("gh", ["issue", "edit", String(t.number), "-R", REPO, "--add-label", TRIGGER_LABEL], { allowFail: true });
  if (!left.length) {
    mkdirSync(dir, { recursive: true });
    postComment(parent, `${"<!-- issue-agent -->"}\n🤖 **Every ticket of the approved plan is closed** (${siblings.map((t) => `#${t.number}`).join(", ")}).${dropped.length ? ` ${dropped.map((t) => `#${t.number}`).join(", ")} ${dropped.length > 1 ? "were" : "was"} closed without being completed, so the plan isn't fully delivered.` : ""} Check the plan's after-merge criteria, then close this issue.`, dir);
  }
  return { n, status: "unblocked", started: next.map((t) => t.number), open: left.length };
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
// (trusted). Only ⛔ (and threads people with write access opened) gets a fix cycle; after its push the
// loop adds review:again to ask for one re-review. ✅ hands the PR to a human as ready, the bot's
// optional notes listed; a second ⛔ hands it over as needing a human — as does any stop (cycle cap,
// budget, a change it may not publish), saying why.

// Start a review-loop run for a PR by hand (workflow_dispatch). With the workflow's own token —
// GitHub lets a dispatch made with it start a run — passed as ISSUE_AGENT_DISPATCH_TOKEN.
function dispatchReviewLoop(pr) {
  if (flag("--dry-run")) return RUN?.log?.(`  dry run — would start a review-loop run for PR #${pr}`);
  const token = process.env.ISSUE_AGENT_DISPATCH_TOKEN || process.env.GH_TOKEN;
  const r = sh("gh", ["workflow", "run", "issue-agent-review.yml", "-R", REPO, "-f", `pr=${pr}`], { allowFail: true, env: { ...process.env, GH_TOKEN: token } });
  if (r.code !== 0) console.error(`(could not start a review-loop run for #${pr}: ${r.out.split("\n")[0]})`);
}

// After main moves: every PR still in the loop that now conflicts with main gets a conflict cycle
// (GitHub runs no review on a conflicting PR, so without this it would wait forever).
function sweepConflicts() {
  const prs = ghJson(["pr", "list", "-R", REPO, "--state", "open", "--label", LABELS.inReview, "--limit", "50", "--json", "number,headRefName"]);
  const started = [];
  for (const { number } of prs) {
    const pr = loadPrSettled(number);
    console.log(`  #${number}: ${pr.mergeable}`);
    if (pr.mergeable === "CONFLICTING" && !loopRefusalFor(pr)) {
      dispatchReviewLoop(number);
      setStatus(agentBranch(pr.headRefName)?.issue, `main moved and ${pr.url} now conflicts with it — the agent is resolving that`, { working: true });
      started.push(number);
    }
  }
  return started;
}

// loopRefusal (checks.mjs) for a loaded PR. It asks GitHub who has write access (`trusted`) only for a
// PR that is NOT off an issue-agent branch: its author, and whoever added agent:in-review.
const loopRefusalFor = (pr) => loopRefusal({
  ...pr, labels: pr.labels.nodes.map((l) => l.name), author: pr.author?.login, labelledBy: labelledBy(pr.timelineItems.nodes), isTrusted: trusted,
});

// The request a PR off any other branch carries in place of an issue: its own title and description
// as its write-access author wrote them (loopRefusal refuses the PR otherwise), minus what the loop
// itself wrote into the description (requestBody). Read afresh each cycle, not frozen at the label.
const prRequest = (pr) => ({
  number: pr.number, url: pr.url, title: pr.title, author: pr.author?.login, comments: [], dropped: [], fromPr: true,
  body: `(This pull request has no issue: its description is the request.)\n\n${requestBody(pr.body)}`,
});

function loadPr(number) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
    number url state isDraft isCrossRepository mergeable headRefName headRefOid body title author{login} labels(first:30){nodes{name}}
    timelineItems(itemTypes:[LABELED_EVENT], last:50){nodes{... on LabeledEvent{label{name} actor{login}}}}
    commits(last:1){nodes{commit{oid committedDate parents{totalCount}}}}
    comments(last:100){nodes{author{__typename login} body createdAt}}
    reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{databaseId author{__typename login} body createdAt}}}}}}}`;
  return ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${number}`]).data.repository.pullRequest;
}

// GitHub computes `mergeable` lazily: right after a push to the PR or to main it says UNKNOWN for a
// few seconds. Ask again until it knows (or give up and treat it as not conflicting).
function loadPrSettled(number, { tries = 8, waitMs = 5_000 } = {}) {
  let pr = loadPr(number);
  for (let i = 1; i < tries && pr.mergeable === "UNKNOWN"; i++) {
    spawnSync("sleep", [String(waitMs / 1000)]);
    pr = loadPr(number);
  }
  return pr;
}

function assessReview(prNumber) {
  const pr = loadPrSettled(prNumber);
  // `left`: the PR is out of the loop for good (closed, merged, or a person took it over) — the
  // issue's agent:working label has to come off; a merely stale review leaves it alone.
  const skip = (reason, left = false) => ({ pr: pr.number, url: pr.url, issueNumber: agentBranch(pr.headRefName)?.issue, decision: { action: "skip", reason, left } });
  const labels = pr.labels.nodes.map((l) => l.name);
  const refusal = loopRefusalFor(pr);
  if (refusal) return skip(refusal, leftLoop({ ...pr, labels })); // tested in checks.mjs
  const expected = process.env.ISSUE_AGENT_HEAD_SHA;
  if (expected && expected !== pr.headRefOid) return skip("the PR has moved on since this review ran");
  const branch = agentBranch(pr.headRefName);
  // Who gets the hand-over: whoever labelled the issue — or, for a PR with no issue, whoever added
  // agent:in-review (loopRefusal checked they have write access).
  const labeller = branch ? pr.body.match(/<!-- issue-agent labeller=([A-Za-z0-9-]+) -->/)?.[1] : labelledBy(pr.timelineItems.nodes);
  const head = pr.commits.nodes[0].commit;
  const summaries = pr.comments.nodes.filter((c) => isReviewBot(c.author) && c.body.startsWith("## Claude review"));
  const conclusion = process.env.ISSUE_AGENT_REVIEW_CONCLUSION || undefined;
  const { verdict, summary, reused } = latestVerdict({ summaries, headAt: head.committedDate, headIsMerge: head.parents.totalCount > 1, conclusion });
  if (reused) RUN?.log?.("  the head only merges main in; the last review still applies");
  const { answer, notes, ignored } = threadsToAnswer(pr.reviewThreads.nodes.map((t) => ({ ...t, comments: t.comments.nodes })), trusted);
  const cycle = cyclesDone(pr.comments.nodes, trusted);
  // One decision, every rule in it (tested in checks.mjs) — including "no token: hand over, spend
  // nothing", "conflicts with main: resolve it", and "done: verify the criteria first". `open`
  // counts only trusted people's threads: the bot's notes never start a fix cycle.
  const decision = reviewDecision({
    verdict, open: answer.length, cycle, maxCycles: MAX_REVIEW_CYCLES, conclusion, loopOn: REVIEW_LOOP,
    conflicting: pr.mergeable === "CONFLICTING", verified: verifiedFor(pr.comments.nodes, pr.headRefOid, trusted),
  });
  const issue = !branch ? prRequest(pr)
    : snapshotIssue(branch.issue).issue ?? { number: branch.issue, title: `Issue #${branch.issue}`, body: "", comments: [], dropped: [] };
  return {
    pr: pr.number, url: pr.url, headRef: pr.headRefName, head: pr.headRefOid, isDraft: pr.isDraft, issueNumber: branch?.issue, issue,
    verdict, summary: summary.slice(0, 30_000), threads: answer, notes, ignored, cycle, maxCycles: MAX_REVIEW_CYCLES, decision,
    labeller, body: pr.body, criteria: parseCriteria(requestBody(pr.body)), // never a checklist line the loop wrote
  };
}

// Hand the PR to a human: ready (every review resolved) or needs-human (the loop stopped).
function handOver(review, kind, reason) {
  ensureLabels();
  const url = review.url;
  if (kind === "ready" && review.isDraft) sh("gh", ["pr", "ready", url, "-R", REPO], { allowFail: true });
  sh("gh", ["pr", "edit", url, "-R", REPO, "--remove-label", LABELS.inReview, "--add-label", kind === "ready" ? LABELS.ready : LABELS.needsHuman], { allowFail: true });
  const current = loadPr(review.pr);
  // GitHub won't request a review from a PR's own author (the token's owner, when it opened the PR);
  // the @-mention below reaches them either way.
  if (review.labeller && review.labeller !== current.author?.login) sh("gh", ["pr", "edit", url, "-R", REPO, "--add-reviewer", review.labeller], { allowFail: true });
  // Drop the "still working" banner from the CURRENT body (push may have just written a description update).
  const currentBody = current.body;
  const body = currentBody.replace(/^> \[!NOTE\]\n> \*\*The agent is still working on this[^\n]*\n\n/, "");
  if (body !== currentBody) sh("gh", ["pr", "edit", url, "-R", REPO, "--body", body], { allowFail: true });
  const who = review.labeller ? `@${review.labeller} ` : "";
  reason = String(reason).charAt(0).toUpperCase() + String(reason).slice(1); // it follows a full stop
  // Open threads as links (tested in report.mjs): the bot's optional notes listed as no action needed.
  const notes = review.notes ?? [];
  gh(["pr", "comment", url, "-R", REPO, "--body", handOverComment({ kind, who, reason, cycle: review.cycle, threads: review.threads ?? [], notes, url })]);
  setStatus(review.issueNumber ?? agentBranch(current.headRefName)?.issue,
    kind === "ready" ? `ready for your review: ${url}${review.threads?.length ? ` (${review.threads.length} thread(s) left open)` : ""}${notes.length ? ` (${notes.length} optional note(s), no action needed)` : ""}` : `stopped — needs a human: ${reason} (${url})`,
    { working: false });
  RUN?.log?.(`  handed over (${kind}): ${reason}`);
  return { pr: review.pr, status: kind === "ready" ? "ready-for-human" : "needs-human", reason };
}

async function fixReview(review, { dir } = {}) {
  const roles = (await import("./roles.mjs")).forRepo(CONFIG);
  RUN = newRun(review.issueNumber ?? `pr-${review.pr}`, dir);
  RUN.log(`\n━━ PR #${review.pr} review cycle ${review.cycle + 1}/${review.maxCycles} · ${review.threads.length} thread(s) · verdict ${review.verdict} · ${RUN.dir}`);
  const outcome = (o) => { writeFileSync(join(RUN.dir, "outcome.json"), JSON.stringify({ pr: review.pr, id: RUN.id, head: review.head, ...o }, null, 2)); return { pr: review.pr, dir: RUN.dir, ...o }; };
  const repoDir = join(RUN.dir, "repo");
  git(["fetch", "--quiet", "origin", review.head]);
  checkout(repoDir, review.head);
  let mode = review.decision.action === "verify" ? "verify" : review.decision.conflict ? "conflict" : "review";
  const asSpec = (summary, criteria) => ({ actionable: true, summary, acceptance_criteria: criteria, behavior_change: true, touches_ui: false, evidence_plan: "test proof", test_plan: "as asked" });
  let head = review.head, mergedMain, resolved = [], firstPrompt, schema = roles.IMPLEMENT_SCHEMA, spec, diffBase, verification;

  // Bring main in. A clean merge is committed here and re-done by the push job; a conflicting one is
  // left in the working tree (markers and all) for the agent to resolve — the push job then rebuilds
  // the same merge from the resolved files the run hands over.
  // The baseline ("failures that aren't yours") is the PR head as it stands — measured before any
  // merge, never on a half-merged tree that still holds conflict markers.
  const baseline = baselineFor(repoDir, head, "PR head");
  RUN.log(`  baseline (PR head ${head.slice(0, 7)}): ${baseline.map((b) => `${b.name} ${b.green ? "green" : `RED (${b.fingerprints.length})`}`).join(" · ")}`);
  const mainSha = git(["rev-parse", "origin/main"], { cwd: repoDir }).out.trim();
  const forkPoint = git(["merge-base", "origin/main", head], { cwd: repoDir }).out.trim();
  const shared = sharedChanges(filesBetween(repoDir, forkPoint, mainSha), filesBetween(repoDir, forkPoint, head));
  if (mode === "conflict" || shared.length) {
    const m = startMerge(repoDir, head, mainSha);
    mergedMain = mainSha;
    if (m.clean) {
      head = git(["rev-parse", "HEAD"], { cwd: repoDir }).out.trim();
      RUN.log(`  merged main ${mainSha.slice(0, 7)} cleanly`);
    } else {
      resolved = m.conflicted;
      const forbidden = forbiddenPaths(resolved);
      if (m.failed || forbidden.length) {
        restorePatch(repoDir, head, "");
        return outcome({ status: "needs-human", reason: forbidden.length ? `merging main conflicts in ${forbidden.join(", ")}, which the agent never changes` : "merging main failed without conflicts to resolve" });
      }
      RUN.log(`  merging main ${mainSha.slice(0, 7)} conflicts in ${resolved.join(", ")} — the agent resolves them`);
      // A conflict found while answering a review or checking criteria: resolve it first, telling the
      // agent so (the review threads and criteria come back on the next cycle).
      if (mode !== "conflict") {
        // ...but never a cycle past the cap: there, a conflict goes to a human (tested in checks.mjs).
        if (conflictMidCycle(review) === "give-up") {
          restorePatch(repoDir, head, "");
          return outcome({ status: "needs-human", reason: `the PR conflicts with main (in ${resolved.join(", ")}) and ${review.maxCycles} review cycles are done` });
        }
        RUN.log(`  (this ${mode} cycle becomes a conflict cycle)`); mode = "conflict";
      }
    }
    if (CONFIG.install) code(CONFIG.install[0], CONFIG.install.slice(1), { cwd: repoDir, allowFail: true });
    build(repoDir);
  }
  const mainBase = git(["merge-base", "origin/main", resolved.length ? mainSha : head], { cwd: repoDir }).out.trim();

  const whose = review.issueNumber ? `issue #${review.issueNumber}'s` : `PR #${review.pr}'s`; // a PR with no issue: its own checklist
  if (mode === "verify") {
    // Check the issue's own acceptance criteria (the checklist publish wrote) on the final code.
    const criteria = review.criteria ?? [];
    if (!criteria.length) {
      writeFileSync(join(RUN.dir, "fix.patch"), "");
      writeFileSync(join(RUN.dir, "verify.json"), JSON.stringify({ criteria: [], note: "no acceptance-criteria checklist in the PR description" }, null, 2));
      return outcome({ status: "verified", patchSha256: createHash("sha256").update("").digest("hex"), note: "no acceptance-criteria checklist in the PR description" });
    }
    const vspec = asSpec(`Verify ${whose} acceptance criteria on PR #${review.pr}'s final code.`, criteria.map((c) => ({ id: c.id, text: c.text, verified_by: "review" })));
    const { out } = await agent("review-verify", roles.reviewPrompt("spec", review.issue, vspec, mainBase) + reviewDiff(repoDir, mainBase),
      { cwd: repoDir, schema: roles.REVIEW_SCHEMA, check: true, maxTurns: 80 });
    verification = criteria.map((c) => out.criteria?.find((v) => v.id === c.id) ?? { id: c.id, met: false, evidence: "the spec reviewer gave no verdict for it" });
    writeFileSync(join(RUN.dir, "verify.json"), JSON.stringify({ criteria: verification, findings: out.findings }, null, 2));
    const next = afterVerification({ verdicts: verification, cycle: review.cycle, maxCycles: review.maxCycles }); // tested in checks.mjs
    const unmet = verification.filter((v) => !v.met);
    RUN.log(`  criteria: ${verification.length - unmet.length}/${verification.length} met → ${next.action}`);
    if (next.action !== "fix") {
      writeFileSync(join(RUN.dir, "fix.patch"), "");
      return outcome({ status: next.action === "verified" ? "verified" : "needs-human", reason: next.reason, patchSha256: createHash("sha256").update("").digest("hex") });
    }
    // Some aren't: make them true, through the same gates and reviews.
    spec = asSpec(`Make ${whose} unmet acceptance criteria true.`, unmet.map((v) => ({ id: v.id, text: `${criteria.find((c) => c.id === v.id).text} (not met yet: ${v.evidence})`, verified_by: "review" })));
    firstPrompt = roles.implementPrompt(review.issue, spec);
    diffBase = head;
  } else if (mode === "conflict" && resolved.length) {
    spec = asSpec(`Resolve the conflicts with main in PR #${review.pr}, keeping both sides' intent.`, [
      { id: "C1", text: `No conflict markers remain in ${resolved.join(", ")}, and each keeps both main's change and this PR's`, verified_by: "review" },
      { id: "C2", text: "Nothing outside the conflicted hunks changes unless a gate requires it", verified_by: "review" },
    ]);
    firstPrompt = roles.conflictPrompt(review.issue, resolved, mainSha);
    diffBase = mainSha; // reviewers see the PR's whole change on top of main — where the resolution lives
  } else {
    // The "spec" for this round: ⛔'s "Fix before merging" items and the threads people with write
    // access opened — never the bot's optional notes (tested in checks.mjs).
    const criteria = reviewFixCriteria({ verdict: review.verdict, threads: review.threads, conflict: mode === "conflict" });
    spec = asSpec(`Answer the Claude review of PR #${review.pr} (${review.verdict}).`, criteria);
    firstPrompt = roles.reviewFixPrompt(review.issue, review);
    schema = roles.REVIEW_FIX_SCHEMA;
    diffBase = head;
  }
  spec.behavior_change = changedSince(repoDir, mainBase).some((f) => isMutableSource(f, CONFIG));

  const { rounds, impl, reviewedPatch, stopped } = await iterate({
    issue: review.issue, spec, roles, repoDir, baseline, diffBase, mutationBase: mainBase, firstPrompt, schema,
  });
  const last = rounds.at(-1);
  // What the root `npm test` ran on (the reviewed patch, against this round's diff base), and the
  // tree it makes: the push job proves it rebuilt exactly this tree, whatever base its patch uses.
  const tested = reviewedPatch ?? (last ? diffPatch(repoDir, diffBase) : "");
  const tree = last?.clean ? treeOf(repoDir) : undefined;
  let patch = tested, deleted = [];
  if (resolved.length && last?.clean) {
    // Hand over the resolution: the resolved files, plus the rest of the change as a patch on top of
    // the merge commit they make — exactly what the push job rebuilds.
    const leftover = resolved.filter((f) => hasMarkers(join(repoDir, f)));
    if (leftover.length) return outcome({ status: "needs-human", reason: `conflict markers remain in ${leftover.join(", ")}` });
    const merge = buildResolvedMerge({ repo: REPO_ROOT, scratch: join(RUN.dir, "merge-build"), head: review.head, mainSha, conflicted: resolved, resolvedFrom: repoDir, keepDir: join(RUN.dir, "resolved") });
    deleted = merge.deleted;
    patch = diffPatch(repoDir, merge.sha);
  }
  writeFileSync(join(RUN.dir, "fix.patch"), patch);
  const final = last?.impl ?? impl ?? {};
  writeFileSync(join(RUN.dir, "fix.json"), JSON.stringify({
    mode, rounds, last, models: RUN.models, responses: final.responses ?? [], summary: final.summary ?? "", summary_items: final.summary_items ?? [],
    description_update: final.description_update ?? "", open_questions: final.open_questions ?? [], costUsd: RUN.costUsd, verification,
  }, null, 2));
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");
  return outcome({
    status: last?.clean ? "ready" : "needs-human", reason: stopped ?? (last?.clean ? undefined : "the fix did not pass the pipeline's own checks and reviews"),
    patchSha256: sha256(patch), testedPatchSha256: sha256(tested), tree, mergedMain, resolved, deleted,
  });
}

// Trusted: review.json is from the assess job; the run directory is from the agents' job (untrusted).
function pushReview(dir, review) {
  const prN = Number(opt("--pr"));
  if (prN && prN !== review.pr) throw new Error(`review.json is for PR ${review.pr}, this run is for PR ${prN}`);
  RUN ??= { id: "push", dir, costUsd: 0, log: console.log };
  const pr = loadPr(review.pr);
  if (pr.headRefOid !== review.head) return { pr: review.pr, status: "skipped", reason: "the PR moved on while the fix was being made" };
  if (pr.headRefName !== review.headRef) throw new Error(`unexpected PR branch ${pr.headRefName}`);
  const refusal = loopRefusalFor(pr);
  if (refusal) return { pr: review.pr, status: "skipped", reason: refusal }; // re-checked here: push holds the write token
  if (!REVIEW_LOOP) return handOver(review, "needs-human", "the review loop needs an AGENT_GH_TOKEN secret: a fix pushed with the default token would never be reviewed again");
  const outcomeFile = join(dir, "outcome.json");
  if (!existsSync(outcomeFile)) return handOver(review, "needs-human", `the fix job produced nothing${actionsRunUrl() ? ` (logs: ${actionsRunUrl()})` : ""}`);
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8"));
  if (outcome.pr !== review.pr || outcome.head !== review.head) throw new Error("the fix run is for a different PR or head");
  // The criteria check — only when the trusted decision asked for one — written into the checklist
  // whatever its result (only the trusted checklist's ids are touched).
  const verifyFile = join(dir, "verify.json");
  const checklist = review.criteria ?? [];
  const verdicts = existsSync(verifyFile) ? (JSON.parse(readFileSync(verifyFile, "utf8")).criteria ?? []).filter((v) => checklist.some((c) => c.id === v.id)) : [];
  if (review.decision.action === "verify" && verdicts.length) {
    sh("gh", ["pr", "edit", review.url, "-R", REPO, "--body", tickCriteria(loadPr(review.pr).body, verdicts, md)], { allowFail: true });
  }
  if (outcome.status === "verified") {
    // Believed only if verification was asked for and every criterion is met (tested in checks.mjs).
    if (!acceptVerified({ decision: review.decision.action, checklist, verdicts })) {
      return handOver(review, "needs-human", "the fix job reported the criteria verified, but that wasn't asked for or not every criterion is met");
    }
    gh(["pr", "comment", review.url, "-R", REPO, "--body", `<!-- issue-agent-verified sha=${review.head} -->\n✔️ **Acceptance criteria checked on the final code (${review.head.slice(0, 7)}):** ${checklist.length ? `all ${checklist.length} met — the checklist in the description is ticked with the evidence.` : "this PR's description has no acceptance-criteria checklist, so there was nothing to check."}`]);
    const then = review.decision.then ?? { reason: "the review is satisfied" };
    return handOver(review, "ready", checklist.length ? `${then.reason}, and the issue's acceptance criteria are met` : `${then.reason} (no acceptance-criteria checklist to check)`);
  }
  if (outcome.status !== "ready") return handOver(review, "needs-human", outcome.reason ?? "the fix did not pass the pipeline's own checks");
  const patch = readFileSync(join(dir, "fix.patch"), "utf8");
  const fix = JSON.parse(readFileSync(join(dir, "fix.json"), "utf8"));
  if (createHash("sha256").update(patch).digest("hex") !== outcome.patchSha256) throw new Error("fix.patch does not match the checked patch");
  const k = review.cycle + 1;
  // "ready" implies a root `npm test` passed on what was tested; the tree check below proves what we
  // push is exactly that, whatever base the hand-over patch was taken from.
  const untested = rootTestRefusal(fix.last, outcome.testedPatchSha256 ?? outcome.patchSha256, TEST);
  if (untested) return handOver(review, "needs-human", untested);
  const resolved = outcome.resolved ?? [];

  let sha;
  if (patch.trim() || outcome.mergedMain) {
    const email = process.env.GIT_COMMITTER_EMAIL || git(["config", "user.email"], { allowFail: true }).out.trim();
    if (!email) throw new Error("no git identity to sign off with");
    const wt = join(dir, "push");
    if (existsSync(wt)) git(["worktree", "remove", "--force", wt], { allowFail: true });
    git(["fetch", "--quiet", "origin", review.head]);
    git(["worktree", "add", "--quiet", "--detach", wt, review.head]);
    if (outcome.mergedMain) {
      // The patch was made on top of a merge of exactly this main commit: check it really is on main.
      if (!isCommitId(outcome.mergedMain)) throw new Error(`not a commit id: ${outcome.mergedMain}`);
      git(["fetch", "--quiet", "origin", "main"]);
      if (git(["merge-base", "--is-ancestor", outcome.mergedMain, "FETCH_HEAD"], { allowFail: true }).code !== 0) throw new Error(`${outcome.mergedMain} is not a commit on main`);
    }
    // Rebuild — main merged in (clean, or the replayed resolution), the patch applied — and push only
    // if it is byte-for-byte the tree the fix job tested (merges.mjs, tested end to end).
    const rebuilt = rebuildForPush({
      wt, mainSha: outcome.mergedMain, resolved, resolvedDir: join(dir, "resolved"), deleted: outcome.deleted ?? [], patch, expectedTree: outcome.tree,
      mergeMessage: `Merge main into ${review.headRef}${resolved.length ? `, resolving conflicts in ${resolved.join(", ")}` : ""}`,
      fixMessage: `Address review, cycle ${k}: ${String(fix.summary).split("\n")[0].slice(0, 120)}\n\n${fix.summary}\n\nCo-Authored-By: ${modelName(MODEL)} <noreply@anthropic.com>`,
    });
    if (!rebuilt.ok) { git(["worktree", "remove", "--force", wt], { allowFail: true }); return handOver(review, "needs-human", rebuilt.why); }
    sha = rebuilt.sha;
    if (flag("--dry-run")) { RUN.log(`  dry run — would push ${sha} to ${review.headRef}`); git(["worktree", "remove", "--force", wt], { allowFail: true }); return { pr: review.pr, status: "dry-run", sha }; }
    git([...GH_CREDENTIALS, "push", "--quiet", "origin", `HEAD:refs/heads/${review.headRef}`], { cwd: wt }); // fast-forward only: no force
    // If main moved while the fix was being made, the new head may already conflict — and then GitHub
    // runs no review on it and the loop would stall. Test it against the latest main; if it conflicts,
    // start a conflict cycle now instead of waiting for a review that won't come.
    git(["fetch", "--quiet", "origin", "main"], { cwd: wt });
    if (git(["merge-tree", "--write-tree", "--quiet", "FETCH_HEAD", "HEAD"], { cwd: wt, allowFail: true }).code === 1) {
      RUN.log("  the new head conflicts with the latest main — starting a conflict cycle");
      dispatchReviewLoop(review.pr);
    }
    git(["worktree", "remove", "--force", wt], { allowFail: true });
    // Ask for one re-review (tested in checks.mjs), with this job's token. Until the review starts on
    // this label instead of on a push, the label does nothing and the push still starts the review.
    for (const call of reReviewCalls({ sha, url: review.url, repo: REPO })) sh("gh", call, { allowFail: true });
  }

  // Reply to each trusted person's thread with the agent's answer, and to each bot note it fixed;
  // resolve the answered ones. A bot note it declined gets nothing (tested in checks.mjs).
  const byId = new Map(fix.responses.map((r) => [r.thread_id, r]));
  let answered = 0;
  for (const r of threadReplies({ threads: review.threads, notes: review.notes ?? [], responses: fix.responses, sha, cycle: k, conflict: fix.mode === "conflict", escape: md })) {
    sh("gh", ["api", `repos/${REPO}/pulls/${review.pr}/comments/${r.root}/replies`, "-f", `body=${r.body}`], { allowFail: true });
    if (r.resolve) { gh(["api", "graphql", "-f", `query=mutation{resolveReviewThread(input:{threadId:"${r.thread}"}){thread{isResolved}}}`]); answered++; }
  }
  // The agent can't edit the PR description; this trusted job writes its corrections into it, as
  // one "Updated after review" section that each cycle replaces (escaped like all agent text).
  const update = String(fix.description_update ?? fix.last?.impl?.description_update ?? "").trim().replace(/^#{1,6} [^\n]*\n+/, ""); // our heading, not the agent's
  if (update) {
    const section = updateSection(k, update, md); // agent text can't open or close a comment (checks.mjs)
    const current = loadPr(review.pr).body;
    const body = /<!-- issue-agent-update -->[\s\S]*?<!-- \/issue-agent-update -->/.test(current)
      ? current.replace(/<!-- issue-agent-update -->[\s\S]*?<!-- \/issue-agent-update -->/, () => section) // a function: `$&` in agent text stays literal
      : /(^|\r?\n)## In plain terms\r?\n/.test(current)
        ? current.replace(/(^|\r?\n)(## In plain terms\r?\n)/, (_, before, heading) => `${before}${section}\n\n${heading}`)
        : `${current.trimEnd()}\n\n${section}\n`; // no template heading to sit above: append it
    if (body !== current) sh("gh", ["pr", "edit", review.url, "-R", REPO, "--body", body], { allowFail: true });
  }
  const declined = fix.responses.filter((r) => r.action === "declined" && review.threads.some((t) => t.id === r.thread_id)).length;
  fix.summary_items = fix.summary_items?.length ? fix.summary_items : fix.last?.impl?.summary_items ?? [];
  gh(["pr", "comment", review.url, "-R", REPO, "--body",
    `${REVIEW_MARK} cycle=${k} sha=${sha ?? "none"} -->\n🔁 **Review cycle ${k}/${review.maxCycles}:** ${sha ? `pushed ${sha.slice(0, 7)}` : "no code change"}${outcome.mergedMain ? ` (with main ${outcome.mergedMain.slice(0, 7)} merged in${resolved.length ? `, conflicts in ${resolved.length} file(s) resolved by the agent` : ""})` : ""}${fix.mode === "verify" ? ` · made ${md(verdicts.filter((v) => !v.met).map((v) => v.id).join(", "))} true (acceptance criteria that weren't met yet)` : ""}${fix.mode === "conflict" ? " · review threads are left for the next cycle" : ` · ${answered} thread(s) answered and resolved`}${declined ? ` (${declined} declined with a reason)` : ""}${(fix.summary_items ?? []).length ? ` · summary items: ${md(fix.summary_items.join("; "))}` : ""}.${sha ? ` Asked for one re-review (\`review:again\`).` : ""}`]);
  // No push means no new review would ever come: hand over now rather than wait forever.
  if (!sha) return handOver({ ...review, cycle: k, threads: review.threads.filter((t) => !byId.has(t.id)) }, "needs-human", "the agent answered the review without changing code, so no new review will run");
  setStatus(review.issueNumber, `review cycle ${k}/${review.maxCycles}: pushed ${sha.slice(0, 7)} to ${review.url} — waiting for the next Claude review`, { working: true });
  return { pr: review.pr, status: "pushed", sha };
}

// ══ main ══════════════════════════════════════════════════════════════════════════════════════════
const [mode, arg] = argv;
if (mode === "snapshot") {
  // CI phase 1. Exit 0 either way; `skip` in the output tells the workflow to stop.
  const n = Number(arg);
  const { issue, skip, quiet, phase, unlabel } = snapshotIssue(n, process.env.ISSUE_AGENT_SNAPSHOT_AT || undefined);
  // A ticket waiting on its blockers: without the label, `unblock` (scope.mjs, frontier) can start it later.
  if (skip && unlabel && flag("--comment")) sh("gh", ["issue", "edit", String(n), "-R", REPO, "--remove-label", TRIGGER_LABEL], { allowFail: true });
  writeFileSync(resolve(opt("--out", "issue.json")), JSON.stringify({ issue, skip, phase }, null, 2));
  console.log(skip ? `skip #${n}: ${skip}` : `snapshot #${n} (${TRIGGER} → ${phase}): ${issue.comments.length} trusted comment(s)${issue.conversation?.length ? `, ${issue.conversation.length} in the talk about the brief` : ""}${issue.dropped.length ? `; left out: ${issue.dropped.join("; ")}` : ""}`);
  // Refusing `agent:approved` is its own kind of notice: that run never read the comments, so it must
  // not stop the hourly check from answering one that waits (brief.mjs, sweepWanted).
  if (skip && !quiet && flag("--comment")) gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: TRIGGER === `label:${LABEL_APPROVED}` ? "refused" : "skipped", reason: skip })]);
  if (!skip && flag("--comment")) {
    if (phase === "split") {
      sh("gh", ["issue", "edit", String(n), "-R", REPO, "--remove-label", LABELS.awaiting], { allowFail: true });
      setStatus(n, `opening the ${issue.brief.brief.scope.tickets.length} tickets of the approved plan (brief v${issue.brief.v}) as sub-issues`, { working: true });
    } else if (phase === "brief") setStatus(n, issue.previousBrief ? "reading your comment — an answer or a new version of the brief comes next (usually 5–15 min)" : "reproducing the problem and writing a brief for you to approve (usually 10–20 min) — nothing is built before you approve it", { working: true });
    else {
      if (issue.brief) sh("gh", ["issue", "edit", String(n), "-R", REPO, "--remove-label", LABELS.awaiting], { allowFail: true });
      setStatus(n, issue.brief?.ticket ? `building ticket ${issue.brief.ticket.id} of the plan approved on #${issue.brief.ticket.parent} — implementation, checks and three internal reviews (usually 10–40 min); the PR comes next`
        : issue.brief ? `building the approved brief v${issue.brief.v} — implementation, checks and three internal reviews (usually 10–40 min); the PR comes next` : "working on it — spec, implementation, checks and three internal reviews (usually 10–40 min); the PR comes next", { working: true });
    }
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip ? "true" : "false"}\nphase=${phase ?? ""}\nasof=${issue?.snapshotAt ?? ""}\n`);
} else if (mode === "implement") {
  // CI phase 2. No GitHub calls; the run directory is the hand-off to `publish`.
  const { issue, skip } = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (skip) { console.log(`skip: ${skip}`); process.exit(0); }
  mkdirSync(RUNS_HOME, { recursive: true });
  const o = await implementIssue(issue, { dir: opt("--dir") && resolve(opt("--dir")) });
  console.log(`\n━━ #${o.n} ${o.status}${o.reason ? ` — ${o.reason}` : ""} · ${o.dir}`);
} else if (mode === "brief") {
  // CI phase 2 with briefs on: reproduce and write the brief. No GitHub calls.
  const { issue, skip } = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (skip) { console.log(`skip: ${skip}`); process.exit(0); }
  mkdirSync(RUNS_HOME, { recursive: true });
  // A failure's message can carry the agent's own text (agent(): "did not finish: …\n<its answer>"),
  // and this console is public: the error goes to run.log, which a failed brief run never uploads.
  const o = await briefIssue(issue, { dir: opt("--dir") && resolve(opt("--dir")) }).catch((e) => {
    if (RUN?.dir) appendFileSync(join(RUN.dir, "run.log"), `${e?.stack ?? e}\n`);
    console.error(`the brief run failed: ${briefFailure(e)} — the details are in run.log, not here`);
    process.exit(1);
  });
  console.log(`\n━━ #${o.n} ${o.status === "security-stop" ? "stopped (nothing is said here about why)" : o.status}`);
} else if (mode === "publish-brief") {
  try {
    const o = await publishBrief(resolve(arg));
    console.log(`\n━━ #${o.n} ${o.status}${o.v ? ` v${o.v}` : ""}`);
  } catch (e) {
    console.error(e);
    const n = Number(opt("--issue"));
    if (n && !flag("--dry-run")) sh("gh", ["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "error", where: actionsRunUrl() })], { allowFail: true });
    setStatus(n, "the run failed while posting the brief", { working: false });
    process.exitCode = 1;
  }
} else if (mode === "publish-split") {
  // Approving a split brief (scope.mjs): open its tickets. Trusted; no agent runs.
  const n = Number(opt("--issue") ?? arg);
  try {
    const o = publishSplit(n, resolve(opt("--dir", join(RUNS_HOME, `split-${n}`))));
    console.log(`\n━━ #${o.n} ${o.status}${o.tickets ? ` ${JSON.stringify(o.tickets)}` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
  } catch (e) {
    console.error(e);
    if (n && !flag("--dry-run")) sh("gh", ["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "error", where: actionsRunUrl() })], { allowFail: true });
    setStatus(n, "the run failed while opening the plan's tickets", { working: false });
    process.exitCode = 1;
  }
} else if (mode === "unblock") {
  // A ticket closed: start the tickets it was blocking (scope.mjs, frontier).
  const o = unblock(Number(arg), resolve(opt("--dir", join(RUNS_HOME, `unblock-${arg}`))));
  console.log(`#${o.n} ${o.status}${o.started ? ` — started ${o.started.map((x) => `#${x}`).join(", ") || "nothing"}; ${o.open} open` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
} else if (mode === "sweep-briefs") {
  const started = sweepBriefs();
  console.log(started.length ? `started brief runs for ${started.map((n) => `#${n}`).join(", ")}` : "no brief waits on an unanswered comment");
} else if (mode === "publish") {
  // CI phase 3 (also `run.mjs publish <dir>` after a local --no-publish run). Any failure still
  // tells the issue, so a run never ends silently.
  try {
    const o = publishRun(resolve(arg));
    console.log(`\n━━ #${o.n} ${o.status}${o.pr ? ` ${o.pr}` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
  } catch (e) {
    console.error(e);
    const n = Number(opt("--issue"));
    if (n && !flag("--dry-run")) sh("gh", ["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "error", reason: e.hint, where: actionsRunUrl() })], { allowFail: true });
    setStatus(n, e.hint ? `stopped before the PR — ${e.hint}` : "the run failed while publishing", { working: false });
    process.exitCode = 1;
  }
} else if (mode === "assess-review") {
  // Review loop, phase 1 (trusted): what does the latest review ask for — and is the PR done?
  const review = assessReview(Number(arg));
  writeFileSync(resolve(opt("--out", "review.json")), JSON.stringify(review, null, 2));
  const { action, reason } = review.decision;
  console.log(`PR #${review.pr}: ${action} — ${reason}${review.threads ? ` · ${review.threads.length} thread(s) to answer${review.ignored?.length ? `, ignored: ${review.ignored.join("; ")}` : ""}` : ""}`);
  if (!flag("--dry-run")) {
    if (action === "skip" && review.decision.left) setStatus(review.issueNumber, `the agent stopped working on ${review.url}: ${reason}`, { working: false });
    if (action === "fix") setStatus(review.issueNumber, review.decision.conflict
      ? `review cycle ${review.cycle + 1}/${review.maxCycles}: ${review.url} conflicts with main — merging main in and resolving the conflicts`
      : `review cycle ${review.cycle + 1}/${review.maxCycles}: ${review.verdict === "changes" ? `the review says ⛔ Needs changes — fixing what blocks${review.threads.length ? `, and answering ${review.threads.length} thread(s) from people with write access` : ""}` : `answering ${review.threads.length} thread(s) from people with write access`} on ${review.url}`, { working: true });
    if (action === "verify") setStatus(review.issueNumber, `the review is satisfied — checking the issue's acceptance criteria on the final code of ${review.url}`, { working: true });
    if (action === "done") handOver(review, "ready", reason);
    if (action === "give-up") handOver(review, "needs-human", reason);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `decision=${action}\n`);
} else if (mode === "fix-review") {
  // Review loop, phase 2: agents answer the review. No GitHub calls.
  const review = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (!["fix", "verify"].includes(review.decision?.action)) { console.log(`nothing to fix: ${review.decision?.reason}`); process.exit(0); }
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
} else if (mode === "sweep-conflicts") {
  // After a push to main: give every PR in the loop that now conflicts a conflict cycle.
  const started = sweepConflicts();
  console.log(started.length ? `started conflict cycles for ${started.map((n) => `#${n}`).join(", ")}` : "no agent PR in the loop conflicts with main");
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
    console.error("usage: run.mjs <issue>… | --poll  [--no-publish] [--force] [--repo owner/name] [--runs dir]\n       run.mjs snapshot <n> --out f | implement <f> | publish <run-dir> | publish-evidence <run-dir>\n       run.mjs brief <f> | publish-brief <run-dir> | sweep-briefs   (briefs: config \"brief\": \"pause\")\n       run.mjs publish-split <n> | unblock <n>   (a split brief's tickets: scope.mjs)");
    process.exit(flag("--poll") ? 0 : 2);
  }
  mkdirSync(RUNS_HOME, { recursive: true });
  const outcomes = [];
  for (const n of numbers) {
    try {
      const { issue, skip, phase } = snapshotIssue(n);
      // --poll sees every `agent` issue: one whose brief already waits on you isn't briefed again.
      if (!skip && phase === "brief" && STARTS_OVER && flag("--poll") && issue.labels.includes(LABELS.awaiting)) { outcomes.push({ n, status: "skipped", reason: "its brief is waiting for approval" }); continue; }
      if (skip) { console.log(`\n━━ #${n} skipped — ${skip}`); outcomes.push({ n, status: "skipped", reason: skip }); continue; }
      if (phase === "split") { outcomes.push(publishSplit(n, join(RUNS_HOME, `split-${n}`))); continue; }
      if (phase === "brief") {
        setStatus(n, "writing a brief (run locally) — nothing is built before you approve it", { working: true });
        const o = await briefIssue(issue);
        outcomes.push(flag("--no-publish") ? o : { ...o, ...(await publishBrief(o.dir)) });
        continue;
      }
      setStatus(n, "working on it (run locally) — spec, implementation, checks and internal reviews", { working: true });
      const o = await implementIssue(issue);
      outcomes.push(flag("--no-publish") ? o : { ...o, ...publishRun(o.dir) });
    } catch (e) {
      console.error(e);
      outcomes.push({ n, status: "error", reason: e.message.split("\n")[0], dir: RUN?.dir });
      setStatus(n, "the run failed (run locally — the details are in that run's console and run.log)", { working: false }); // not the raw error: it can carry local paths
    }
  }
  console.log("\n━━ outcomes");
  for (const o of outcomes) console.log(`  #${o.n} ${o.status}${o.pr ? ` ${o.pr}` : ""}${o.reason ? ` — ${o.reason}` : ""}${o.report ? `\n     report: ${o.report}` : ""}`);
  writeFileSync(join(RUNS_HOME, "last-outcomes.json"), JSON.stringify(outcomes, null, 2));
  process.exitCode = outcomes.some((o) => o.status === "error") ? 1 : 0;
}
