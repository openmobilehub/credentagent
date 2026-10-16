#!/usr/bin/env node
// Issue agent — turns a GitHub issue into a reviewed, evidenced draft pull request, unattended.
//
//   node ci/issue-agent/run.mjs 286                 # one issue
//   node ci/issue-agent/run.mjs --poll              # every open issue labelled `agent` that has no PR yet
//   node ci/issue-agent/run.mjs 286 --no-publish    # do everything locally, push nothing
//
// One way in (label an issue `agent`, or name it here), one way out (a draft PR + a comment on the
// issue). In between, separate Claude agents (Agent SDK) play separate roles, and THIS SCRIPT checks
// their work instead of believing it:
//
//   preflight  issue open? not needs-decision/epic? no open PR already fixing it?
//   spec       an agent reads the issue + code → acceptance criteria (or "not actionable" → comment, stop)
//   implement  an agent writes the failing test first, then the fix
//   gates      this script runs build, typecheck, lint, root `npm test` — red → back to implement
//   mutation   this script reverts the source change and re-runs the new tests: they must FAIL
//              (CLAUDE.md: "a test that would still pass with the control removed is not a useful test")
//   review     three agents in parallel — spec / security / DX lenses — blocking findings → back to implement
//   evidence   an agent records before/after screenshots + video in a real browser (UI changes), and
//              this script always records a test-proof page (the new tests failing on main, passing on the fix)
//   publish    one signed-off commit, a branch, a draft PR with the report, a comment on the issue
//
// Auth: the Agent SDK uses whatever Claude Code would — locally your Claude Code login; in CI the
// workflow exports CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (CLAUDE_AUTH=api).
// No agent ever sees a GitHub token: only this script pushes.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEC_SCHEMA, specPrompt, IMPLEMENT_SCHEMA, implementPrompt, fixPrompt,
  REVIEW_SCHEMA, reviewPrompt, EVIDENCE_SCHEMA, evidencePrompt,
} from "./roles.mjs";
import { renderHtml } from "./capture.mjs";
import { fingerprints, stripAnsi } from "./fingerprints.mjs";
import { proofHtml, reportHtml, prBody, issueComment } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const MODEL = process.env.ISSUE_AGENT_MODEL ?? "claude-opus-5-5";
const MAX_ROUNDS = Number(process.env.ISSUE_AGENT_MAX_ROUNDS ?? 3);
const TRIGGER_LABEL = process.env.ISSUE_AGENT_LABEL ?? "agent";
const BLOCKING_LABELS = ["needs-decision", "epic", "wontfix", "duplicate", "question"];
const EVIDENCE_BRANCH = "agent-evidence";

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const PUBLISH = !flag("--no-publish");
const FORCE = flag("--force");
const RUNS_HOME = resolve(opt("--runs", process.env.ISSUE_AGENT_HOME ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "credentagent-issue-agent")));
const REPO = opt("--repo", process.env.GITHUB_REPOSITORY ?? ghRepoFromRemote());
const [OWNER, NAME] = REPO.split("/");

