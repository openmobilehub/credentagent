// The scope check (CONTRIBUTING.md, "Big changes"; REVIEW.md §8). A pull request too big to review
// in one sitting must show that the work was broken down first: it delivers ONE ticket of a plan — a
// sub-issue of an `epic` issue that has several (the to-tickets skill, or the issue agent's split
// brief), or a task of a spec under specs/ with a tasks.md. A big PR with neither is refused, with a
// comment asking for a smaller one. A maintainer can wave one through with the `scope:approved` label.
//
// Runs on pull_request_target from main's copy: it reads the PR through the API and never checks out
// or runs the PR's code.
//
//   node ci/pr-scope/check.mjs <pr-number>          (GH_TOKEN, GITHUB_REPOSITORY; --dry-run prints)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = { lines: 400, files: 15 };
export const OVERRIDE_LABEL = "scope:approved";
export const MARK = "<!-- pr-scope -->";

// What doesn't count toward size: lockfiles, docs and specs (writing the plan down is the point),
// snapshots, and generated output.
const IGNORED = [/(^|\/)package-lock\.json$/, /(^|\/)(pnpm-lock\.yaml|yarn\.lock)$/, /\.md$/, /^specs\//, /^docs\//, /__snapshots__\//, /\.snap$/, /(^|\/)dist\//];
export const counts = (path) => !IGNORED.some((re) => re.test(path));

/** Issue numbers the PR body says it delivers: closing keywords, and "Part of #N" / "Ticket of #N". */
export function linkedIssues(body) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of|ticket of|implements)\s*:?\s+#(\d+)\b/gi;
  return [...new Set([...text.matchAll(re)].map((m) => Number(m[1])))];
}

/** Spec tasks the PR body names: "specs/016-grant-activity/tasks.md T3" (path, then a task id). */
export function specTasks(body) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /\b(specs\/\d{3}-[\w.-]+)\/tasks\.md\b[^\n]*?\b(T\d{1,3})\b/g;
  return [...text.matchAll(re)].map((m) => ({ dir: m[1], task: m[2] }));
}

/**
 * The verdict, from facts gathered elsewhere (so it is testable without GitHub). `files`:
 * [{ filename, additions, deletions }]. `tickets`: for each linked issue, { number, parent,
 * parentIsEpic, siblings } — `parent` undefined when it isn't a sub-issue. `specs`: for each named
 * spec task, { dir, task, exists } — exists when the dir holds a tasks.md that names the task.
 */
export function assess({ files, labels = [], tickets = [], specs = [] }) {
  const counted = files.filter((f) => counts(f.filename));
  const lines = counted.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const size = { lines, files: counted.length };
  const big = lines > LIMITS.lines || counted.length > LIMITS.files;
  const evidence = [
    ...tickets.filter((t) => t.parent && t.parentIsEpic && t.siblings >= 2).map((t) => `delivers #${t.number}, one of ${t.siblings} tickets of the plan in #${t.parent}`),
    ...specs.filter((s) => s.exists).map((s) => `delivers ${s.task} of ${s.dir}/tasks.md`),
  ];
  if (!big) return { ok: true, big, size, evidence, why: "small enough to review in one sitting" };
  if (labels.includes(OVERRIDE_LABEL)) return { ok: true, big, size, evidence, why: `a maintainer approved its size (\`${OVERRIDE_LABEL}\`)` };
  if (evidence.length) return { ok: true, big, size, evidence, why: "big, but it is one ticket of a plan" };
  const near = [
    ...tickets.filter((t) => !t.parent).map((t) => `#${t.number} is not a sub-issue of a plan`),
    ...tickets.filter((t) => t.parent && !(t.parentIsEpic && t.siblings >= 2)).map((t) => `#${t.number}'s parent #${t.parent} is not an \`epic\` with several tickets`),
    ...specs.filter((s) => !s.exists).map((s) => `${s.dir}/tasks.md has no ${s.task}`),
  ];
  return { ok: false, big, size, evidence, near, why: "big, with no sign the work was broken down first" };
}

