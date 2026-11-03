// Splitting a big issue (README.md, "Splitting a big issue"). The brief says whether the issue is one
// pull request or several. Several: it carries a short design and a set of tickets — tracer-bullet
// slices in the to-tickets skill's sense, each with the acceptance criteria it delivers and the
// tickets that block it. Approving that brief opens the tickets as sub-issues of the issue and labels
// the ones nothing blocks; each is then built like any approved brief, one small PR at a time.
//
// A ticket carries its slice of the approved brief inside its own body, sealed the way a brief is
// (brief.mjs): what a ticket's build is checked against is exactly what the maintainer approved. A
// ticket edited by hand no longer matches, and is treated as an ordinary issue (it gets a brief).

import { createHash } from "node:crypto";
import { md } from "./report.mjs";

export const TICKET_MARK = "<!-- issue-agent-ticket";
const MARKER = /^<!-- issue-agent-ticket parent=(\d+) v=(\d+) id=(T\d+) sha=([0-9a-f]{64}) data=([A-Za-z0-9+/=]+) -->\n/;

// Past these, one pull request is too much to review: the brief must split it, or say why it can't.
export const SCOPE_LIMITS = { criteria: 8, files: 12 };
/** A brief past SCOPE_LIMITS: too big for one reviewer, unless it says why it can't be split. */
export const pastLimits = (brief) => (brief?.acceptance_criteria ?? []).length > SCOPE_LIMITS.criteria || (brief?.files_likely ?? []).length > SCOPE_LIMITS.files;
// The label on a ticket whose build the agents stopped (a challenge): nothing restarts it on its own.
export const STOPPED_LABEL = "agent:needs-human";

const encode = (data) => Buffer.from(JSON.stringify(data), "utf8").toString("base64");
const seal = (encoded, visible) => createHash("sha256").update(`ticket\n${encoded}\n${visible}`).digest("hex");
const oneLine = (s) => md(String(s ?? "").replace(/[\r\n]+/g, " ").trim());
const cap = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)} … [cut]` : t; };

export const isSplit = (brief) => brief?.scope?.verdict === "split";

/** The scope with every field the agents wrote cut to size (brief.mjs, clampBrief). */
export function clampScope(scope, { field = 1200, item = 400, items = 15 } = {}) {
  if (!scope || typeof scope !== "object") return undefined;
  const ids = (xs) => (Array.isArray(xs) ? xs.slice(0, items).map((x) => cap(x, 8)) : []);
  return {
    verdict: scope.verdict === "split" ? "split" : "single",
    why: cap(scope.why, field),
    ...(scope.verdict === "split" ? {
      design: cap(scope.design, field * 3),
      tickets: (Array.isArray(scope.tickets) ? scope.tickets.slice(0, 8) : []).map((t) => ({
        id: cap(t.id, 4), title: cap(t.title, 120), delivers: cap(t.delivers, item),
        criteria: ids(t.criteria), blocked_by: ids(t.blocked_by),
      })),
    } : {}),
  };
}

/** The tickets in an order where each comes after everything that blocks it, or undefined on a cycle. */
export function ticketOrder(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const done = new Set(), visiting = new Set(), out = [];
  const visit = (t) => {
    if (done.has(t.id)) return true;
    if (visiting.has(t.id)) return false;
    visiting.add(t.id);
    for (const b of t.blocked_by ?? []) if (byId.has(b) && !visit(byId.get(b))) return false;
    visiting.delete(t.id); done.add(t.id); out.push(t);
    return true;
  };
  for (const t of tickets) if (!visit(t)) return undefined;
  return out;
}

/**
 * Every problem with the brief's scope, for the agent to fix: [] when it passes. A split must be a
 * real plan — a design, at least two tickets, every criterion delivered by exactly one ticket, and
 * blocking edges that point at real tickets without a cycle. A single PR past SCOPE_LIMITS must say
 * why it can't be split.
 */
export function scopeProblems(brief) {
  const scope = brief?.scope;
  if (!brief?.actionable) return [];
  if (!scope || !["single", "split"].includes(scope.verdict)) return ['scope: say "single" (one pull request) or "split" (several tickets)'];
  const out = [];
  const criteria = (brief.acceptance_criteria ?? []).map((c) => c.id);
  if (scope.verdict === "single") {
    if (pastLimits(brief) &&String(scope.why ?? "").trim().length < 40) {
      out.push(`scope: ${criteria.length} criteria and ${(brief.files_likely ?? []).length} likely files is more than one pull request should carry (at most ${SCOPE_LIMITS.criteria} and ${SCOPE_LIMITS.files}) — split it into tickets, or say in "why" what makes it one indivisible change`);
    }
    return out;
  }
  const tickets = scope.tickets ?? [];
  if (!String(scope.design ?? "").trim()) out.push("scope: a split needs the design — the decisions a builder must not make alone (what is stored and where, the interfaces between the tickets)");
  if (tickets.length < 2) out.push("scope: a split needs at least two tickets — or make it single");
  const ids = tickets.map((t) => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) out.push(`scope: ticket ids repeat (${[...new Set(dupes)].join(", ")})`);
  for (const t of tickets) {
    if (!/^T\d{1,2}$/.test(String(t.id ?? ""))) out.push(`scope: ticket id ${t.id} must be T1, T2, … (T and a number)`);
    if (!String(t.title ?? "").trim() || !String(t.delivers ?? "").trim()) out.push(`scope: ticket ${t.id} needs a title and what it delivers`);
    if (!(t.criteria ?? []).length) out.push(`scope: ticket ${t.id} delivers no acceptance criterion — every ticket must be checkable on its own`);
    for (const c of t.criteria ?? []) if (!criteria.includes(c)) out.push(`scope: ticket ${t.id} names ${c}, which is not one of the acceptance criteria`);
    for (const b of t.blocked_by ?? []) if (!ids.includes(b) || b === t.id) out.push(`scope: ticket ${t.id} is blocked by ${b}, which is not another ticket`);
  }
  for (const c of criteria) {
    const n = tickets.filter((t) => (t.criteria ?? []).includes(c)).length;
    if (n === 0) out.push(`scope: no ticket delivers ${c}`);
    if (n > 1) out.push(`scope: ${c} is in ${n} tickets — give each criterion to exactly one`);
  }
  if (tickets.length && !ticketOrder(tickets)) out.push("scope: the tickets block each other in a cycle");
  if (tickets.length && !tickets.some((t) => !(t.blocked_by ?? []).length)) out.push("scope: every ticket is blocked — at least one must be able to start now");
  return out;
}

const TAG = { test: "a test", evidence: "screenshots", review: "a reviewer", "after-merge": "you, after it merges" };

/** The plan, as the brief shows it (above the divider, after the card). */
export function planSection(brief) {
  if (!isSplit(brief)) return "";
  const tickets = ticketOrder(brief.scope.tickets ?? []) ?? brief.scope.tickets ?? [];
  return `**This is ${tickets.length} pieces of work, not one.** ${oneLine(brief.scope.why)}