// ── shell helpers ────────────────────────────────────────────────────────────────────────────────
function sh(cmd, args, { cwd = REPO_ROOT, allowFail = false, env, input, timeout = 20 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (cwd ${cwd}) exited ${r.status}:\n${out.slice(-4000)}`);
  return { code: r.status ?? 1, out };
}
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

// Agents never get a GitHub credential: strip every token from the environment they inherit.
const AGENT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|AGENT_GH_TOKEN|ACTIONS_.*TOKEN.*)$/.test(k)),
);

// ── the agent call ───────────────────────────────────────────────────────────────────────────────
const READ_TOOLS = ["Read", "Grep", "Glob"];
const READ_BASH = ["Bash(git diff *)", "Bash(git diff)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)", "Bash(git status)", "Bash(ls *)", "Bash(grep *)", "Bash(sed -n *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(cat *)", "Bash(npx vitest *)", "Bash(npm test *)", "Bash(npm test)", "Bash(npm run build*)", "Bash(npm run typecheck*)", "Bash(npm run lint*)"];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(mkdir *)"];
const NEVER = ["Bash(git push *)", "Bash(git commit *)", "Bash(git reset *)", "Bash(git checkout *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "WebFetch", "WebSearch"];

let RUN; // set per issue: { dir, log(), costUsd }

async function agent(role, prompt, { cwd, schema, write = false, extraAllowed = [], resume, maxTurns = 120, additionalDirectories } = {}) {
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
      allowedTools: [...READ_TOOLS, ...READ_BASH, ...(write ? WRITE_TOOLS : []), ...extraAllowed],
      disallowedTools: NEVER,
      permissionMode: "dontAsk", // anything not allowed is denied — nobody is there to answer a prompt
      outputFormat: { type: "json_schema", schema },
      additionalDirectories,
      maxTurns,
      ...(process.env.ANTHROPIC_API_KEY ? { maxBudgetUsd: Number(process.env.ISSUE_AGENT_BUDGET_USD ?? 25) } : {}),
    },
  })) {
    appendFileSync(transcript, JSON.stringify(msg) + "\n");
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "assistant") {
      for (const b of msg.message.content ?? []) {
        if (b.type === "tool_use") RUN.log(`   ${role} · ${b.name} ${summarizeInput(b.input)}`);
      }
    }
    if (msg.type === "result") {
      cost = msg.total_cost_usd ?? 0;
      result = msg.result;
      structured = msg.structured_output;
      if (msg.subtype !== "success") error = `${msg.subtype}${msg.errors ? `: ${msg.errors.join("; ")}` : ""}`;
    }
  }
  RUN.costUsd += cost;
  if (error || structured == null) throw new Error(`${role} agent did not finish: ${error ?? "no structured output"}\n${result ?? ""}`);
  RUN.log(`✓ ${role} ($${cost.toFixed(2)})`);
  writeFileSync(join(RUN.dir, `${role}.json`), JSON.stringify(structured, null, 2));
  return { out: structured, sessionId };
}
function summarizeInput(i = {}) {
  const s = i.command ?? i.file_path ?? i.pattern ?? i.path ?? "";
  return String(s).replace(/\s+/g, " ").slice(0, 110);
}

// ── preflight ────────────────────────────────────────────────────────────────────────────────────
function loadIssue(n) {
  const i = ghJson(["issue", "view", String(n), "-R", REPO, "--json", "number,title,body,labels,state,url,comments,author"]);
  return {
    number: i.number, title: i.title, body: i.body ?? "", url: i.url, state: i.state, author: i.author?.login,
    labels: i.labels.map((l) => l.name),
    comments: i.comments.filter((c) => !c.body.includes("<!-- issue-agent -->")).map((c) => ({ author: c.author?.login, body: c.body })),
  };
}

function openPrsFor(n) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number url state}}}}}`;
  const linked = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${OWNER}`, "-f", `r=${NAME}`, "-F", `n=${n}`])
    .data.repository.issue.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  const mention = new RegExp(`#${n}(?!\\d)`);
  const titled = ghJson(["pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json", "number,url,title,headRefName"])
    .filter((p) => mention.test(p.title) || p.headRefName.startsWith(`agent/issue-${n}-`));
  const all = new Map([...linked, ...titled].map((p) => [p.number, p]));
  return [...all.values()];
}

function preflight(issue) {
  if (issue.state !== "OPEN") return `issue is ${issue.state.toLowerCase()}`;
  const blocking = issue.labels.filter((l) => BLOCKING_LABELS.includes(l));
  if (blocking.length) return `labelled ${blocking.join(", ")} — a maintainer has to act first`;
  const prs = openPrsFor(issue.number);
  if (prs.length) return `already has an open pull request: ${prs.map((p) => `#${p.number}`).join(", ")}`;
  return null;
}

// ── workspace ────────────────────────────────────────────────────────────────────────────────────
function checkout(dir, ref, branch) {
  sh("git", ["fetch", "--quiet", "origin", "main"]);
  if (existsSync(dir)) sh("git", ["worktree", "remove", "--force", dir], { allowFail: true });
  sh("git", ["worktree", "add", "--quiet", ...(branch ? ["-b", branch] : ["--detach"]), dir, ref]);
  RUN.log(`  checkout ${ref} → ${dir}`);
  sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir });
  sh("npm", ["run", "build"], { cwd: dir, allowFail: true }); // a red main is measured by the baseline, not fatal here
}

// ── gates (this script runs them; an agent's claim that they pass is never taken) ────────────────
//
// Each failure is reduced to a fingerprint — lint "file line:col rule", TypeScript "file(l,c): TSnnnn",
// vitest "FAIL file > test" — with the checkout path stripped. The baseline is main's fingerprints
// before any change: a gate passes when it is green, OR when everything it reports was already red on
// main (so a red main never gets charged to the agent, and the agent is told to leave it alone).
const GATES = [["build", ["run", "build"]], ["typecheck", ["run", "typecheck"]], ["lint", ["run", "lint"]], ["test", ["test"]]];

