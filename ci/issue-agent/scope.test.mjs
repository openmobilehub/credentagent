// Splitting a big issue (README.md, "Splitting a big issue"): a brief can split an issue into a design
// and tickets; approving it opens the tickets, and each is built as approved. Each test fails if its
// check is removed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { briefBody, parseBrief, clampBrief, briefState, planRun, specFromBrief, LABEL_APPROVED } from "./brief.mjs";
import { scopeProblems, ticketOrder, ticketBody, parseTicket, ticketSpec, ticketAsBrief, frontier, isDone, pastLimits, planSection, blockersLeft, planProgress, ticketHeader, SCOPE_LIMITS, STOPPED_LABEL } from "./scope.mjs";
import { BRIEF_SCHEMA, briefPrompt } from "./roles.mjs";

// Issue 406, as a split brief: the activity list, then refusals, then a passkey, then Revoke.
const criteria = ["AC1", "AC2", "AC3", "AC4"].map((id, i) => ({ id, text: `criterion ${i + 1}`, verified_by: "test" }));
const tickets = () => [
  { id: "T1", title: "Purchases on the grant page", delivers: "The page lists each purchase, newest first.", criteria: ["AC1"], blocked_by: [] },
  { id: "T2", title: "Refused attempts on the grant page", delivers: "The page lists each refused attempt with a plain reason.", criteria: ["AC2"], blocked_by: ["T1"] },
  { id: "T3", title: "A passkey when approving", delivers: "Approving a grant registers the approver's passkey.", criteria: ["AC3"], blocked_by: [] },
  { id: "T4", title: "Revoke with that passkey", delivers: "The approver revokes the grant with their passkey.", criteria: ["AC4"], blocked_by: ["T3", "T1"] },
];
const split = (over = {}) => ({
  actionable: true,
  reproduced: { confirmed: "yes", how: "node repro.mjs", result: "page mentions 18.00: false" },
  card: {
    whats_wrong: "Sam approves a $200 grant and the agent buys $58 of drinks. Sam's grant page shows none of it.",
    how_bad: { level: "broken", direction: "lets-through", live: "release", live_detail: "npm 0.3.0 onward", who: "people who approved a spending grant" },
    options: [], fix: "The grant page lists what was bought and refused, and Sam can revoke it.",
    approving: "Approval gains a passkey step.", check: "Buy twice, get refused once, revoke: the next buy is refused.",
  },
  acceptance_criteria: criteria, not_in_scope: ["email or push notifications"],
  behavior_change: true, touches_ui: true, evidence_plan: "the grant page before and after", test_plan: "grants-activity.test.ts", files_likely: ["grants-serve.ts"],
  revised: true,
  scope: { verdict: "split", why: "Four things a person can check alone; the list comes before Revoke.", design: "Spends record item and time in the revocation store; refusals live in an injectable per-grant store.", tickets: tickets() },
  ...over,
});
const withScope = (scope) => split({ scope: { ...split().scope, ...scope } });

