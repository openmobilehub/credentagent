// The brief: what the agents post on the issue before they write any code (README.md, "The brief").
// They reproduce the problem, weigh the ways to fix it, and write it up as a card a maintainer can
// approve — or answer in a comment, which gets a new version. Nothing is implemented until a person
// adds `agent:approved` to the latest version.
//
// The brief travels inside its own comment: the visible text, the same brief as data in the marker,
// and a hash over both. Approval checks the hash, so what is implemented is exactly what the
// maintainer read — a comment edited by hand no longer matches, and is refused. (A hash, not a
// re-render: a later change to the wording here must not invalidate the briefs already waiting.)

import { createHash } from "node:crypto";
import { isAgentComment, isLoopAuthor } from "./checks.mjs";
import { FIELDS, howBadLine, LEVELS } from "./card.mjs";
import { md } from "./report.mjs";

export const BRIEF_MARK = "<!-- issue-agent-brief";
export const REPLY_MARK = "<!-- issue-agent-reply";
export const LABEL_AWAITING = "agent:awaiting-approval";
export const LABEL_APPROVED = "agent:approved";
const MARKER = /^<!-- issue-agent-brief v=(\d+) sha=([0-9a-f]{64}) data=([A-Za-z0-9+/=]+) -->\n/;

const encode = (data) => Buffer.from(JSON.stringify(data), "utf8").toString("base64");
const seal = (encoded, visible) => createHash("sha256").update(`${encoded}\n${visible}`).digest("hex");

// GitHub refuses a comment over 65,536 characters, and the data is in the comment twice over (as text
// and as base64): every field the agents wrote is capped before it is rendered or encoded.
const CAPS = { result: 3000, how: 1200, field: 1200, item: 400, items: 15 };
const cap = (s, n = CAPS.field) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)} … [cut]` : t; };
export function clampBrief(b) {
  const card = b.card ?? {};
  const list = (xs, n = CAPS.items) => (Array.isArray(xs) ? xs.slice(0, n) : []);
  return {
    ...b,
    blocker: b.blocker === undefined ? undefined : cap(b.blocker),
    reproduced: { confirmed: b.reproduced?.confirmed, how: cap(b.reproduced?.how, CAPS.how), result: cap(b.reproduced?.result, CAPS.result) },
    card: {
      whats_wrong: cap(card.whats_wrong), fix: cap(card.fix), approving: cap(card.approving), check: cap(card.check),
      how_bad: { level: card.how_bad?.level, direction: card.how_bad?.direction, live: card.how_bad?.live, live_detail: cap(card.how_bad?.live_detail, CAPS.item), who: cap(card.how_bad?.who, CAPS.item) },
      options: list(card.options, 3).map((o) => ({ id: o.id, summary: cap(o.summary, CAPS.item), worst_case: cap(o.worst_case, CAPS.item), ...(o.size ? { size: cap(o.size, CAPS.item) } : {}) })),
      ...(card.recommended ? { recommended: cap(card.recommended, 4) } : {}),
    },
    acceptance_criteria: list(b.acceptance_criteria).map((c) => ({ id: cap(c.id, 8), text: cap(c.text, CAPS.item), verified_by: c.verified_by })),
    not_in_scope: list(b.not_in_scope).map((x) => cap(x, CAPS.item)),
    evidence_plan: cap(b.evidence_plan), test_plan: cap(b.test_plan),
    files_likely: list(b.files_likely).map((x) => cap(x, CAPS.item)),
    reply: b.reply === undefined ? undefined : cap(b.reply, 2000),
    changes_since_previous: b.changes_since_previous === undefined ? undefined : cap(b.changes_since_previous, CAPS.item),
  };
}
const oneLine = (s) => md(String(s ?? "").replace(/[\r\n]+/g, " ").trim());

/** The card alone, as plain text: what the agents show the maintainer, and what they quote back to themselves. */
export function cardText(brief) {
  const c = brief.card;
  const options = (c.options ?? []).length > 1
    ? c.options.map((o) => `- **${oneLine(o.id)}${o.id === c.recommended ? " (recommended)" : ""}:** ${oneLine(o.summary)} _Worst case:_ ${oneLine(o.worst_case)}${o.size ? ` _Size:_ ${oneLine(o.size)}` : ""}`).join("\n")
    : "";
  return [
    `**${FIELDS[0][1]}:** ${oneLine(c.whats_wrong)}`,
    `**How bad:** ${oneLine(howBadLine(c.how_bad))}`,
    options ? `**Options:**\n${options}\n\n**The fix we recommend (${oneLine(c.recommended)}):** ${oneLine(c.fix)}` : `**${FIELDS[1][1]}:** ${oneLine(c.fix)}`,
    `**${FIELDS[2][1]}:** ${oneLine(c.approving)}`,
    `**${FIELDS[3][1]}:** ${oneLine(c.check)}`,
  ].join("\n\n");
}

const TAG = { test: "a test", evidence: "screenshots", review: "a reviewer", "after-merge": "you, after it merges" };

/**
 * The brief comment, from its data. `data`: { v, start, asOf, brief, base, lintProblems?, discussUrl? }
 * — `start`: the first version of this round (re-adding `agent` starts a new one); `asOf`: when the
 * run read the issue (a comment after it is still unanswered). Every word the agents wrote goes
 * through md(); the shape is fixed here.
 */
export function briefBody(data) {
  const visible = briefText(data);
  const encoded = encode(data);
  return `${BRIEF_MARK} v=${data.v} sha=${seal(encoded, visible)} data=${encoded} -->\n${visible}`;
}

function briefText(data) {
  const { v, brief, base, lintProblems = [], discussUrl } = data;
  const levelWord = LEVELS[brief.card?.how_bad?.level] ?? "?";
  const pick = (brief.card.options ?? []).length > 1 ? ` — that approves option ${oneLine(brief.card.recommended)}, the recommended one; to pick another, say so in a comment` : "";
  const repro = brief.reproduced ?? {};
  return `🤖 **Brief v${v} · ${levelWord} · waiting for your approval.** Nothing is built until you approve it.${
  brief.reply ? `\n\n**Re your comment:** ${md(brief.reply)}` : ""}${
  v > 1 && brief.changes_since_previous ? `\n\n**Changed since v${v - 1}:** ${oneLine(brief.changes_since_previous)}` : ""}