function runGates(dir, { baseline, stopOnFail = true } = {}) {
  const results = [];
  for (const [name, args] of GATES) {
    const r = sh("npm", args, { cwd: dir, allowFail: true });
    const summary = name === "test" ? (r.out.match(/Tests\s+.+/g) ?? []).pop()?.trim() : undefined;
    const fps = r.code === 0 ? [] : fingerprints(name, r.out, dir);
    const base = baseline?.find((b) => b.name === name);
    const preexisting = r.code !== 0 && base && !base.green && fps.length > 0 && fps.every((f) => base.fingerprints.includes(f));
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
    ? `\n\nNOTE — main is already red before your change. These failures are NOT yours: do not fix them, do not touch their files unless the issue requires it (the pipeline ignores exactly these):\n${red.map((b) => `- ${b.name}: ${b.fingerprints.join("; ") || "(failed with no parsable detail)"}`).join("\n")}`
    : "";
};

// The new/changed tests must fail on main's source and pass on the fix. Revert every changed
// non-test source file to the base, run only the changed test files, then put the fix back.
function mutationCheck(dir, base, spec) {
  if (!spec.behavior_change) return { applicable: false, reason: "spec marks this a docs-only / no-behavior change" };
  const changed = sh("git", ["diff", "--name-status", base], { cwd: dir }).out.trim().split("\n").filter(Boolean)
    .map((l) => l.split("\t")).map(([s, f]) => ({ status: s[0], file: f }));
  const isTest = (f) => /\.test\.(ts|tsx|mjs|js)$/.test(f);
  const tests = changed.filter((c) => isTest(c.file) && c.status !== "D").map((c) => c.file);
  const src = changed.filter((c) => !isTest(c.file) && /^(packages|examples)\//.test(c.file) && !/\.md$/.test(c.file));
  if (!tests.length) return { applicable: true, ok: false, reason: "behavior changed but no test file was added or changed" };
  if (!src.length) return { applicable: true, ok: false, reason: "tests changed but no source file did — nothing to revert" };

  // Park the fix in a throwaway local commit (not the stash — that stack is shared by every worktree),
  // revert the source files, test, then restore the commit's tree and un-commit it.
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", ["-c", "user.name=issue-agent", "-c", "user.email=issue-agent@localhost", "commit", "--quiet", "--no-verify", "-m", "issue-agent: parked fix"], { cwd: dir });
  let without, withFix;
  try {
    for (const c of src) {
      if (c.status === "A") rmSync(join(dir, c.file), { force: true });
      else sh("git", ["checkout", base, "--", c.file], { cwd: dir });
    }
    sh("npm", ["run", "build"], { cwd: dir, allowFail: true });
    without = sh("npx", ["vitest", "run", "--retry=0", ...tests], { cwd: dir, allowFail: true });
  } finally {
    sh("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: dir });
    sh("git", ["reset", "--quiet", base], { cwd: dir }); // back to an uncommitted change on the branch
    sh("npm", ["run", "build"], { cwd: dir });
  }
  withFix = sh("npx", ["vitest", "run", "--retry=0", ...tests], { cwd: dir, allowFail: true });
  const ok = without.code !== 0 && withFix.code === 0;
  RUN.log(`  mutation: new tests ${without.code !== 0 ? "FAIL" : "PASS"} without the fix, ${withFix.code === 0 ? "pass" : "FAIL"} with it → ${ok ? "ok" : "NOT OK"}`);
  return {
    applicable: true, ok, tests, reverted: src.map((c) => c.file),
    withoutFix: { code: without.code, tail: tail(stripAnsi(without.out), 70) },
    withFix: { code: withFix.code, tail: tail(stripAnsi(withFix.out), 30) },
    reason: ok ? undefined : without.code === 0 ? "the new tests still PASS with the fix reverted — they don't guard it" : "the new tests fail WITH the fix",
  };
}

// What the pipeline itself measured, handed to the reviewers so they judge it instead of guessing —
// e.g. "the new test fails without the control" is a fact here, not something to reason about.
function pipelineFacts(r, baseline) {
  const m = r.mutation;
  return `\n\n<pipeline_facts>
These were measured by the pipeline (not claimed by the implementer):
- Gates from the repo root: ${r.gates.map((g) => `${g.name} ${g.green ? "green" : g.preexisting ? "red only with main's pre-existing failures" : "RED"}${g.summary ? ` (${g.summary})` : ""}`).join("; ")}.
- Main before the change: ${baseline.map((b) => `${b.name} ${b.green ? "green" : `red: ${b.fingerprints.join("; ")}`}`).join("; ")}. Pre-existing failures are not this change's to fix; a diff that "fixes" them unasked is out of scope.
- Mutation check: ${m.applicable ? `with ${(m.reverted ?? []).join(", ")} reverted to main, the changed tests (${(m.tests ?? []).join(", ")}) ${m.withoutFix.code ? "FAILED" : "PASSED"}; with the change they ${m.withFix.code === 0 ? "pass" : "FAIL"}. Output without the change:\n${m.withoutFix.tail.split("\n").slice(-40).join("\n")}` : `not applicable — ${m.reason}`}
</pipeline_facts>`;
}

// ── one issue, end to end ────────────────────────────────────────────────────────────────────────
async function runIssue(n) {
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
  const dir = join(RUNS_HOME, `issue-${n}-${id}`);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "run.log");
  RUN = { id, dir, costUsd: 0, log: (s) => { console.log(s); appendFileSync(logFile, s + "\n"); } };
  RUN.log(`\n━━ issue #${n} · run ${id} · ${dir}`);

  const issue = loadIssue(n);
  const skip = FORCE ? null : preflight(issue);
  if (skip) {
    RUN.log(`  skip: ${skip}`);
    return { n, status: "skipped", reason: skip };
  }

  const repoDir = join(dir, "repo");
  const branch = `agent/issue-${n}-${id}`;
  checkout(repoDir, "origin/main", branch);
  const base = sh("git", ["rev-parse", "HEAD"], { cwd: repoDir }).out.trim();
  const baseline = runGates(repoDir, { stopOnFail: false });
  RUN.log(`  baseline (main ${base.slice(0, 7)}): ${baseline.map((b) => `${b.name} ${b.green ? "green" : `RED (${b.fingerprints.length})`}`).join(" · ")}`);

  // spec
  const { out: spec } = await agent("spec", specPrompt(issue), { cwd: repoDir, schema: SPEC_SCHEMA, maxTurns: 60 });
  if (!spec.actionable) {
    RUN.log(`  not actionable: ${spec.blocker}`);
    if (PUBLISH) gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: "blocked", spec, run: RUN })]);
    return { n, status: "blocked", reason: spec.blocker, dir };
  }

  // implement → [gates → mutation, fixed in place up to MAX_FIXES times] → review, until clean or out
  // of rounds. Mechanical failures (build, lint, a test that doesn't guard its fix) are fixed inside
  // a round, so review rounds are spent on what only a reviewer can catch.
  const MAX_FIXES = Number(process.env.ISSUE_AGENT_MAX_FIXES ?? 3);
  let impl, session, rounds = [], feedback;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    RUN.log(`── round ${round}/${MAX_ROUNDS}`);
    let r;
    for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
      const first = round === 1 && attempt === 0;
      ({ out: impl, sessionId: session } = await agent(`implement-r${round}${attempt ? `-fix${attempt}` : ""}`,
        first ? implementPrompt(issue, spec) + baselineNote(baseline) : fixPrompt(feedback) + baselineNote(baseline),
        { cwd: repoDir, schema: IMPLEMENT_SCHEMA, write: true, resume: first ? undefined : session, maxTurns: 200 }));

      const g = runGates(repoDir, { baseline });
      r = { round, attempt, gates: g, impl };
      const bad = g.find((x) => !x.ok);
      if (bad) {
        const fresh = bad.fingerprints.filter((f) => !(baseline.find((b) => b.name === bad.name)?.fingerprints ?? []).includes(f));
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

    const lenses = ["spec", "security", "dx"];
    const facts = pipelineFacts(r, baseline);
    const reviews = await Promise.all(lenses.map((l) =>
      agent(`review-${l}-r${round}`, reviewPrompt(l, issue, spec, base) + facts, { cwd: repoDir, schema: REVIEW_SCHEMA, maxTurns: 80 })
        .then(({ out }) => ({ lens: l, ...out }))));
    r.reviews = reviews;
    const blocking = reviews.flatMap((rv) => rv.findings.filter((f) => f.severity === "blocking").map((f) => ({ lens: rv.lens, ...f })));
    const unmet = (reviews.find((rv) => rv.lens === "spec")?.criteria ?? []).filter((c) => !c.met);
    RUN.log(`  review: ${reviews.map((rv) => `${rv.lens}=${rv.verdict}`).join(" ")} · ${blocking.length} blocking · ${unmet.length} unmet criteria`);
    if (!blocking.length && !unmet.length) { r.clean = true; break; }
    feedback = [
      ...unmet.map((c) => `- [spec] ${c.id} is NOT met: ${c.evidence}`),
      ...blocking.map((f) => `- [${f.lens}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.summary}${f.fix ? `\n  fix: ${f.fix}` : ""}`),
    ].join("\n");
  }
  const last = rounds.at(-1);
  const done = Boolean(last.clean);

  // evidence
  const evidenceDir = join(dir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  let evidence;
  if (done && spec.touches_ui) {
    const beforeDir = join(dir, "before");
    checkout(beforeDir, base);
    try {
      ({ out: evidence } = await agent("evidence", evidencePrompt({
        issue, spec, captureModule: join(HERE, "capture.mjs"), beforeDir, afterDir: repoDir, evidenceDir, portBase: 4100 + (n % 50) * 10,
      }), { cwd: evidenceDir, schema: EVIDENCE_SCHEMA, write: true, additionalDirectories: [beforeDir, repoDir], maxTurns: 150 }));
    } catch (e) {
      evidence = { demonstrates: "", captures: [], limitations: `evidence agent failed: ${e.message.slice(0, 500)}` };
      RUN.log(`  evidence agent failed: ${e.message.split("\n")[0]}`);
    }
  }
  await renderHtml({
    outDir: evidenceDir, name: "test-proof", side: "proof",
    html: proofHtml({ issue, spec, last, base }),
    caption: "Test proof: the pipeline's own gate runs, and the new tests failing on main's code and passing on the fix",
  });
  const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
  const report = { issue, spec, rounds, last, done, evidence, manifest, base, branch, model: MODEL, costUsd: RUN.costUsd, id };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(evidenceDir, "index.html"), reportHtml(report, { mediaBase: "" }));
  RUN.log(`  report → ${join(evidenceDir, "index.html")}`);

  if (!PUBLISH) return { n, status: done ? "ready" : "needs-human", dir, report: join(evidenceDir, "index.html") };
  return publishRun(dir);
}