describe("the plan's check", () => {
  it("passes a plan where every criterion belongs to exactly one ticket", () => {
    expect(scopeProblems(split())).toEqual([]);
  });
  it("refuses a split with no design — the decisions would be made inside a ticket", () => {
    expect(scopeProblems(withScope({ design: "" })).join(" ")).toMatch(/needs the design/);
  });
  it("refuses a criterion no ticket delivers, or one two tickets both claim", () => {
    const both = tickets(); both[1].criteria = ["AC2", "AC1"];
    expect(scopeProblems(withScope({ tickets: both })).join(" ")).toMatch(/AC1 is in 2 tickets/);
    expect(scopeProblems(withScope({ tickets: tickets().filter((x) => x.id !== "T3").map((x) => ({ ...x, blocked_by: x.blocked_by.filter((b) => b !== "T3") })) })).join(" ")).toMatch(/no ticket delivers AC3/);
  });
  it("refuses a ticket that delivers nothing checkable, or names a criterion that isn't one", () => {
    const t = tickets(); t[2].criteria = ["AC9"];
    expect(scopeProblems(withScope({ tickets: t })).join(" ")).toMatch(/T3 names AC9/);
  });
  it("refuses blockers that aren't tickets, a cycle, and a plan where nothing can start", () => {
    const ghost = tickets(); ghost[1].blocked_by = ["T9"];
    expect(scopeProblems(withScope({ tickets: ghost })).join(" ")).toMatch(/blocked by T9/);
    const cycle = tickets(); cycle[0].blocked_by = ["T2"];
    expect(scopeProblems(withScope({ tickets: cycle })).join(" ")).toMatch(/cycle/);
    const stuck = tickets().map((x) => ({ ...x, blocked_by: x.id === "T1" ? ["T4"] : x.id === "T3" ? ["T2"] : x.blocked_by }));
    expect(scopeProblems(withScope({ tickets: stuck })).join(" ")).toMatch(/at least one must be able to start now/);
  });
  it("refuses a ticket id the ticket marker can't carry", () => {
    for (const id of ["T-1", "t1", "1", "T123"]) {
      const bad = tickets(); bad[0].id = id; bad[1].blocked_by = [id]; bad[3].blocked_by = ["T3", id];
      expect(scopeProblems(withScope({ tickets: bad })).join(" ")).toMatch(new RegExp(`ticket id ${id} must be T1, T2`));
    }
  });
  it("refuses a one-ticket split", () => {
    const one = [{ ...tickets()[0], criteria: ["AC1", "AC2", "AC3", "AC4"] }];
    expect(scopeProblems(withScope({ tickets: one })).join(" ")).toMatch(/at least two tickets/);
  });
  it("sends back a single PR past the limits unless it says why it can't be split", () => {
    const many = Array.from({ length: SCOPE_LIMITS.criteria + 1 }, (_, i) => ({ id: `AC${i + 1}`, text: "t", verified_by: "test" }));
    expect(scopeProblems(split({ acceptance_criteria: many, scope: { verdict: "single", why: "one" } })).join(" ")).toMatch(/more than one pull request should carry/);
    expect(scopeProblems(split({ acceptance_criteria: many, scope: { verdict: "single", why: "One rename across every package: no part of it builds green on its own." } }))).toEqual([]);
    expect(scopeProblems(split({ scope: { verdict: "single", why: "small" } }))).toEqual([]);
  });
  it("needs a verdict at all — the brief agent must decide", () => {
    expect(scopeProblems(split({ scope: undefined })).join(" ")).toMatch(/single.*split/);
    expect(BRIEF_SCHEMA.required).toContain("scope");
  });
  it("orders tickets after their blockers", () => {
    const order = ticketOrder(tickets()).map((t) => t.id);
    expect(order.indexOf("T1")).toBeLessThan(order.indexOf("T2"));
    expect(order.indexOf("T3")).toBeLessThan(order.indexOf("T4"));
    expect(order.indexOf("T1")).toBeLessThan(order.indexOf("T4"));
  });
});

describe("the brief agent is told to plan with the skills", () => {
  it("reads the vendored to-tickets, codebase-design and to-spec skills — to-tickets and to-spec don't load on their own", () => {
    const p = briefPrompt({ number: 406, url: "u", title: "t", body: "b", comments: [] });
    for (const s of ["to-tickets", "codebase-design", "to-spec"]) {
      expect(p).toContain(`.claude/skills/${s}/SKILL.md`);
      expect(readFileSync(new URL(`../../.claude/skills/${s}/SKILL.md`, import.meta.url), "utf8")).toMatch(/author: Matt Pocock/);
    }
  });
});