${cardText(brief)}
${lintProblems.length ? `\n> [!WARNING]\n> The plain-language check still flags: ${lintProblems.map(oneLine).join("; ")}. Say what's unclear and the next version fixes it.\n` : ""}
**Your move:** add the \`${LABEL_APPROVED}\` label to approve **this version**${pick}. Something off, or a question? Reply here in your own words — the agents answer, and post a new version if anything changes.${discussUrl ? ` Or [talk it through live](${discussUrl}).` : ""}

---

### Reproduced on main${base ? ` (${String(base).slice(0, 7)})` : ""}: ${{ yes: "yes", no: "**no**", "not-applicable": "not applicable" }[repro.confirmed] ?? "?"}

${md(repro.how ?? "")}

\`\`\`text
${String(repro.result ?? "").replace(/```/g, "'''").slice(0, 4000)}
\`\`\`

### Acceptance criteria — the contract the agents are checked against

${(brief.acceptance_criteria ?? []).map((c) => `- [ ] **${oneLine(c.id)}** ${oneLine(c.text)} _(checked by ${TAG[c.verified_by] ?? "?"})_`).join("\n")}

### Not in scope

${(brief.not_in_scope ?? []).length ? brief.not_in_scope.map((s) => `- ${oneLine(s)}`).join("\n") : "- nothing called out"}

<details><summary>The agents' plan (tests, evidence, likely files)</summary>

- **Changes behaviour:** ${brief.behavior_change ? "yes — so a test must fail without the fix" : "no (docs or refactor only)"} · **Shows in a browser:** ${brief.touches_ui ? "yes — before/after screenshots" : "no"}
- **Tests:** ${oneLine(brief.test_plan)}
- **Evidence:** ${oneLine(brief.evidence_plan)}
- **Likely files:** ${(brief.files_likely ?? []).map(oneLine).join(", ") || "—"}
</details>
`;
}

/** A reply that leaves the brief as it is: the agents' answer to a question. */
export const replyBody = ({ v, reply, asOf }) =>
  `${REPLY_MARK} v=${v} asof=${asOf} -->\n🤖 ${md(reply)}\n\nThe brief (v${v}) is unchanged — add \`${LABEL_APPROVED}\` to approve it, or reply again.`;