${tickets.map((t, i) => `${i + 1}. **${oneLine(t.title)}** — ${oneLine(t.delivers)}${(t.blocked_by ?? []).length ? ` _(after ${t.blocked_by.map(oneLine).join(", ")})_` : ""}`).join("\n")}
`;
}

/** The design and which ticket delivers which criterion (below the divider). */
export function designSection(brief) {
  if (!isSplit(brief)) return "";
  const tickets = ticketOrder(brief.scope.tickets ?? []) ?? brief.scope.tickets ?? [];
  return `### The design — decided here, so no ticket decides it alone

${md(brief.scope.design ?? "")}

### The tickets

| Ticket | What it delivers | Criteria | Blocked by |
| --- | --- | --- | --- |
${tickets.map((t) => `| **${oneLine(t.id)}** ${oneLine(t.title)} | ${oneLine(t.delivers)} | ${(t.criteria ?? []).map(oneLine).join(", ")} | ${(t.blocked_by ?? []).map(oneLine).join(", ") || "nothing — starts first"} |`).join("\n")}
`;
}

/**
 * One ticket's slice of the approved brief: what its build is checked against. The brief's own
 * fields where they hold for every ticket (scope fences, the test and evidence plans), and only the
 * criteria this ticket delivers.
 */
export function ticketSpec(brief, ticket) {
  const others = (brief.scope.tickets ?? []).filter((t) => t.id !== ticket.id);
  return {
    whats_wrong: brief.card.whats_wrong,
    delivers: ticket.delivers,
    acceptance_criteria: (brief.acceptance_criteria ?? []).filter((c) => (ticket.criteria ?? []).includes(c.id)),
    not_in_scope: [...(brief.not_in_scope ?? []), ...others.map((t) => `${t.title} — that is ticket ${t.id}`)],
    design: brief.scope.design,
    behavior_change: brief.behavior_change, touches_ui: brief.touches_ui,
    evidence_plan: brief.evidence_plan, test_plan: brief.test_plan, files_likely: brief.files_likely ?? [],
  };
}

/**
 * The ticket's issue body. `data`: { parent, v, id, title, spec, blockedBy: [issue numbers] }. The
 * visible text is the to-tickets skill's issue template; the marker holds the same as data.
 */
export function ticketBody(data) {
  const { parent, v, id, spec, blockedBy = [] } = data;
  const visible = `🤖 **A ticket from the approved plan for #${parent}** (brief v${v}, ${id}). Labelled \`agent\`, it is built as is — the plan was approved once, on #${parent}. Edit it and it becomes an ordinary issue that gets its own brief.

## Parent

#${parent}

## What to build

${md(spec.delivers)}

## Acceptance criteria