// Publish a finished run: one signed-off commit, the branch, the evidence, a draft PR, a comment.
// Also reachable on its own (`--publish-run <dir>`) so a local `--no-publish` run can be looked at first.
function publishRun(dir) {
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const { issue, done, branch, id } = report;
  const n = issue.number, impl = report.last.impl;
  const repoDir = join(dir, "repo"), evidenceDir = join(dir, "evidence");
  RUN ??= { id, dir, costUsd: report.costUsd, log: (s) => { console.log(s); appendFileSync(join(dir, "run.log"), s + "\n"); } };
  const commitMsg = `${issue.title} (#${n})\n\n${impl.summary}\n\nFixes #${n}\n\nCo-Authored-By: ${modelName(report.model)} <noreply@anthropic.com>`;
  // Idempotent: a retried publish folds everything back into one commit on top of the run's base.
  sh("git", ["reset", "--soft", "--quiet", report.base], { cwd: repoDir });
  sh("git", ["add", "-A"], { cwd: repoDir });
  sh("git", ["commit", "--quiet", "-s", "-F", "-"], { cwd: repoDir, input: commitMsg });
  sh("git", [...GH_CREDENTIALS, "push", "--quiet", "-u", "origin", branch], { cwd: repoDir });
  const mediaBase = publishEvidence(n, id, evidenceDir, report);
  const bodyFile = join(dir, "pr-body.md");
  writeFileSync(bodyFile, prBody(report, { mediaBase, pagesUrl: `${mediaBase}index.html` }));
  const prUrl = gh(["pr", "create", "-R", REPO, "--draft", "--base", "main", "--head", branch,
    "--title", done ? issue.title : `[needs human] ${issue.title}`, "--body-file", bodyFile], { cwd: repoDir });
  gh(["issue", "comment", String(n), "-R", REPO, "--body", issueComment({ kind: done ? "pr" : "needs-human", prUrl, report, run: RUN })]);
  RUN.log(`  PR → ${prUrl}`);
  return { n, status: done ? "pr-open" : "needs-human", pr: prUrl, dir, report: join(evidenceDir, "index.html") };
}