describe("a split brief", () => {
  const data = { v: 2, start: 1, asOf: "2026-10-19T03:28:14Z", brief: clampBrief(split()), base: "a".repeat(40) };
  const ME = { login: "maintainer", __typename: "User" }, BOT = { login: "github-actions", __typename: "Bot" };
  const state = briefState([{ author: BOT, body: briefBody(data), createdAt: "2026-10-19T03:31:52Z" }], (l) => l === ME.login);
  it("shows the plan on the card and the design below the divider, and reads back exactly", () => {
    const body = briefBody(data);
    expect(body).toMatch(/This is 4 pieces of work, not one/);
    expect(body).toMatch(/### The design — decided here/);
    expect(body).toMatch(/Approving opens the 4 tickets as sub-issues/);
    expect(parseBrief(body)).toEqual(data);
    expect(planSection(split())).toMatch(/Revoke with that passkey.*after T3, T1/);
  });
  it("approving it opens the tickets — it never builds the whole thing", () => {
    const plan = planRun({ trigger: `label:${LABEL_APPROVED}`, pause: true, state });
    expect(plan.phase).toBe("split");
    expect(plan.brief.v).toBe(2);
  });
  it("a single brief still builds as before", () => {
    const one = { ...data, brief: clampBrief(split({ scope: { verdict: "single", why: "one change" } })) };
    const s = briefState([{ author: BOT, body: briefBody(one), createdAt: "2026-10-19T03:31:52Z" }], () => false);
    expect(planRun({ trigger: `label:${LABEL_APPROVED}`, pause: true, state: s }).phase).toBe("implement");
  });
});

describe("a ticket", () => {
  const b = split();
  const t4 = b.scope.tickets[3];
  const body = ticketBody({ parent: 406, v: 2, id: "T4", spec: ticketSpec(b, t4), blockedBy: [410, 407] });
  it("is the to-tickets issue template, with only its own criteria and the others out of scope", () => {
    for (const h of ["## Parent", "## What to build", "## Acceptance criteria", "## Blocked by"]) expect(body).toContain(h);
    expect(body).toMatch(/AC4/);
    expect(body).not.toMatch(/\*\*AC1\*\*/);
    expect(body).toMatch(/- #410\n- #407/);
    expect(body).toMatch(/Purchases on the grant page — that is ticket T1/);
    // Plain bullets: a checkbox someone ticks edits the body, which breaks the seal.
    expect(body).not.toMatch(/- \[ \]/);
  });
  it("reads back as what was approved, and stops being a ticket once edited", () => {
    const t = parseTicket(body);
    expect(t).toMatchObject({ parent: 406, v: 2, id: "T4", blockedBy: [410, 407] });
    expect(parseTicket(body.replace("criterion 4", "criterion 4, and also drop the passkey check"))).toBeUndefined();
    expect(parseTicket(body.replace("parent=406", "parent=405"))).toBeUndefined();
  });
  it("is built as approved when labelled — its contract is its own slice of the brief", () => {
    const asBrief = ticketAsBrief(parseTicket(body));
    expect(planRun({ trigger: "label:agent", pause: true, ticket: asBrief })).toEqual({ phase: "implement", brief: asBrief });
    const spec = specFromBrief(asBrief.brief);
    expect(spec.acceptance_criteria.map((c) => c.id)).toEqual(["AC4"]);
    expect(spec.design).toMatch(/injectable per-grant store/);
    // An ordinary issue (no sealed ticket) still gets a brief first.
    expect(planRun({ trigger: "label:agent", pause: true })).toEqual({ phase: "brief" });
  });
  it("is trusted only when the pipeline wrote it, and waits for its blockers", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const ticket = isLoopAuthor\(i\.author, trusted\) \? parseTicket\(i\.body\) : undefined;/);
    expect(src).toMatch(/this ticket is blocked by/);
  });
});

describe("which tickets start", () => {
  const t = (number, state, blockedBy, labels = [], stateReason = state === "CLOSED" ? "COMPLETED" : null) => ({ number, state, stateReason, labels, ticket: { blockedBy } });
  it("only open ones whose blockers are all closed, and not twice", () => {
    const all = [t(407, "CLOSED", []), t(408, "OPEN", [407]), t(409, "OPEN", [407, 410]), t(410, "OPEN", []), t(411, "OPEN", [], ["agent"])];
    expect(frontier(all).map((x) => x.number)).toEqual([408, 410]);
  });
  it("not after a blocker that was dropped — closed as not planned or a duplicate is not done", () => {
    for (const reason of ["NOT_PLANNED", "DUPLICATE", null]) {
      expect(frontier([t(407, "CLOSED", [], [], reason), t(408, "OPEN", [407])]).map((x) => x.number)).toEqual([]);
    }
    expect(isDone(t(407, "CLOSED", []))).toBe(true);
  });
  it("never a ticket the agents stopped with a challenge, until a person clears it", () => {
    const all = [t(407, "CLOSED", []), t(408, "OPEN", [407], [STOPPED_LABEL]), t(409, "OPEN", [407])];
    expect(frontier(all).map((x) => x.number)).toEqual([409]);
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/relabel\(n, \{ add: \[LABELS\.needsHuman\], remove: \[TRIGGER_LABEL\] \}\)/);
    expect(src).toMatch(/needsHuman: STOPPED_LABEL/);
    expect(src).not.toMatch(/reply on #\$\{parent\} to revise the plan/);
  });
  it("blockers are checked the same way when a ticket's own run starts — open ones wait, dropped ones never pass", () => {
    const b = (number, state, stateReason = null) => ({ number, state, stateReason });
    expect(blockersLeft([b(407, "CLOSED", "COMPLETED"), b(408, "OPEN"), b(409, "CLOSED", "NOT_PLANNED")])).toEqual({ open: [408], dropped: [409] });
    expect(blockersLeft([b(407, "CLOSED", "COMPLETED")])).toEqual({ open: [], dropped: [] });
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const left = blockersLeft\(/);
    expect(src).toMatch(/subIssues\(first:50\)\{nodes\{id number state stateReason/);
  });
  it("a ticket waiting on its blockers loses the label, so it can be started again later", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/if \(skip && unlabel && flag\("--comment"\)\) sh\("gh", \["issue", "edit", String\(n\), "-R", REPO, "--remove-label", TRIGGER_LABEL\]/);
  });
});

describe("a ticket edited by hand", () => {
  const b = split();
  const sealed = (id, blockedBy) => ticketBody({ parent: 406, v: 2, id, spec: ticketSpec(b, b.scope.tickets[0]), blockedBy });
  const edited = sealed("T1", []).replace("criterion 1", "criterion 1, reworded");
  const issue = (number, body, state = "OPEN", stateReason = null, labels = []) => ({ number, state, stateReason, labels, head: ticketHeader(body), ticket: parseTicket(body) });
  it("is no longer built as approved, but is still the plan's ticket", () => {
    expect(parseTicket(edited)).toBeUndefined();
    expect(ticketHeader(edited)).toEqual({ parent: 406, v: 2, id: "T1" });
    expect(ticketHeader("an ordinary issue")).toBeUndefined();
  });
  it("blocks what the plan put after it until it is completed, and is never started itself", () => {
    const dep = sealed("T2", [410]);
    const open = planProgress([issue(410, edited), issue(411, dep)], { parent: 406, v: 2 });
    expect(open.start).toEqual([]);
    expect(open.open.map((t) => t.number)).toEqual([410, 411]);
    const done = planProgress([issue(410, edited, "CLOSED", "COMPLETED"), issue(411, dep)], { parent: 406, v: 2 });
    expect(done.start.map((t) => t.number)).toEqual([411]);
  });
  it("keeps the plan open while it is open, and is named if it is dropped", () => {
    const p = planProgress([issue(410, edited), issue(411, sealed("T2", []), "CLOSED", "COMPLETED")], { parent: 406, v: 2 });
    expect(p.open.map((t) => t.number)).toEqual([410]);
    const all = planProgress([issue(410, edited, "CLOSED", "NOT_PLANNED"), issue(411, sealed("T2", []), "CLOSED", "COMPLETED")], { parent: 406, v: 2 });
    expect(all.open).toEqual([]);
    expect(all.dropped.map((t) => t.number)).toEqual([410]);
  });
  it("leaves out another version's tickets", () => {
    const old = ticketBody({ parent: 406, v: 1, id: "T1", spec: ticketSpec(b, b.scope.tickets[0]), blockedBy: [] });
    expect(planProgress([issue(400, old)], { parent: 406, v: 2 }).plan).toEqual([]);
  });
  it("keeps its words when the github-actions app opened it (only write access can edit it)", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const editedTicket = !ticket && isLoopAuthor\(i\.author, trusted\) && Boolean\(ticketHeader\(i\.body\)\);/);
  });
});