${spec.acceptance_criteria.map((c) => `- **${oneLine(c.id)}** ${oneLine(c.text)} _(checked by ${TAG[c.verified_by] ?? "?"})_`).join("\n")}

## Blocked by

${blockedBy.length ? blockedBy.map((n) => `- #${n}`).join("\n") : "- None (can start immediately)"}

## Not in scope

${spec.not_in_scope.map((s) => `- ${oneLine(s)}`).join("\n") || "- nothing called out"}

<details><summary>The design, from the approved plan</summary>

${md(spec.design ?? "")}
</details>
`;
  const encoded = encode(data);
  return `${TICKET_MARK} parent=${parent} v=${v} id=${id} sha=${seal(encoded, visible)} data=${encoded} -->\n${visible}`;
}

/** The ticket in an issue body, or undefined when it isn't one (or was edited after it was opened). */
export function parseTicket(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const m = text.match(MARKER);
  if (!m) return undefined;
  const visible = text.slice(m[0].length);
  if (seal(m[5], visible) !== m[4] && seal(m[5], `${visible.trimEnd()}\n`) !== m[4]) return undefined;
  let data;
  try { data = JSON.parse(Buffer.from(m[5], "base64").toString("utf8")); } catch { return undefined; }
  if (!data || data.parent !== Number(m[1]) || data.v !== Number(m[2]) || data.id !== m[3] || !data.spec?.acceptance_criteria) return undefined;
  return data;
}

/**
 * Which plan an issue was opened as a ticket of — { parent, v, id } — sealed or not. A ticket edited by
 * hand is no longer built as approved, but it is still that plan's ticket: what waits on it starts when
 * it is completed, and the plan isn't done while it is open. Never a reason to build anything.
 */
export function ticketHeader(body) {
  const m = String(body ?? "").replace(/\r\n/g, "\n").match(MARKER);
  return m ? { parent: Number(m[1]), v: Number(m[2]), id: m[3] } : undefined;
}

/**
 * A ticket as the approved brief its build runs on (brief.mjs, specFromBrief): the parent's version,
 * and a brief holding only this ticket's slice.
 */
export const ticketAsBrief = (t) => ({
  v: t.v,
  ticket: { parent: t.parent, id: t.id },
  brief: {
    actionable: true,
    card: { whats_wrong: t.spec.whats_wrong, fix: t.spec.delivers },
    acceptance_criteria: t.spec.acceptance_criteria,
    not_in_scope: t.spec.not_in_scope,
    behavior_change: t.spec.behavior_change, touches_ui: t.spec.touches_ui,
    evidence_plan: t.spec.evidence_plan, test_plan: t.spec.test_plan,
    files_likely: t.spec.files_likely,
    design: t.spec.design,
  },
});

/**
 * What still holds a ticket back, from its blockers' { number, state, stateReason }: `open` ones (it
 * starts when they are completed) and `dropped` ones — closed without being completed, so it never will.
 */
export function blockersLeft(blockers) {
  return {
    open: blockers.filter((b) => b.state !== "CLOSED").map((b) => b.number),
    dropped: blockers.filter((b) => b.state === "CLOSED" && !isDone(b)).map((b) => b.number),
  };
}

/**
 * Where a plan stands after one of its tickets closed. `issues`: the parent's sub-issues, each
 * { number, state, stateReason, labels, head, ticket } (head: ticketHeader, ticket: parseTicket, both
 * only for issues the pipeline opened). `head`: the closed ticket's. Returns the plan's tickets, those
 * to start now, those still open, and — once none are — those closed without being completed.
 */
export function planProgress(issues, head, label = "agent") {
  const plan = issues.filter((i) => i.head?.parent === head.parent && i.head.v === head.v);
  const open = plan.filter((t) => t.state === "OPEN");
  return { plan, start: frontier(plan, label), open, dropped: open.length ? [] : plan.filter((t) => !isDone(t)) };
}

/**
 * A blocker is done only when it was closed as completed: a ticket closed as not planned or a
 * duplicate was dropped, and what it was meant to deliver isn't on main. (GitHub's stateReason.)
 */
export const isDone = (t) => t.state === "CLOSED" && String(t.stateReason ?? "").toUpperCase() === "COMPLETED";

/**
 * The tickets to start now: open, not already labelled, not stopped by a challenge nobody has settled,
 * and with every blocker done. `tickets`: [{ number, state, stateReason, labels, ticket }] — every
 * ticket of the plan; `ticket` is undefined for one edited by hand, which counts as a blocker but is
 * never started (it is an ordinary issue now). `label` the trigger label.
 */
export function frontier(tickets, label = "agent") {
  const done = new Set(tickets.filter(isDone).map((t) => t.number));
  return tickets.filter((t) => t.ticket && t.state === "OPEN" &&!t.labels.includes(label) && !t.labels.includes(STOPPED_LABEL)
    && (t.ticket.blockedBy ?? []).every((n) => done.has(n)));
}
