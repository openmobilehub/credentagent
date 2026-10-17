// The brief's card: five lines a maintainer reads before approving a problem and its fix
// (README.md, "The brief"). The rules a script can check without a model live here, so the agents
// rewrite a card until it passes and the publish job re-checks it before posting.
//
// The card describes what a person sees, not what the code does. Everything technical — commands,
// file names, function names, issue numbers — goes below the divider, where reviewers look for it.

/** How bad, as one word. The brief prompt gives the agents the same definitions. */
export const LEVELS = {
  unsafe: "Unsafe", // a proof, consent or amount check can be skipped; wallet data is exposed; or the person is shown something other than what happens
  broken: "Broken", // something correct fails
  awkward: "Awkward", // it works, with extra steps or guessing
  internal: "Internal", // no user notices
};
export const DIRECTIONS = { "lets-through": "lets something through", "fails-safe": "fails safe", none: "nothing gets through or fails" };
export const LIVE = { release: "a published release", "hosted-demo": "a hosted demo", "main-only": "main only (unreleased)", nowhere: "not live anywhere" };

/** Unsafe and reachable by someone today: SECURITY.md says it is reported privately, never in a public brief. */
export const isPrivate = (card) => card?.how_bad?.level === "unsafe" && ["release", "hosted-demo"].includes(card?.how_bad?.live);

// Words a card may use although they look like code: everyday acronyms and product names.
const ACRONYMS = new Set(["AI", "API", "ID", "IDs", "OK", "USD", "EUR", "GBP", "URL", "URLs", "PIN", "QR", "SMS", "HTTP", "HTTPS", "UI", "FAQ"]);
const MIXED_CASE = new Set(["GitHub", "iPhone", "iOS", "macOS", "ChatGPT", "OpenAI", "JavaScript", "TypeScript", "WhatsApp", "YouTube", "PayPal", "CredentAgent", "OpenWallet", "npm"]);