// Evidence goes on a separate orphan branch so the PR's diff stays code-only; the PR embeds it
// from there (public repo → raw URLs render inline).
function publishEvidence(n, id, evidenceDir, report) {
  const rel = `issue-${n}/${id}`;
  const mediaBase = `https://raw.githubusercontent.com/${REPO}/${EVIDENCE_BRANCH}/${rel}/`;
  const wt = join(RUN.dir, "evidence-branch");
  const has = sh("git", ["ls-remote", "--exit-code", "--heads", "origin", EVIDENCE_BRANCH], { allowFail: true }).code === 0;
  if (has) {
    sh("git", ["fetch", "--quiet", "origin", EVIDENCE_BRANCH]);
    sh("git", ["worktree", "add", "--quiet", "--detach", wt, "FETCH_HEAD"]);
  } else {
    sh("git", ["worktree", "add", "--quiet", "--orphan", "-b", `${EVIDENCE_BRANCH}-${id}`, wt]);
    writeFileSync(join(wt, "README.md"), "Screenshots, videos and reports recorded by the issue agent (ci/issue-agent). Not code — never merge this branch.\n");
  }
  const dest = join(wt, rel);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(evidenceDir)) {
    if (f.startsWith(".video-") || f === "node_modules") continue;
    cpSync(join(evidenceDir, f), join(dest, f), { recursive: true });
  }
  // The published report is read through an HTML preview proxy, so its media need absolute URLs.
  writeFileSync(join(dest, "index.html"), reportHtml(report, { mediaBase }));
  sh("git", ["add", "-A"], { cwd: wt });
  sh("git", ["commit", "--quiet", "-s", "-m", `evidence: issue #${n}, run ${id}`], { cwd: wt });
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = sh("git", [...GH_CREDENTIALS, "push", "--quiet", "origin", `HEAD:refs/heads/${EVIDENCE_BRANCH}`], { cwd: wt, allowFail: true });
    if (p.code === 0) break;
    if (attempt === 2) throw new Error(`could not push ${EVIDENCE_BRANCH}:\n${p.out}`);
    sh("git", [...GH_CREDENTIALS, "pull", "--quiet", "--rebase", "origin", EVIDENCE_BRANCH], { cwd: wt });
  }
  sh("git", ["worktree", "remove", "--force", wt], { allowFail: true });
  return mediaBase;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