describe("a ticket that can't be linked to its plan", () => {
  it("is closed and the split fails, rather than becoming a ticket nothing can find", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function publishSplit("), src.indexOf("function unblock("));
    expect(fn).not.toMatch(/sub_issues`, "-F", `sub_issue_id=\$\{id\}`\], \{ allowFail: true \}\);\n\s*numbers\.set/);
    expect(fn).toMatch(/if \(link\.code !== 0\) \{[\s\S]*?"issue", "close"[\s\S]*?throw new Error/);
  });
});

describe("a single brief approved past the limits", () => {
  it("is past the limits by criteria or by files", () => {
    const many = Array.from({ length: SCOPE_LIMITS.criteria + 1 }, (_, i) => ({ id: `AC${i + 1}` }));
    expect(pastLimits({ acceptance_criteria: many })).toBe(true);
    expect(pastLimits({ files_likely: Array.from({ length: SCOPE_LIMITS.files + 1 }, (_, i) => `f${i}`) })).toBe(true);
    expect(pastLimits(split())).toBe(false);
  });
  it("opens its PR with the scope waiver, read from the approved brief on the issue", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const briefs = PAUSE \? briefState\(issueComments\(n\), trusted\) : undefined;/);
    expect(src).toMatch(/const waived = Boolean\(briefs\?\.latest\) && !briefs\.latestEdited && !isSplit\(briefs\.latest\.brief\) && pastLimits\(briefs\.latest\.brief\);/);
    expect(src).toMatch(/\.\.\.\(waived \? \["--label", SCOPE_WAIVER\] : \[\]\)/);
    expect(src).toMatch(/const SCOPE_WAIVER = "scope:approved"/);
  });
});

describe("approving a split is re-checked where it is published", () => {
  it("re-reads the brief, refuses an unapproved or broken plan, and never adds the approval label", () => {
    const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function publishSplit("), src.indexOf("function unblock("));
    expect(fn).toMatch(/approvalRefusal\(state\)/);
    expect(fn).toMatch(/scopeProblems\(brief\)/);
    expect(fn).not.toMatch(/--add-label", LABELS\.approved/);
  });
});
