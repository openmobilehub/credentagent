// The brief: what the agents post on the issue before they write any code (README.md, "The brief").
// They reproduce the problem, weigh the ways to fix it, and write it up as a card a maintainer can
// approve — or answer in a comment, which gets a new version. Nothing is implemented until a person
// adds `agent:approved` to the latest version.
//
// The brief travels inside its own comment: the visible text, and the same brief as data in the
// marker. Approval re-renders the data and compares it with the comment, so what is implemented is
// exactly what the maintainer read — an edited comment no longer matches, and is refused.

import { isAgentComment, isLoopAuthor } from "./checks.mjs";
import { FIELDS, howBadLine, LEVELS } from "./card.mjs";
import { md } from "./report.mjs";

export const BRIEF_MARK = "<!-- issue-agent-brief";
export const REPLY_MARK = "<!-- issue-agent-reply";
export const LABEL_AWAITING = "agent:awaiting-approval";
export const LABEL_APPROVED = "agent:approved";
const MARKER = /^<!-- issue-agent-brief v=(\d+) data=([A-Za-z0-9+/=]+) -->\n/;

const encode = (data) => Buffer.from(JSON.stringify(data), "utf8").toString("base64");
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
 * The brief comment, from its data. `data`: { v, brief, base, lintProblems?, discussUrl? }. Every word
 * the agents wrote goes through md(); the shape is fixed here.
 */
export function briefBody(data) {
  const { v, brief, base, lintProblems = [], discussUrl } = data;
  const levelWord = LEVELS[brief.card?.how_bad?.level] ?? "?";
  const pick = (brief.card.options ?? []).length > 1 ? ` — that approves option ${oneLine(brief.card.recommended)}, the recommended one; to pick another, say so in a comment` : "";
  const repro = brief.reproduced ?? {};
  return `${BRIEF_MARK} v=${v} data=${encode(data)} -->
🤖 **Brief v${v} · ${levelWord} · waiting for your approval.** Nothing is built until you approve it.${
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

- **Tests:** ${oneLine(brief.test_plan)}
- **Evidence:** ${oneLine(brief.evidence_plan)}
- **Likely files:** ${(brief.files_likely ?? []).map(oneLine).join(", ") || "—"}
</details>
`;
}

/** A reply that leaves the brief as it is: the agents' answer to a question. */
export const replyBody = ({ v, reply }) =>
  `${REPLY_MARK} v=${v} -->\n🤖 ${md(reply)}\n\nThe brief (v${v}) is unchanged — add \`${LABEL_APPROVED}\` to approve it, or reply again.`;

/** The implementer questions a criterion of the approved brief: nothing is built until it's settled. */
export const challengeBody = ({ v, criterion, why }) =>
  `${REPLY_MARK} v=${v} challenge -->\n🤖 **Nothing was built: before starting, the agents question part of brief v${v}.**\n\n> **${md(criterion)}:** ${md(why)}\n\nReply to settle it — the agents answer, and post a new version if the brief changes. Then approve that one.`;

/**
 * The brief in a comment, or undefined when it isn't one: the marker's data must render to exactly
 * the comment's text, so a comment edited after it was posted is not a brief any more.
 */
export function parseBrief(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const m = text.match(MARKER);
  if (!m) return undefined;
  let data;
  try { data = JSON.parse(Buffer.from(m[2], "base64").toString("utf8")); } catch { return undefined; }
  if (!data || data.v !== Number(m[1]) || !data.brief?.card) return undefined;
  try { return briefBody(data).trimEnd() === text.trimEnd() ? data : undefined; } catch { return undefined; }
}

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
  const lastOurs = Math.max(0, ...ours.map((c) => Date.parse(c.createdAt)));
  const lastPerson = Math.max(0, ...people.map(at));
  return {
    versions: briefs.length,
    latest: latestComment ? parseBrief(latestComment.body) : undefined,
    latestEdited: Boolean(latestComment) && !parseBrief(latestComment.body),
    latestAt: latestComment?.createdAt,
    firstAt: briefs[0]?.createdAt,
    // A person wrote (or edited a comment) after the agents last answered: they owe a reply.
    unanswered: briefs.length > 0 && lastPerson > lastOurs,
    lastPersonAt: lastPerson,
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
export function splitConversation(comments, { isTrusted, isOurs, snapshotAt }) {
  const ours = (c) => isOurs(c.author) && (String(c.body).startsWith(`${BRIEF_MARK} `) || String(c.body).startsWith(`${REPLY_MARK} `));
  const first = comments.findIndex((c) => ours(c) && String(c.body).startsWith(`${BRIEF_MARK} `));
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
    if (state.versions >= MAX_BRIEFS) return { skip: `this has gone through ${state.versions} versions of the brief. Approve the latest with \`${LABEL_APPROVED}\`, talk it through live, or remove and re-add the \`agent\` label to start over` };
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