if (flag("--publish-evidence")) {
  // Re-publish a run's media + report to agent-evidence (same paths, so the PR's links keep working).
  const dir = resolve(opt("--publish-evidence"));
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  RUN = { id: report.id, dir, costUsd: report.costUsd, log: console.log };
  console.log(publishEvidence(report.issue.number, report.id, join(dir, "evidence"), report));
  process.exit(0);
}
if (flag("--publish-run")) {
  const o = publishRun(resolve(opt("--publish-run")));
  console.log(`\n━━ #${o.n} ${o.status} ${o.pr}`);
  process.exit(0);
}
const numbers =flag("--poll")
  ? ghJson(["issue", "list", "-R", REPO, "--state", "open", "--label", TRIGGER_LABEL, "--limit", "50", "--json", "number"]).map((i) => i.number)
  : argv.filter((a) => /^\d+$/.test(a)).map(Number);
if (!numbers.length) {
  console.error("usage: run.mjs <issue>… | --poll   [--no-publish] [--force] [--repo owner/name] [--runs dir]");
  process.exit(flag("--poll") ? 0 : 2);
}
mkdirSync(RUNS_HOME, { recursive: true });
const outcomes = [];
for (const n of numbers) {
  try {
    outcomes.push(await runIssue(n));
  } catch (e) {
    console.error(e);
    outcomes.push({ n, status: "error", reason: e.message.split("\n")[0], dir: RUN?.dir });
  }
}
console.log("\n━━ outcomes");
for (const o of outcomes) console.log(`  #${o.n} ${o.status}${o.pr ? ` ${o.pr}` : ""}${o.reason ? ` — ${o.reason}` : ""}${o.report ? `\n     report: ${o.report}` : ""}`);
writeFileSync(join(RUNS_HOME, "last-outcomes.json"), JSON.stringify(outcomes, null, 2));
process.exitCode = outcomes.some((o) => o.status === "error") ? 1 : 0;