/** The implementer questions a criterion of the approved brief: nothing is built until it's settled. */
export const challengeBody = ({ v, criterion, why, asOf }) =>
  `${REPLY_MARK} v=${v} asof=${asOf} challenge -->\n🤖 **Nothing was built: before starting, the agents question part of brief v${v}.**\n\n> **${md(criterion)}:** ${md(why)}\n\nReply to settle it — the agents answer, and post a new version if the brief changes. Then approve that one.`;

/**
 * The brief in a comment, or undefined when it isn't one: the marker's data must render to exactly
 * the comment's text, so a comment edited after it was posted is not a brief any more.
 */
export function parseBrief(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const m = text.match(MARKER);
  if (!m) return undefined;
  const visible = text.slice(m[0].length);
  if (seal(m[3], visible) !== m[2] && seal(m[3], `${visible.trimEnd()}\n`) !== m[2]) return undefined;
  let data;
  try { data = JSON.parse(Buffer.from(m[3], "base64").toString("utf8")); } catch { return undefined; }
  if (!data || data.v !== Number(m[1]) || !data.brief?.card) return undefined;
  return data;
}

// When the agents last answered: the time their run read the issue (in the marker), not when the
// comment was posted — a comment written while they worked is still waiting for them.
const answeredAt = (c) => {
  const brief = String(c.body).startsWith(`${BRIEF_MARK} `) ? parseBrief(c.body) : undefined;
  const asOf = brief?.asOf ?? String(c.body).match(/^<!-- issue-agent-reply v=\d+ asof=(\S+)/)?.[1];
  const t = Date.parse(asOf);
  return Number.isFinite(t) ? Math.min(t, Date.parse(c.createdAt)) : Date.parse(c.createdAt);
};

const at = (c) => Math.max(Date.parse(c.createdAt), c.lastEditedAt ? Date.parse(c.lastEditedAt) : 0);

/**
 * Where the conversation on an issue stands. `comments` (oldest first): { author: { login,
 * __typename }, body, createdAt, lastEditedAt }. Only the pipeline's own comments count as the agents'
 * (isLoopAuthor: the workflow's bot, or the token's write-access user — with the marker); only a
 * write-access person's unmarked comments count as the maintainer's.
 */
export function briefState(comments, isTrusted) {
  const ours = comments.filter((c) => isLoopAuthor(c.author, isTrusted) && (String(c.body).startsWith(`${BRIEF_MARK} `) || String(c.body).startsWith(`${REPLY_MARK} `)));
  const briefs = ours.filter((c) => String(c.body).startsWith(`${BRIEF_MARK} `));
  const latestComment = briefs.at(-1);
  const people = comments.filter((c) => !isAgentComment(c.body) && isTrusted(c.author?.login));
  const lastOurs = Math.max(0, ...ours.map(answeredAt));
  const lastPerson = Math.max(0, ...people.map(at));
  const latest = latestComment ? parseBrief(latestComment.body) : undefined;
  return {
    versions: briefs.length,
    // Versions since `agent` was last (re-)added: re-labelling starts over.
    round: latest ? latest.v - (latest.start ?? 1) + 1 : briefs.length,
    latest,
    latestEdited: Boolean(latestComment) && !parseBrief(latestComment.body),
    latestAt: latestComment?.createdAt,
    firstAt: briefs[0]?.createdAt,
    // The talk about this round starts at its first brief.
    roundStart: latest?.start ?? 1,
    // A person wrote (or edited a comment) after the agents last answered: they owe a reply.
    unanswered: briefs.length > 0 && lastPerson > lastOurs,
    lastPersonAt: lastPerson,
    // The pipeline's last notice (a skip, an error, "not actionable"): a run saw the comments before it,
    // so the hourly check doesn't start another for them.
    lastNoticeAt: Math.max(0, ...comments.filter((c) => /^<!-- issue-agent -->/.test(String(c.body)) && isLoopAuthor(c.author, isTrusted)).map((c) => Date.parse(c.createdAt))),
  };
}

/** Why `agent:approved` can't start the build now, or undefined when it can. */
export function approvalRefusal(state, { issueEditedAt } = {}) {
  if (!state.versions) return "there is no brief to approve yet — add the `agent` label first, and the agents post one";
  if (state.latestEdited) return "the latest brief was edited by hand, so it's no longer what the agents wrote. Say what should change in a comment and they post a new version";
  if (!state.latest) return "the latest brief can't be read";
  if (state.unanswered) return "the agents haven't answered your latest comment yet. Approve the version they post next";
  if (issueEditedAt && Date.parse(issueEditedAt) > Date.parse(state.latestAt)) return "the issue was edited after the latest brief. Comment to get a brief for the current text";
  return undefined;
}