// Each rule: what a reader would trip over, and how to find it. URLs are stripped first.
const RULES = [
  [/`/, "code formatting (backticks)"],
  [/(?:^|\s)(?:[\w.-]*[A-Za-z][\w.-]*\/)+[\w.-]*\.(?:[cm]?[jt]sx?|json|ya?ml|md|sh|html?)\b/, "a file path"],
  [/(?:^|[^\w&])#\d+\b/, "an issue or PR number (#123) — say what it is instead"],
  [/§\s*\d|\binvariant\s*#?\d|\b(?:FR|AC|NFR)-?\d+\b|\bprinciple\s+[IVX\d]+\b/i, "a rule number (§5, invariant 3, FR-14) — say what the rule is"],
  [/\b[A-Za-z_$][\w$]*\(\)/, "a function name"],
  [/\b[a-z]+_[a-z0-9_]+\b/, "a snake_case name from the code"],
];
const OVERCLAIM = /\b(?:safe(?:ly)?|secure(?:ly|d)?|guarantee[sd]?|fully fixed|verified credentials?|trusted credentials?|proves? (?:the person'?s? )?(?:age|identity))\b/i;
const UNDERSTATE = /\b(?:known demo behaviou?r|just a demo|only a demo|none known)\b/i;

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
const sentences = (s) => String(s ?? "").split(/(?<=[.!?])\s+(?=[A-Z"“(])/).map((x) => x.trim()).filter(Boolean);

/** What a reader would trip over in one piece of card text: [] when it reads plainly. */
export function textProblems(text) {
  const plain = String(text ?? "").replace(/https?:\/\/\S+/g, " ");
  const found = [];
  for (const [re, what] of RULES) {
    const m = plain.match(re);
    if (m) found.push(`${what}: "${m[0].trim()}"`);
  }
  for (const m of plain.matchAll(/\b[A-Za-z]*[a-z][A-Za-z]*[A-Z][A-Za-z]*\b/g)) {
    if (!MIXED_CASE.has(m[0])) { found.push(`a name from the code: "${m[0]}"`); break; }
  }
  for (const m of plain.matchAll(/\b[A-Z][A-Z0-9]{1,6}s?\b/g)) {
    if (!ACRONYMS.has(m[0])) { found.push(`an unexplained abbreviation: "${m[0]}" — spell it out`); break; }
  }
  const over = plain.replace(/\bfails? safe\b/gi, "").match(OVERCLAIM);
  if (over) found.push(`a word that claims more than the gate checks: "${over[0]}" — say what is refused instead`);
  const under = plain.match(UNDERSTATE);
  if (under) found.push(`a phrase that plays the problem down: "${under[0]}"`);
  for (const s of sentences(plain)) if (words(s) > 30) { found.push(`a sentence of ${words(s)} words (at most 30): "${s.slice(0, 60)}…"`); break; }
  return found;
}

// The card's lines, in order, as the brief shows them.
export const FIELDS = [
  ["whats_wrong", "What's wrong"],
  ["fix", "The fix"],
  ["approving", "What you're approving"],
  ["check", "How you'll know it's fixed"],
];
const MAX_WORDS = 170; // the whole card, options included

/**
 * Every problem with a card, for the agent to fix: [] when it passes. `card` is the brief's `card`;
 * `criteria` its acceptance criteria (a behavior change needs one checked by a test).
 */
export function cardProblems(card, { criteria = [], behaviorChange = true } = {}) {
  if (!card || typeof card !== "object") return ["there is no card"];
  const out = [];
  const say = (field, problems) => problems.forEach((p) => out.push(`${field}: ${p}`));
  for (const [key, label] of FIELDS) {
    const text = String(card[key] ?? "").trim();
    if (!text) { out.push(`${label}: empty`); continue; }
    if (sentences(text).length > 2) out.push(`${label}: ${sentences(text).length} sentences (at most 2)`);
    say(label, textProblems(text));
  }
  const hb = card.how_bad ?? {};
  if (!LEVELS[hb.level]) out.push(`How bad: the level must be one of ${Object.keys(LEVELS).join(", ")}`);
  if (!DIRECTIONS[hb.direction]) out.push(`How bad: the direction must be one of ${Object.keys(DIRECTIONS).join(", ")}`);
  if (!LIVE[hb.live]) out.push(`How bad: "live" must be one of ${Object.keys(LIVE).join(", ")}`);
  if (hb.level === "unsafe" && hb.direction === "fails-safe") out.push("How bad: Unsafe and \"fails safe\" contradict each other");
  for (const key of ["live_detail", "who"]) {
    if (!String(hb[key] ?? "").trim()) out.push(`How bad: ${key === "who" ? "who is affected" : "where it is live"} is empty`);
    else say(`How bad (${key === "who" ? "who" : "where"})`, textProblems(hb[key]));
  }
  const options = card.options ?? [];
  if (options.length === 1) out.push("Options: one option is not a choice — put it in The fix, or offer at least two (one can be leaving it as is)");
  if (options.length > 1) {
    if (!options.some((o) => o.id === card.recommended)) out.push(`Options: "recommended" must name one of ${options.map((o) => o.id).join(", ")}`);
    for (const o of options) say(`Option ${o.id}`, textProblems(`${o.summary ?? ""} ${o.worst_case ?? ""}`));
  }
  const total = [...FIELDS.map(([k]) => card[k]), hb.live_detail, hb.who, ...options.flatMap((o) => [o.summary, o.worst_case])].reduce((n, s) => n + words(s), 0);
  if (total > MAX_WORDS) out.push(`the card is ${total} words (at most ${MAX_WORDS}) — move detail below the divider`);
  if (!criteria.length) out.push("acceptance criteria: none");
  if (behaviorChange && !criteria.some((c) => c.verified_by === "test")) out.push("acceptance criteria: a behavior change needs at least one criterion checked by a test");
  return out;
}

/** How bad, as one line: "Broken · fails safe · Live in: npm 0.5.x · Who: stores upgrading". */
export const howBadLine = (hb) => `${LEVELS[hb?.level] ?? "?"} · ${DIRECTIONS[hb?.direction] ?? "?"} · Live in: ${hb?.live_detail ?? "?"} · Who: ${hb?.who ?? "?"}`;
