// The PR's "Before and after" (README.md, "Before and after"): the few lines a developer of the repo
// would write, run on main and on the change, with what each printed. An agent proposes the example;
// THIS module checks its shape and the pipeline runs it itself, in both checkouts — so the output in
// the PR is what really happened, not what an agent says happened.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

const RUNNERS = ["node", "npm", "npx"]; // what a developer types; the agent can't pick another program
const MAX_FILES = 3, MAX_FILE = 4000, MAX_OUT = 2500, MAX_LINES = 30;

/**
 * The agent's proposal, checked: { title, lang, files: [{ path, content }], show, cmd: argv } — or an
 * { error } saying what's wrong with it. Paths are relative to the checkout and stay inside it.
 */
export function validateExample(raw) {
  if (!raw || typeof raw !== "object") return { error: "no example" };
  if (raw.applicable === false) return { notApplicable: String(raw.why_not ?? "no developer-facing change").slice(0, 300) };
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length || files.length > MAX_FILES) return { error: `an example has 1–${MAX_FILES} files` };
  for (const f of files) {
    const p = String(f?.path ?? "");
    if (!p || isAbsolute(p) || normalize(p).startsWith("..") || /(^|\/)\.git(\/|$)/.test(p) || p.includes("\0")) return { error: `not a path inside the checkout: ${p}` };
    if (typeof f.content !== "string" || f.content.length > MAX_FILE) return { error: `${p}: content must be text under ${MAX_FILE} characters` };
  }
  const cmd = raw.cmd;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === "string" && a.length && a.length < 300) || !RUNNERS.includes(cmd[0])) {
    return { error: `the command must be an argv array starting with ${RUNNERS.join(", ")}` };
  }
  const show = files.find((f) => f.path === raw.show) ?? files[0];
  return {
    title: String(raw.title ?? "").replace(/\s+/g, " ").slice(0, 200),
    lang: /^[a-z]{1,12}$/.test(raw.lang) ? raw.lang : "js",
    files: files.map((f) => ({ path: normalize(f.path), content: f.content })),
    show: normalize(show.path),
    cmd,
  };
}

const trim = (out) => {
  const lines = String(out).replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
  const kept = lines.length > MAX_LINES ? ["…", ...lines.slice(-MAX_LINES)] : lines;
  const text = kept.join("\n");
  return text.length > MAX_OUT ? `…${text.slice(-MAX_OUT)}` : text;
};

/**
 * Run the example in each checkout and put each checkout back as it was. `run(cmd, args, { cwd })`
 * returns { code, out } — the pipeline passes its credential-free runner.
 */
export function runExample(ex, { beforeDir, afterDir }, run) {
  const side = (dir) => {
    const saved = ex.files.map((f) => ({ f, path: join(dir, f.path), had: existsSync(join(dir, f.path)) ? readFileSync(join(dir, f.path)) : undefined }));
    try {
      for (const s of saved) { mkdirSync(dirname(s.path), { recursive: true }); writeFileSync(s.path, s.f.content); }
      const r = run(ex.cmd[0], ex.cmd.slice(1), { cwd: dir });
      return { code: r.code, out: trim(r.out) };
    } finally {
      for (const s of saved) s.had === undefined ? rmSync(s.path, { force: true }) : writeFileSync(s.path, s.had);
    }
  };
  const before = side(beforeDir), after = side(afterDir);
  return { ...ex, code: ex.files.find((f) => f.path === ex.show).content, before, after, same: before.code === after.code && before.out === after.out };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The side-by-side picture the PR shows first: the code, then main's output next to the change's. */
export function exampleHtml(r) {
  const pane = (label, cls, x) => `<section class="${cls}"><h2>${label}<span>exit ${x.code}</span></h2><pre>${esc(x.out) || "(no output)"}</pre></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f6f8fa;font:15px/1.45 -apple-system,"Segoe UI",sans-serif;color:#1f2328}
main{padding:22px;max-width:1180px}h1{font-size:19px;margin:0 0 12px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.code{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px 14px;margin-bottom:14px}
.code .cmd{color:#57606a;margin-top:8px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
section{border-radius:8px;border:1px solid;overflow:hidden}section pre{padding:12px 14px;background:#fff}
h2{margin:0;padding:8px 14px;font-size:14px;display:flex;justify-content:space-between}
h2 span{font-weight:400;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.before{border-color:#f5c2c0}.before h2{background:#ffebe9;color:#a40e26}
.after{border-color:#aceebb}.after h2{background:#dafbe1;color:#116329}
.same h2{background:#fff8c5;color:#7d4e00}.same{border-color:#e9d38b}
</style></head><body><main>
<h1>${esc(r.title)}</h1>
<div class="code"><pre>${esc(r.code)}</pre><pre class="cmd">$ ${esc(r.cmd.join(" "))}</pre></div>
<div class="row">${pane("Before — main", r.same ? "same" : "before", r.before)}${pane("After — this change", r.same ? "same" : "after", r.after)}</div>
</main></body></html>`;
}