/** The comment on the PR: the verdict, and what to do about a refusal. */
export function comment(r) {
  const size = `${r.size.lines} changed lines in ${r.size.files} files (docs, specs and lockfiles not counted; the bar is ${LIMITS.lines} lines or ${LIMITS.files} files)`;
  if (r.ok) return `${MARK}\n✅ **Scope check:** ${r.why}. ${r.big ? `${size}. ${r.evidence.join("; ")}` : ""}`.trim();
  return `${MARK}
⛔ **Scope check: this pull request is too big to review as one piece, and nothing shows it was broken down first.**

It has ${size}. A change this size gets skimmed instead of reviewed, and the decisions inside it — what is stored and where, how the pieces fit — get made in the code with nobody looking.

**What to do** (CONTRIBUTING.md, "Big changes"):

1. Write the plan down first: an issue labelled \`epic\` with the design (the \`to-spec\` and \`codebase-design\` skills in \`.claude/skills/\`), or a \`specs/NNN-name/\` folder with a \`tasks.md\`.
2. Break it into tickets, each a thin slice that works and is checked on its own (the \`to-tickets\` skill): sub-issues of that epic, or tasks T001, T002, … in \`tasks.md\`.
3. Open one pull request per ticket, and say which one it is in the description: \`Fixes #123\` for a sub-issue, or \`specs/016-name/tasks.md T002\` (the spec must already be on \`main\`).

Or ask a maintainer to add \`${OVERRIDE_LABEL}\` if this truly can't be split, with the reason in a comment.${r.near?.length ? `\n\n_Checked and not enough:_ ${r.near.join("; ")}.` : ""}
`;
}

// ── GitHub (only when run as a script) ───────────────────────────────────────────────────────────
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ghJson = (args) => JSON.parse(gh(args));

function ticketFacts(repo, n) {
  const [o, r] = repo.split("/");
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){number parent{number labels(first:30){nodes{name}} subIssues(first:1){totalCount}}}}}`;
  try {
    const i = ghJson(["api", "graphql", "-f", `query=${q}`, "-f", `o=${o}`, "-f", `r=${r}`, "-F", `n=${n}`]).data.repository.issue;
    if (!i) return { number: n };
    return { number: n, parent: i.parent?.number, parentIsEpic: Boolean(i.parent?.labels.nodes.some((l) => l.name === "epic")), siblings: i.parent?.subIssues.totalCount ?? 0 };
  } catch (e) {
    // A PR number, or no such issue: not a ticket. Anything else (auth, rate limit) is a failed check, not a refusal.
    if (/Could not resolve to an Issue/i.test(`${e.stderr ?? ""}${e.message}`)) return { number: n };
    throw e;
  }
}

/** Whether a tasks.md names the task. Ids compare by number: "T2" names T002, as this repo writes them. */
export function hasTask(text, task) {
  const num = Number(String(task).slice(1));
  return [...String(text).matchAll(/\bT(\d{1,4})\b/g)].some((m) => Number(m[1]) === num);
}

function specFacts(root, { dir, task }) {
  const file = join(root, dir, "tasks.md");
  return { dir, task, exists: existsSync(file) && hasTask(readFileSync(file, "utf8"), task) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2]);
  const repo = process.env.GITHUB_REPOSITORY;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // main's checkout
  const pr = ghJson(["pr", "view", String(n), "-R", repo, "--json", "body,labels,isDraft"]);
  const files = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${n}/files?per_page=100`]).flat();
  const r = assess({
    files, labels: pr.labels.map((l) => l.name),
    tickets: linkedIssues(pr.body).map((i) => ticketFacts(repo, i)),
    specs: specTasks(pr.body).map((s) => specFacts(root, s)),
  });
  console.log(`PR #${n}: ${r.ok ? "ok" : "refused"} — ${r.why} (${r.size.lines} lines, ${r.size.files} files)${r.evidence.length ? `; ${r.evidence.join("; ")}` : ""}`);
  const body = comment(r);
  if (process.argv.includes("--dry-run")) console.log(body);
  else {
    // One comment, kept current: edited in place; a passing small PR that was never refused gets none.
    const mine = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${n}/comments?per_page=100`]).flat()
      .find((c) => String(c.body).startsWith(MARK) && c.user?.login === "github-actions[bot]");
    if (mine) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "-f", `body=${body}`]);
    else if (!r.ok || r.big) {
      const file = join(process.env.RUNNER_TEMP ?? ".", "pr-scope-comment.md");
      writeFileSync(file, body);
      gh(["pr", "comment", String(n), "-R", repo, "--body-file", file]);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`, { flag: "a" });
  if (!r.ok) process.exitCode = 1;
}
