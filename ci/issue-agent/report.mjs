// Report builders for the issue agent: the test-proof page (recorded as video), the human report
// (index.html next to the media), the PR body, and the issue comments.
//
// Everything an agent wrote is untrusted text: in HTML it is escaped; in Markdown it goes through
// md(), which neutralizes HTML (an unclosed `<!--` would hide the rest of a PR body) and @mentions.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Outside `code spans` only: inside one, GitHub shows `&lt;` literally — and HTML there is inert anyway.
export const md = (s) => String(s ?? "").split(/(`[^`\n]*`)/).map((part, i) => i % 2
  ? part
  : part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(?=[A-Za-z0-9-])/g, "@​")).join("");
const MARK = "<!-- issue-agent -->", REFUSAL_MARK = "<!-- issue-agent-refusal -->", ERROR_MARK = "<!-- issue-agent-error -->";

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1f2328;--muted:#656d76;--card:#fff;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--card:#161b22;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--code:#0d1117}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12px;line-height:1.45;max-height:420px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}figure{margin:0}figure img,figure video{width:100%;border:1px solid var(--line);border-radius:8px;background:#fff}
figcaption{font-size:13px;color:var(--muted);margin-top:4px}`;

const gateWord = (g) => (g.green ? "pass" : g.ok ? "red on main too — not this change" : "FAIL");
// A `test` entry that isn't the root `npm test` on exactly this patch — only the quick tests ran (a
// round stopped before the root run), or the root run checked an earlier version — never reads as passed.
// A failed one still reads as failed: this only softens a pass.
export const notFullRun = (g, patchSha256) => g.name !== "test" || !g.ok ? ""
  : g.scope === "fast" ? "quick tests only, not the full run"
  : g.patchSha256 && patchSha256 && g.patchSha256 !== patchSha256 ? "ran on an earlier version of this change, not this one" : "";
const specVerdicts = (r) => r.last.reviews?.find((x) => x.lens === "spec")?.criteria ?? [];

// The page the pipeline records as a video for every issue: what it checked, with its own outputs.
export function proofHtml({ issue, spec, last, base, patchSha256 }) {
  const m = last.mutation;
  const gateRows = last.gates.map((g) => `<tr><td>${esc(g.name)}</td>${notFullRun(g, patchSha256) ? `<td class="warn">${esc(notFullRun(g, patchSha256))}</td>` : `<td class="${g.green ? "ok" : g.ok ? "warn" : "bad"}">${gateWord(g)}</td>`}<td>${esc(g.preexisting ? g.fingerprints.join("; ") : g.summary ?? "")}</td></tr>`).join("");
  const crit = last.reviews?.find((r) => r.lens === "spec")?.criteria ?? [];
  const critRows = spec.acceptance_criteria.map((ac) => {
    const c = crit.find((x) => x.id === ac.id);
    return `<tr><td>${esc(ac.id)}</td><td>${esc(ac.text)}</td><td class="${c?.met ? "ok" : "bad"}">${c ? (c.met ? "met" : "NOT met") : "no verdict"}</td><td>${esc(c?.evidence ?? "")}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><main>
<p class="muted">Issue agent · test proof · base ${esc(base.slice(0, 7))}</p>
<h1>#${issue.number} ${esc(issue.title)}</h1>
<h2>Acceptance criteria (checked by the spec reviewer)</h2><div class="card"><table>${critRows}</table></div>
<h2>Gates, run by the pipeline from the repo root</h2><div class="card"><table>${gateRows}</table></div>
${m?.applicable ? `<h2>Changed tests with the fix reverted — <span class="${m.withoutFix?.code ? "ok" : "bad"}">${m.withoutFix?.code ? "they FAIL (good: they guard the fix)" : "they PASS (bad)"}</span></h2>
<p class="muted">Reverted: ${esc((m.reverted ?? []).join(", "))}<br>Ran: ${esc((m.tests ?? []).join(", "))}</p><pre>${esc(m.withoutFix?.tail ?? m.reason ?? "")}</pre>
<h2>Same tests with the fix — <span class="${m.withFix?.code === 0 ? "ok" : "bad"}">${m.withFix?.code === 0 ? "pass" : "FAIL"}</span></h2><pre>${esc(m.withFix?.tail ?? "")}</pre>`
    : `<h2>Test proof</h2><p class="muted">${esc(m?.reason ?? "not run")}</p>`}
</main></body></html>`;
}

function mediaFigures(manifest, mediaBase) {
  const media = manifest.filter((e) => e.kind === "image" || e.kind === "video");
  const group = (side) => media.filter((e) => e.side === side);
  const fig = (e) => e.kind === "video"
    ? `<figure><video controls muted playsinline src="${esc(mediaBase + e.file)}"></video><figcaption>🎬 ${esc(e.caption)}</figcaption></figure>`
    : `<figure><a href="${esc(mediaBase + e.file)}"><img src="${esc(mediaBase + e.file)}" alt="${esc(e.caption)}" loading="lazy"></a><figcaption>${esc(e.caption)}</figcaption></figure>`;
  const dialogs = manifest.filter((e) => e.kind === "events" && e.events.length);
  return ["example", "before", "after", "proof"].map((side) => group(side).length
    ? `<h2>${{ example: "Before and after", proof: "Test proof", before: "Before (main)", after: "After (this change)" }[side]}</h2><div class="grid">${group(side).map(fig).join("")}</div>`
    : "").join("") + (dialogs.length
    ? `<h2>What the browser saw</h2><div class="card"><table>${dialogs.map((d) => `<tr><td>${esc(d.side)} · ${esc(d.session)}</td><td><pre>${esc(JSON.stringify(d.events, null, 1))}</pre></td></tr>`).join("")}</table></div>` : "");
}

export function reportHtml(r, { mediaBase }) {
  const status = r.done ? `<span class="pill ok">ready for human review</span>` : `<span class="pill bad">needs a human${r.stopped ? ` — ${esc(r.stopped)}` : ""}</span>`;
  const reviews = (r.last.reviews ?? []).map((rv) => `<div class="card"><b>${esc(rv.lens)}</b> — <span class="${rv.verdict === "approve" ? "ok" : "bad"}">${esc(rv.verdict)}</span>${rv.findings.length ? `<ul>${rv.findings.map((f) => `<li><span class="${f.severity === "blocking" ? "bad" : "warn"}">${esc(f.severity)}</span> ${esc(f.file ?? "")}${f.line ? `:${f.line}` : ""} ${esc(f.summary)}</li>`).join("")}</ul>` : ` · no findings`}</div>`).join("");
  const history = r.rounds.map((x) => `<tr><td>${x.round}</td><td>${x.gates.map((g) => `${esc(g.name)} ${g.ok ? "✓" : "✗"}`).join(" · ")}</td><td>${x.mutation ? (x.mutation.applicable ? (x.mutation.ok ? "✓" : `✗ ${esc(x.mutation.reason)}`) : "n/a") : "—"}</td><td>${x.reviews ? x.reviews.map((v) => `${esc(v.lens)} ${v.verdict === "approve" ? "✓" : "✗"}`).join(" · ") : "—"}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue #${r.issue.number} report</title><style>${STYLE}</style></head><body><main>
<p class="muted">Issue agent run ${esc(r.id)} · ${esc(r.model)} · ~$${r.costUsd.toFixed(2)} · base ${esc(r.base.slice(0, 7))}</p>
<h1><a href="${esc(r.issue.url)}">#${r.issue.number}</a> ${esc(r.issue.title)}</h1><p>${status}</p>
<div class="card">${esc(r.spec.summary)}</div>
<h2>What changed</h2><div class="card">${esc(r.last.impl.summary)}<p class="muted">Files: ${esc((r.files ?? []).join(", "))}</p></div>
${r.issue.dropped?.length ? `<h2>Left out of the request</h2><div class="card warn">${esc(r.issue.dropped.join("; "))}</div>` : ""}
${r.evidence ? `<h2>What the recordings show</h2><div class="card">${esc(r.evidence.demonstrates)}${r.evidence.limitations ? `<p class="warn">Limits: ${esc(r.evidence.limitations)}</p>` : ""}</div>` : ""}
${mediaFigures(r.manifest, mediaBase)}
<h2>Reviews (final round)</h2>${reviews}
<h2>Rounds</h2><div class="card"><table><tr><th>#</th><th>gates</th><th>test proof</th><th>reviews</th></tr>${history}</table></div>
${(r.last.impl.open_questions ?? []).length ? `<h2>Open questions for a human</h2><ul>${r.last.impl.open_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
</main></body></html>`;
}

// The PR body follows .github/pull_request_template.md: plain terms, what you're approving, how to
// test, then the detail below the divider.
// The gates a round ran, in words: "the build, typecheck, lint and full test suite" here; another repo
// names its own (config.mjs).
const checkedGates = (gates) => {
  const others = gates.filter((x) => x.name !== "test").map((x) => md(x.name));
  return `the ${others.length ? `${others.join(", ")} and ` : ""}full test suite`;
};

// A code block that can't be closed early by the text inside it (agent-written output can hold ```).
const fence = (text, lang = "") => { const t = String(text ?? ""); const n = Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)); return `${"`".repeat(n)}${lang}\n${t}\n${"`".repeat(n)}`; };

// The PR's first section (README, "Before and after"): what a developer sees on main and with the
// change — the example the pipeline ran, or a page's screenshots — before any prose.
function beforeAfter(r, show) {
  const ui = show("before", "❌ Before — main") + show("after", "✅ After — this change");
  if (ui.trim()) return `## Before and after\n\n${ui}`;
  const ex = r.example;
  if (!ex) return "";
  if (ex.notApplicable) return `## Before and after\n\n_No developer-facing change: ${md(ex.notApplicable)}_\n`;
  if (ex.failed) return `## Before and after\n\n_The pipeline couldn't record one: ${md(ex.failed)}_\n`;
  const pic = show("example", "");
  const out = (label, x) => `**${label}** · exit ${Number(x.code)}\n\n${fence(x.out || "(no output)", "text")}`;
  return `## Before and after\n\n**${md(ex.title)}**\n\n${pic ? `${pic}\n` : ""}${fence(ex.code, /^[a-z]{1,12}$/.test(ex.lang) ? ex.lang : "")}\n\n${fence(`$ ${(ex.cmd ?? []).join(" ")}`, "sh")}\n\n${out("❌ Before — main", ex.before)}\n\n${out("✅ After — this change", ex.after)}\n${ex.same ? "\n> [!WARNING]\n> Main and this change printed the same thing: the example doesn't show the difference. Check it by hand.\n" : ""}\n_The pipeline ran this itself, in a clean checkout of main and of this change._\n`;
}

// `commands`: the repo's "How to test" (config.mjs `reproduce`, `focusedTest` with <file>, and
// `build: false` when it has no build step); this repo's own by default. `harnessRepo`: where ci/issue-agent lives, when it isn't the PR's repo.
export function prBody(r, { mediaBase, repo, harnessRepo = repo, commands ={ reproduce: "npm ci && npm run build && npm test", focused: "npx vitest run <file>" } }) {
  const verdicts = specVerdicts(r);
  const acs = r.spec.acceptance_criteria.map((ac) => {
    const c = verdicts.find((x) => x.id === ac.id);
    return `- [${c?.met ? "x" : " "}] **${md(ac.id)}** ${md(ac.text)}${c?.evidence ? ` — _${md(c.evidence)}_` : ""}`;
  }).join("\n");
  // File names come from the evidence agent: only plain media names reach a src/href.
  const media = r.manifest.filter((e) => (e.kind === "image" || e.kind === "video") && /^[A-Za-z0-9._-]+\.(png|webm)$/.test(String(e.file)));
  const show = (side, title) => {
    // The before/after picture is a still: its scroll-through video adds nothing.
    const items = media.filter((e) => e.side === side && !(side === "example" && e.kind === "video"));
    if (!items.length) return "";
    return `${title ? `#### ${title}\n\n` : ""}${items.map((e) => e.kind === "image" ? `<img src="${mediaBase}${e.file}" width="${side === "example" ? 860 : 640}" alt="${esc(e.caption)}">${side === "example" ? "" : `\n\n_${md(e.caption)}_`}` : `🎬 [${md(e.caption)}](${mediaBase}${e.file})`).join("\n\n")}\n`;
  };
  const g = r.last.gates.map((x) => `\`${x.name}\` ${notFullRun(x, r.patchSha256) ? `⚠️ ${notFullRun(x, r.patchSha256)}` : x.green ? "✅" : x.ok ? "⚠️ red on main too, not this change" : "❌"}${x.summary ? ` ${md(x.summary)}` : ""}`).join(" · ");
  const m = r.last.mutation;
  const findings = (sev) => (r.last.reviews ?? []).flatMap((rv) => rv.findings.filter((f) => f.severity === sev).map((f) => `- **${rv.lens}** ${f.file ? `\`${md(f.file)}${f.line ? `:${f.line}` : ""}\` ` : ""}${md(f.summary)}`));
  const blocking = findings("blocking"), suggestions = findings("suggestion");
  const report = `https://htmlpreview.github.io/?${mediaBase.replace("https://raw.githubusercontent.com/", "https://github.com/").replace(/\/agent-evidence\//, "/blob/agent-evidence/")}index.html`;
  const files = (r.files ?? []).map((f) => `\`${String(f).replace(/[`\n]/g, "'")}\``).join(", ");
  return `${MARK}
${r.done ? "" : `> [!WARNING]\n> **Not finished${r.stopped ? `: ${md(r.stopped)}` : ""}.** The open findings are listed below — a human has to take this over.\n\n`}${beforeAfter(r, show)}
## In plain terms

${md(r.spec.summary)}

Fixes #${r.issue.number} — ${md(r.issue.title)}.${r.spec.from_brief ? ` Built from **brief v${r.spec.from_brief}**, which you approved on the issue: its acceptance criteria are the checklist below, word for word.` : ""}

## What you're approving

${md(r.last.impl.summary)}

- **Changes:** ${files || "none"}.
- **Checked by a machine, not by the agent that wrote it:** ${checkedGates(r.last.gates)} (${g}); ${m?.applicable ? (m.ok ? `with the source change undone, the changed tests **fail** — so they guard it (${(m.tests ?? []).map((t) => `\`${t}\``).join(", ")}). That is checked per test file: a reviewer should still confirm each new test case would fail on its own.` : `❌ the test-proof check failed: ${md(m.reason)}.`) : `no test-proof check (${md(m?.reason ?? "not run")}).`}
- **Reviewed by three agents that didn't write it** (spec, security, developer experience): ${(r.last.reviews ?? []).map((v) => `${v.lens} ${v.verdict === "approve" ? "✅" : "❌"}`).join(" · ") || "not reached"}.
- **Not a substitute for your review.** Agents wrote this from the issue text${r.issue.dropped?.length ? `, leaving out: ${md(r.issue.dropped.join("; "))}` : ""}.

## How to test

\`\`\`sh
gh pr checkout <this PR> && ${commands.reproduce}
\`\`\`
${m?.applicable && m.tests?.length ? `\nThe changed tests: \`${commands.focused.replace("<file>", m.tests.join(" "))}\`. To see them catch the problem, undo the source change (\`git checkout origin/main -- ${(m.reverted ?? []).join(" ")}\`), ${commands.build === false ? "" : "rebuild, "}and run them again: they fail.\n` : ""}
${r.evidence ? `\n**What the recordings show:** ${md(r.evidence.demonstrates)}${r.evidence.limitations ? `\n\n_What they don't show:_ ${md(r.evidence.limitations)}` : ""}\n` : ""}
${show("proof", "Test proof")}
📄 [Full report with playable videos](${report})

---

## For reviewers — the detail

### Acceptance criteria (checked by the spec reviewer)

${acs}
${(r.spec.after_merge ?? []).length ? `\n### For you to check after it merges\n\n${r.spec.after_merge.map((c) => `- [ ] ${md(c.id)}: ${md(c.text)}`).join("\n")}\n\n_Not part of the agents' checklist (it can't be checked before the merge)._\n` : ""}
${blocking.length ? `### Open blocking findings\n\n${blocking.join("\n")}\n\n` : ""}${suggestions.length ? `<details><summary>Reviewer suggestions (non-blocking)</summary>\n\n${suggestions.join("\n")}\n</details>\n\n` : ""}${(r.last.impl.open_questions ?? []).length ? `### Open questions\n\n${r.last.impl.open_questions.map((q) => `- ${md(q)}`).join("\n")}\n\n` : ""}<sub>Opened by the issue agent (\`ci/issue-agent\` in ${harnessRepo}) · run \`${r.id}\` · ${r.rounds.length} round(s) · ${r.model} · ~$${r.costUsd.toFixed(2)}. Draft until a human has read it.</sub>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

// The issue's live status comment: one comment, edited in place — the current state on top, a
// timestamped history underneath (newest last, capped). `previous` is that comment's current body.
export const STATUS_MARK = "<!-- issue-agent-status -->";
export function statusBody(previous, state, { at = new Date(), link, max = 25 } = {}) {
  const rows = String(previous ?? "").split("\n").filter((l) => /^\| \d{2}-\d{2} \d{2}:\d{2} \|/.test(l));
  const when = at.toISOString().slice(5, 16).replace("T", " "); // MM-DD HH:MM, UTC
  // One line, everywhere it's shown: a line break in a reason could otherwise plant a fake history row.
  const line = md(String(state).replace(/[\r\n]+/g, " "));
  rows.push(`| ${when} | ${line.replace(/\|/g, "\\|")}${link ? ` · [run](${link})` : ""} |`);
  return `${STATUS_MARK}\n🤖 **Issue agent:** ${line}\n\n| UTC | step |\n| --- | --- |\n${rows.slice(-max).join("\n")}\n`;
}

// The review loop's comments on a PR (run.mjs, "the review loop").
export const REVIEW_MARK = "<!-- issue-agent-review";

// Open review threads, each as a link a reviewer can click: the file and the note's first line.
const threadLinks = (threads, url) => threads.map((t) => {
  const first = String(t.comments[0].body).replace(/[*_`#>]/g, "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? "";
  return `- [${md(t.path ?? "general")}${t.line ? `:${t.line}` : ""}](${url}#discussion_r${t.comments[0].databaseId}) — ${md(first)}`;
}).join("\n");

/**
 * The hand-over comment. `threads`: open threads people with write access started (still open only
 * at the cycle cap); `notes`: the review bot's open threads — optional, listed as no action needed.
 */
export function handOverComment({ kind, who = "", reason, cycle, threads = [], notes = [], url }) {
  reason = String(reason).charAt(0).toUpperCase() + String(reason).slice(1); // it follows a full stop
  const open = threadLinks(threads, url);
  const optional = notes.length ? `\n\nThe reviewer's optional notes, still open — no action needed before merging:\n${threadLinks(notes, url)}` : "";
  if (kind !== "ready") return `${REVIEW_MARK} stopped -->\n⚠️ **The agent stopped iterating — ${who}this needs a human.** ${md(reason)}.${open ? `\n\nStill open:\n${open}` : ""}${optional}`;
  return threads.length
    ? `${REVIEW_MARK} done -->\n✅ **${who}this is ready for your review — with ${threads.length} thread(s) left open.** ${md(reason)}. The agent stopped at the cycle cap rather than answer them again:\n\n${open}${optional}`
    : `${REVIEW_MARK} done -->\n✅ **The review says ready — ${who}this is ready for your review.** ${md(reason)} after ${cycle} fix cycle(s).${optional}`;
}

export function issueComment({ kind, reason, prUrl, report, where }) {
  const retry = "Remove and re-add the `agent` label to run it again.";
  switch (kind) {
    case "skipped": return `${MARK}\n🤖 **Issue agent: not starting this one** — ${md(reason)}.`;
    // `agent:approved` refused, and a failed run: their own markers, because neither means a run read
    // the comments (brief.mjs, briefState).
    case "refused": return `${REFUSAL_MARK}\n🤖 **Issue agent: not starting this one** — ${md(reason)}.`;
    case "blocked": return `${MARK}\n🤖 **Issue agent: not starting this one.** After reading the code, the spec agent found it isn't actionable yet:\n\n> ${md(reason)}\n\n${retry}`;
    // `reason`: a failure the pipeline recognised (checks.mjs, publishRefusalHint) — it says what to do.
    case "error": return `${ERROR_MARK}\n🤖 **Issue agent: the run failed before it could open a PR.**${reason ? ` ${md(reason)}.` : ""}${where ? ` Logs: ${where}` : ""}\n\n${retry}`;
    case "needs-human-nopr": return `${MARK}\n🤖 **Issue agent: no PR** — ${md(reason ?? "the run stopped early")}.${where ? ` Logs and transcripts: ${where}` : ""}\n\n${retry}`;
    // A brief that turned out to be about a security hole in code people use today (card.mjs, isPrivate):
    // nothing about it is said here — SECURITY.md says it is reported privately.
    case "security-stop": return `${MARK}\n🤖 **Issue agent: stopped.** This looks like a security problem in code people use today, so the agents posted nothing about it, and the run kept only its outcome. A maintainer should move it to a private security advisory (the repository's Security tab) and fix it there — see SECURITY.md.`;
    case "pr-in-review": return `${MARK}\n🤖 **Issue agent:** a PR is up and the agent is now working through the Claude review on it: ${prUrl}\n\nIt will ask for a human review once every review is resolved (or say why it stopped).`;
    default: {
      const ok = kind === "pr";
      const partial = report.last.gates.filter((g) => notFullRun(g, report.patchSha256));
      // A failure is said first; the not-full-run note only qualifies gates that otherwise passed.
      const note = partial.length ? ` (\`test\`: ${partial.map((g) => notFullRun(g, report.patchSha256)).join("; ")})` : "";
      const gates = !report.last.gates.every((g) => g.ok) ? `red${note}`
        : partial.length ? `not all run on this change${note}`
        : report.last.gates.every((g) => g.green) ? "green"
        : `green except what's already red on main (${report.last.gates.filter((g) => !g.green).map((g) => g.name).join(", ")})`;
      return `${MARK}\n🤖 **Issue agent:** ${ok ? "a draft PR is ready for review" : "a draft PR is up, but it **needs a human**"}: ${prUrl}\n\n${report.spec.acceptance_criteria.length} acceptance criteria · ${report.rounds.length} round(s) · gates ${gates}${report.manifest.some((e) => e.kind === "video") ? " · screenshots and video in the PR" : ""}`;
    }
  }
}