/**
 * The comments before the first brief (the request) and the conversation since, oldest first: the
 * maintainers' words up to `snapshotAt`, and the agents' own briefs and replies — told apart by the
 * marker AND the author (`isOurs`), so an outsider can't plant words for either side.
 */
export function splitConversation(comments, { isTrusted, isOurs, snapshotAt, fromVersion = 1 }) {
  const ours = (c) => isOurs(c.author) && (String(c.body).startsWith(`${BRIEF_MARK} `) || String(c.body).startsWith(`${REPLY_MARK} `));
  const first = comments.findIndex((c) => ours(c) && String(c.body).startsWith(`${BRIEF_MARK} v=${fromVersion} `));
  if (first < 0) return { before: comments, conversation: [] };
  const conversation = [];
  for (const c of comments.slice(first)) {
    if (ours(c)) {
      const brief = parseBrief(c.body);
      if (brief) conversation.push({ by: "agents", body: `(brief v${brief.v})${brief.brief.reply ? `\n${brief.brief.reply}` : ""}\n${cardText(brief.brief)}` });
      else if (String(c.body).startsWith(`${REPLY_MARK} `)) conversation.push({ by: "agents", body: String(c.body).split("\n").slice(1).join("\n") });
    } else if (!isAgentComment(c.body) && isTrusted(c.author?.login) && at(c) <= Date.parse(snapshotAt)) {
      conversation.push({ by: "maintainer", author: c.author.login, body: c.body });
    }
  }
  return { before: comments.slice(0, first), conversation };
}

export const MAX_BRIEFS = 6;

/**
 * What a trigger starts: `brief` (write or revise the brief), `implement`, or a skip. `quiet` skips
 * say nothing on the issue (a comment that isn't for the agents). Without `brief: "pause"` in the
 * repo's config, everything runs as before: the label starts the build.
 */
export function planRun({ trigger = "label:agent", pause, labels = [], state, issueEditedAt }) {
  if (!pause) {
    if (trigger === "label:agent" || trigger === "dispatch") return { phase: "implement" };
    return { skip: "briefs are off for this repo", quiet: true };
  }
  if (trigger === "label:agent" || trigger === "dispatch") return { phase: "brief" };
  if (trigger === `label:${LABEL_APPROVED}`) {
    const refusal = approvalRefusal(state, { issueEditedAt });
    if (refusal) return { skip: `not starting the build — ${refusal}` };
    if (!state.latest.brief.actionable) return { skip: "not starting the build — the latest brief says this isn't actionable" };
    return { phase: "implement", brief: state.latest };
  }
  if (trigger === "comment") {
    if (!labels.includes(LABEL_AWAITING)) return { skip: "no brief is waiting for approval", quiet: true };
    if (!state.unanswered) return { skip: "every comment is already answered", quiet: true };
    if (state.round >= MAX_BRIEFS) return { skip: `this has gone through ${state.round} versions of the brief. Approve the latest with \`${LABEL_APPROVED}\`, talk it through live, or remove and re-add the \`agent\` label to start over` };
    return { phase: "brief" };
  }
  return { skip: `unknown trigger "${trigger}"`, quiet: true };
}

/**
 * The approved brief as the spec the implementation is checked against: its criteria word for word
 * (those only a person can check after the merge are listed for them, not given to the reviewers).
 */
export function specFromBrief(brief) {
  const criteria = brief.acceptance_criteria ?? [];
  return {
    actionable: true,
    summary: `${brief.card.whats_wrong} ${brief.card.fix}`,
    acceptance_criteria: criteria.filter((c) => c.verified_by !== "after-merge"),
    after_merge: criteria.filter((c) => c.verified_by === "after-merge"),
    not_in_scope: brief.not_in_scope ?? [],
    behavior_change: brief.behavior_change,
    touches_ui: brief.touches_ui,
    evidence_plan: brief.evidence_plan,
    test_plan: brief.test_plan,
    files_likely: brief.files_likely ?? [],
  };
}
