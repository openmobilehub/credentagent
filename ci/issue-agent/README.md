# Issue agent

Label an issue **`agent`** and agents implement it, then open a **draft PR** that carries its own
proof: acceptance criteria checked off, the pipeline's own test runs, three independent reviews,
and before/after **screenshots and video** recorded in a real browser.

One way in, one way out — the shape of Stripe's "minions": a person states what they want where
they already work (a GitHub issue), the agents work unattended in an isolated checkout, and what
comes back is an ordinary PR a human reviews and merges. The agent never merges; branch protection
still needs a human approval and every review thread resolved.

## The pipeline

```
issue labelled `agent` (by someone with write access)
  │
  ├─ snapshot    preflight: open? not needs-decision / epic / wontfix? not assigned to       (script)
  │              someone else? no open PR for it?
  │              freeze the request: only text by people with write access, as of the label
  │                └─ skipped → a comment on the issue says why
  ├─ spec        reads the request + code → acceptance criteria, or "not actionable"       (agent)
  ├─ implement   failing test first, then the fix                                          (agent)
  ├─ gates       build · typecheck · lint · tests of what changed, vs main's own failures  (script)
  ├─ mutation    revert the source change → the changed tests must FAIL; restore → pass     (script)
  ├─ root test   once per round: the authoritative root `npm test`                         (script)
  ├─ review      spec · security · DX, in parallel, adversarial, on REVIEW.md              (3 agents)
  │                └─ any red above → back to the SAME implement session (≤3 review rounds;
  │                   mechanical failures get up to 3 fixes inside a round)
  ├─ freeze      the reviewed change is saved as a patch — the only thing ever published   (script)
  ├─ evidence    anything browser-visible: before (main) vs after, screenshots + video     (agent)
  │              every change: a recorded test-proof page                                  (script)
  └─ publish     the patch on a clean checkout · one DCO-signed commit · draft PR · comment (script)
```

The script checks; the agents do. What an agent *claims* is re-checked mechanically or by a
different agent before it reaches the PR:

- **Gates** run from the repo root. Failures are compared against a baseline of `main`'s own, **by
  count**: a red `main` isn't charged to the change, and the change can't add even one more failure
  of a kind `main` already has. The baseline is measured once per commit **per process**: a local run
  that works through several issues (`--poll`, or `run.mjs 286 287`) reuses it for a later issue on
  the same `main` commit (`run.log` says "reused"). It is kept in memory only, never on disk — the
  agents' code runs unsandboxed between runs, and a file it could write would let one run's code tell
  the next which failures are "main's own". In CI every job starts on a fresh machine and measures
  its own.
- **Fast tests while fixing, the root `npm test` once per round.** Between fix attempts the test gate
  runs only the tests of what changed — each touched workspace (`packages/<name>/`,
  `ci/issue-agent/`) and any changed root-level test file, or every workspace when nothing narrows
  it down — always `npx vitest run --passWithNoTests …` from the repo root, so failure paths match
  the baseline's and a filter that matches nothing isn't a failure. Once those and the mutation check
  pass, the authoritative root `npm test` (CLAUDE.md's verification run) runs once, before the
  reviews; if it fails, the round goes back to fixing and isn't reviewed. The pipeline records the
  exact patch that root run tested. **Publish refuses** to open a change as ready unless a root run
  passed on exactly the patch being published — a fast run never counts — and so does the review
  loop's push. An unfinished change still opens as a `[needs human]` draft (below), and its
  description says the root `npm test` didn't pass on it and which gate stopped the round.
- **The mutation check** enforces CLAUDE.md's "a test that would still pass with the security control
  removed is not a useful test": every changed source file (under `packages/`, `examples/` or
  `ci/issue-agent/`; not tests or docs) is reverted to `main` (new ones deleted),
  the changed test files run, and they must fail. It is per file — a file fails if any test in it
  does — so the reviewers are told to judge each new case on its own.
- **New files count.** They're registered with git (`--intent-to-add`) before every diff, so the
  mutation check, the reviewers and the patch all see them.
- **Reviewers didn't write the code.** They can read, and run the project's checks; whatever their
  runs leave in the tree is thrown away. A criterion with no verdict counts as not met.
- **Reviewers check what the Claude review on GitHub checks.** Every lens carries `REVIEW.md`'s
  rules — the bypass-test question ("which test fails if this line is reverted?"), "fix it or flag
  it", and "stale docs, callers and examples are findings" — so a round on GitHub isn't spent on what
  the internal round could have caught. They get the diff (capped) and the pipeline's measured facts
  in the prompt, rather than spending turns finding them.
- **Two models.** The spec agent and the three reviewers run on `ISSUE_AGENT_REVIEW_MODEL` (faster);
  the implementer — every attempt, and the review loop's fixes — and the evidence agent on
  `ISSUE_AGENT_MODEL`. `report.json` records the model each role used (`models`). The final check, the
  Claude review on GitHub, is unchanged.
- **No second install for "before".** The evidence step's checkout of `main` copies the installed
  dependencies when its `package-lock.json` is identical to the change's, instead of running `npm ci`
  again (`run.log` says so); a different lockfile still gets `npm ci`.
- **Only the reviewed patch is published**, applied to a clean checkout — so nothing the evidence
  agent, a test run or a server leaves behind *in the working tree* can reach the PR. A patch
  touching `.github/` is never pushed. (What the publish job does and doesn't trust is below.)
- **Skills, yes; the rest of `.claude/`, no.** The implementer may edit `.claude/skills/` — skills are
  mostly guidance for agents, like `docs/` or `CLAUDE.md` — through explicit allow rules (`run.mjs`,
  `SKILL_EDITS`), since Claude Code otherwise refuses any write under `.claude/`. A patch touching any
  other `.claude/` path (settings, hooks, agents, commands) is never pushed, like `.github/`: those
  decide what the agents themselves may do (`checks.mjs`, `forbiddenPaths`; matched case-insensitively,
  since `.Claude/Settings.json` lands in `.claude/` on a macOS or Windows checkout). A skill can grant
  tools as well — its frontmatter (`allowed-tools`, `hooks`) and any bundled scripts — so review a
  skill edit as carefully as a settings change. *Not yet confirmed:*
  that an explicit allow rule really lifts Claude Code's `.claude/` protection under the Agent SDK —
  CI can't show it. Check with one local `--no-publish` run on an issue that edits a skill; if the
  edit is still refused, such issues keep ending `[needs human]` (the publish refusal holds either way).
- If the agents don't converge (or a budget runs out, or a reviewer can't finish), the PR still
  opens as `[needs human]` with the open findings (and, when it applies, that the root `npm test`
  never passed on it), or the issue gets a comment saying why.

## The brief — nothing is built until you approve it

With `"brief": "pause"` in `.github/issue-agent.json` (on in this repo; off by default, so another repo
keeps building on the label), the `agent` label doesn't start a build. It starts a **brief**:

```
issue labelled `agent`
  ├─ brief      reproduce the problem on main, for real · how bad is it · 2–3 ways to fix it ·       (agent)
  │             the acceptance criteria · what's NOT in scope
  ├─ check      the card is in plain words (card.mjs) — or the agent rewrites it, twice at most       (script)
  └─ post       the brief as a comment on the issue; label agent:awaiting-approval                    (script)
                  │
       you reply ─┤→ the agents answer (and post v2, v3… if anything changes)   ← back to waiting
                  │
  you add `agent:approved`
  └─ build      the pipeline above, with the approved brief as the spec, word for word
```

**The card** is the top of the brief: five lines for a person who never read the code.

| Line | What it says |
| --- | --- |
| **What's wrong** | one real moment, with real numbers — what a person sees, not what the code does |
| **How bad** | always in this order: **Unsafe / Broken / Awkward / Internal** · lets something through, or fails safe · where it's live · who |
| **The fix** (or **Options** A/B/C with a recommendation) | what people will see afterwards |
| **What you're approving** | what saying yes costs: what changes for current users, the worst case, whether it can be undone |
| **How you'll know it's fixed** | "do X, see Y" — for a safety fix, every bad case refused and the good case still working |

`card.mjs` refuses code formatting, file paths, function names, issue and rule numbers, unexplained
abbreviations, sentences over 30 words, words that claim more than the gate checks ("secure",
"guarantees", "proves age") and phrases that play a problem down ("just a demo", "none known").
Below the divider: what the agent ran to reproduce it and what that printed, the acceptance criteria
(each marked as checked by a test, screenshots, a reviewer, or *you, after it merges*), what's out of
scope, and the agents' plan.

**What you can do with a brief:**

| You want to… | Do this |
| --- | --- |
| approve it | add `agent:approved` — that approves **this version** (with options: the recommended one) |
| pick another option, correct it, ask a question | reply in your own words. The agents answer within minutes; a question gets an answer, anything else gets a new version that opens with "Changed since v1". Older versions fold away |
| give them a fact they couldn't find | paste it; they re-check against the code |
| talk it through properly | the brief's **talk it through live** link (below), if it's set up |
| stop | remove the `agent` label, or close the issue |

**What keeps it honest:**

- **You approve exactly what you read.** The brief's comment carries its own data and a hash over the
  data and the text; approval checks it. A brief edited by hand, a comment you haven't had an answer to
  (including one written while the brief was being prepared), or an issue edited since the brief —
  each refuses the approval and says why.
- **The approved brief is the contract.** Its criteria become the build's checklist word for word
  (after-merge checks go to you in the PR instead). If the implementer thinks one is wrong, it doesn't
  reword it: it stops, says why on the issue, and the brief goes back to waiting for you.
- **Only a person approves.** The pipeline refuses to add `agent:approved` itself (a test pins it).
  Until the agents have their own GitHub identity, their comments appear under the `AGENT_GH_TOKEN`
  user's name; the hidden marker every agent comment starts with is what tells them apart.
- **A security hole is never briefed in public.** When the brief finds something **Unsafe** that a
  release or a hosted demo lets through, nothing about it is posted (SECURITY.md): the issue gets a
  short note to move it to a private advisory, the run keeps only its outcome, and the brief's log
  never reaches the job's public console — a failed run prints only which agent failed and how. The
  stop is decided where the brief is written and again before anything is posted (`briefOutcome`). A
  brief run that fails part-way uploads nothing at all.
- `needs-decision` doesn't stop a brief: approving it *is* the decision.
- Re-adding `agent` starts over: a fresh brief, and a fresh count of versions.

**Replies arrive by themselves.** A comment by a member or collaborator on an issue labelled
`agent:awaiting-approval` starts a run; it waits two minutes first, and a newer comment replaces it, so
three quick comments get one answer (a comment the workflow skips — an outsider's, or the agents' own —
cancels nothing). One gap, until the workflow checks write access before a run joins that queue: an
org member or a read-only collaborator passes the first filter, so their comment can still cancel a
waiting answer before the write-access check refuses it; the hourly check then answers the comment
again. After 6 versions it stops and suggests approving or talking it
through live. Every hour, a check starts a run for any comment whose event was lost (as the workflow's
own bot — allowed for comment runs only, which answer nothing but write-access people's comments). It
skips a comment a run has already seen and said why it stopped; a refused approval doesn't count as
seen (that run never read the comments), and after a failed or cancelled run it tries once more.

### Talking it through live (optional)

Comments are fine for "go with B"; for a real back-and-forth, each brief can carry a **talk it through
live** link that opens a Claude Code session, on the web or in the Claude app, already pointed at the
issue and the brief. It uses a [routine](https://code.claude.com/docs/en/routines) (a research preview
— its API may change):

1. At claude.ai/code/routines, create a routine on this repository with a prompt like: *"A maintainer
   wants to discuss an issue agent's brief. Read the issue and the brief named in the message, reproduce
   anything that's in doubt, then answer their questions. When you agree on a change, post it on the
   issue as a comment in plain words — the issue agent turns that into the next version of the brief."*
2. Add an **API trigger**, generate its token, and store the routine's id (`trig_…`) and the token as the
   repo secrets `ISSUE_AGENT_DISCUSS_ROUTINE` and `ISSUE_AGENT_DISCUSS_TOKEN`.

Each brief then fires the routine once and links the session it returns. Without the secrets (or if the
call fails) the brief just says "reply here". Whatever you agree in the session reaches the agents the
same way as any comment: on the issue.

## Splitting a big issue — one plan, several small PRs

Some issues are several pieces of work wearing one title: a list of purchases, a list of refusals, a
new passkey step and a Revoke button, say. Built as one PR, the design gets decided inside a single
agent session, and the review is too big to hold in your head. So the brief decides the **scope**
first: one pull request, or several.

```
brief      reproduce · criteria · scope: single, or split into a design + tickets           (agent)
  │          the brief agent reads the to-tickets, codebase-design and to-spec skills in
  │          .claude/skills/ (Matt Pocock's, vendored with their licence) and follows them
  ├─ check   the card's plain words (card.mjs) and the plan's shape (scope.mjs)              (script)
you add `agent:approved` to a split brief
  └─ split   open each ticket as a sub-issue of this one, blockers first · label this one   (script)
               `epic` · label `agent` on the tickets nothing blocks
each ticket labelled `agent`
  └─ build   the pipeline above, with the ticket as the approved spec — no second brief
a ticket closes (its PR merged)
  └─ unblock label `agent` on the tickets that were waiting only on it                       (script)
```

**When it splits.** The brief agent splits when the change does more than one thing a person could ship
and check alone, adds a new security mechanism alongside other work, changes stored data that other
stores must hold, or passes 8 acceptance criteria or 12 likely files (`SCOPE_LIMITS`). A brief that
stays single past those limits has to say why in one line, or the check sends it back.

**What a split brief shows.** The card as usual, then *"This is N pieces of work"* with the tickets in
order. Below the divider: **the design** (what is stored and where, the interfaces between tickets, each
security control and its bypass test — the decisions no single ticket may make alone) and a table of
tickets, the criteria each delivers, and what blocks it. `scope.mjs` checks the plan holds together:
every acceptance criterion belongs to exactly one ticket, blockers name real tickets, there is no
cycle, and at least one ticket can start now. A plan that fails it is never split; approval is refused
with the reason.

**Tickets are built as approved.** Each ticket's issue body is the to-tickets template (Parent, What to
build, Acceptance criteria, Blocked by) plus its slice of the approved brief, sealed with a hash like a
brief. Labelled `agent`, a sealed ticket goes straight to the build — you approved the plan once, on
the parent — with only its own criteria as the contract and the other tickets listed as out of scope.
A ticket whose blockers aren't all closed *as completed* is skipped with a notice and loses `agent`,
so `unblock` can label it again when they are. Edit a ticket and the
seal breaks: it becomes an ordinary issue that gets a brief of its own. If the builder challenges a
ticket's criterion, it says so on the ticket, removes `agent` and adds `agent:needs-human`, and nothing
restarts it until you act. There is no brief on a ticket to reply to; instead:

- **change the ticket:** edit it (it gets a brief of its own) and re-add `agent`. It is still the
  plan's ticket: what it blocks starts once it is completed;
- **build it as approved anyway:** say in a comment on the ticket why the criterion stands (comments
  by people with write access reach the builder), then remove `agent:needs-human` and re-add `agent`;
- **change the whole plan:** close the plan's open tickets as *not planned* and their open pull
  requests (an open one names the parent, which stops a new run there), remove `epic` from the
  parent and re-add `agent` there. It gets a new brief; approving that opens a new set of tickets (the
  old ones belong to the old version and are never picked up again).

**Starting the next one.** When a ticket closes, the `unblock` job labels `agent` on the tickets whose
blockers are now all **closed as completed**. A ticket closed as *not planned* or a duplicate was
dropped, not delivered, so what it blocks waits for you. A ticket marked `agent:needs-human`, or
edited by hand, is never picked, but an edited one still counts: what it blocks starts when it is
completed, and the plan isn't finished while it is open. Once the last ticket closes, it comments on the parent, naming any that were dropped (the parent
is left open for you to check its after-merge criteria). Labels added with the default `GITHUB_TOKEN`
start no workflow, so this needs `AGENT_GH_TOKEN`; without it, add `agent` to the next ticket by hand.

**A single brief past the limits.** When you approve a brief that stays one PR past `SCOPE_LIMITS`
(it had to say why it can't be split), its PR is opened with `scope:approved`: your approval is the
size waiver, so the scope check below doesn't refuse it.

**Pull requests from people.** The same bar applies to a PR nobody briefed: `ci/pr-scope/check.mjs`
(the `pr-scope` workflow, and REVIEW.md §8) fails a PR past 400 changed lines or 15 files (docs, specs
and lockfiles not counted) unless it delivers one ticket of a plan — a sub-issue of an `epic` with
several, or a task named in a `specs/…/tasks.md` — or a maintainer adds `scope:approved`. Its comment
says how to split it (CONTRIBUTING.md, "Big changes").

## Before and after — the first thing in every PR

Every agent PR opens with what a developer sees on `main` and with the change, before any prose:

- **A change to a page** (anything a browser shows): the evidence agent's screenshots of each.
- **Anything else:** an **example** — the few lines a developer of the repo would write, using only
  the public API or documented commands (`npm run lint`, an `examples/` script). An agent proposes it
  (starting from the brief's reproduction, when there is one); **the pipeline runs it itself**, in a
  clean checkout of `main` and of the change, credential-free, and shows the code, the command, and
  each side's real output and exit code — plus a side-by-side picture of the same. If both sides print
  the same thing, the PR says so instead of pretending. With nothing a developer would see differently
  (docs only, an internal refactor), it says that in one line. `example.mjs` checks the proposal
  (1–3 files inside the checkout, a command starting with `node`, `npm` or `npx`) and puts each
  checkout back as it was.

The example runs only where briefs are on (`"brief": "pause"`), so another repo's PRs keep today's
shape until it opts in; a page change gets its screenshots first either way. The PR template asks a
human author for the same section.

## Seeing what it's working on

- **On the issue:** one 🤖 status comment, edited in place — the current state on top, a timestamped
  history underneath, each step linking its Actions run: started → PR opened → each review cycle
  (fixing / pushed) → ready for your review, or stopped and why. Edits don't notify anyone; the
  moments that need you (a PR, a hand-over, a stop) still get their own comment.
- **The `agent:working` label** is on an issue from the moment work starts until the PR is handed to
  a human or the run stops — so **`is:open label:agent:working`** lists everything in flight, and
  `label:agent:in-review` lists the PRs still going through the review loop.
- **In Actions,** runs are named `issue-agent #362 · labelled agent · <title>` and
  `issue-agent-review · agent/issue-362-<run>`, so the list reads at a glance (a run for another
  label says so, and is skipped).

The status comment and label are written only by the trusted jobs (the agents' job holds no token),
and only a status comment written by the workflow's bot or a write-access user is ever edited.

## The review loop

With an `AGENT_GH_TOKEN` secret set, a converged change doesn't stop at "draft PR": it opens as a
real PR (labelled **`agent:in-review`**, with a banner saying it isn't ready for a human yet), the
Claude review runs on it, and `.github/workflows/issue-agent-review.yml` takes over after every
review:

```
Claude review finishes on an agent:in-review PR, or the label is added   (or: main moved, and the PR now conflicts with it)
  ├─ assess   read the verdict + the open threads (the review bot's and maintainers' only)    (script)
  │             conflicts with main → fix: merge main, resolve the conflicts (or hand over at the cap)
  │             ✅ Ready to merge, or 💬 with no thread open → verify first:
  │               the spec reviewer checks the issue's acceptance criteria on the final code
  │                 all met → tick the checklist, hand to a human: label agent:ready-for-human,
  │                           request the labeller's review, drop the banner                  ← stop
  │                 some not → fix: make them true (a cycle)
  │             cycle cap reached with 💬 → the same, with the open notes listed               ← stop
  │             cycle cap reached with ⛔ → label agent:needs-human, say why                   ← stop
  ├─ fix      answer every thread — fix it, or decline it with a reason (or resolve a conflict,
  │           or make an unmet criterion true); then the same gates, mutation check (over the
  │           whole PR) and three reviews as the first run                                  (agents)
  └─ push     apply the checked fix to the PR head (fast-forward, no force), reply to every
              thread with the agent's answer and resolve it; if main moved under it and the
              new head conflicts, start a conflict cycle at once                             (script)
                → the push starts the next Claude review → assess again
```

- **A human is asked only at the end** — when the review is satisfied with nothing left open, or
  when the loop stops (cycle cap `ISSUE_AGENT_MAX_REVIEW_CYCLES`, default 2; a budget; a fix that
  doesn't pass its own checks; a change it may not publish; an answer with no code change, which no
  new review would follow). It always says why, on the PR.
- **Same trust split:** assess and push are trusted code; fix runs in a job with no GitHub token.
  Only threads started by the review bot (a GitHub App account, not any user named `claude`) or by
  people with write access are answered, and only their replies are read.
- **Small notes get fixed too — up to the cap.** 💬 with open threads is not "done": the agent
  fixes or answers them. But each review of a fix reads only the new commit and tends to find a
  new, smaller note — on pull request #347 (issue #322's fix) the reviews went ⛔ → 💬 → 💬 → ⛔
  (a line `main` had added was now stale) → 💬, each with fresh small notes — so at the cycle cap
  **💬 counts as ready**: the PR goes to you as `agent:ready-for-human` with the open notes listed
  and linked. **⛔ at the cap never does** — that stops as `agent:needs-human` (as #347 did after
  cycle 3; its fourth cycle was started by hand).
- **Only PRs labelled into the loop, only from this repository.** It acts only on PRs from branches
  in this repository that carry `agent:in-review` (so a PR a human has taken over is left alone),
  and spends no fix session when `AGENT_GH_TOKEN` is missing. Every job checks out `main`'s harness
  code (`run.mjs`), even when started by hand from another branch — but a hand-started run uses
  *that branch's workflow file* (which steps run, where secrets go), so only people with write
  access, who can start runs, can choose it.
- **Any maintainer's PR can join — e.g. one a coding agent opened.** Mark it ready for review and
  add `agent:in-review` (`gh pr edit <n> --add-label agent:in-review`). **Adding the label starts a
  run at once** (`pull_request_target: labeled`, which runs `main`'s copy of the workflow). It
  looks up the latest Claude review of the PR's head and acts on it as that review's own run
  would: fix, verify, or hand over (a head that only merges `main` in reuses the last verdict; a
  failed review goes to a human). If that review is still running, or there is none yet, it waits,
  and the review finishing starts the cycle. Runs for any other label skip in a queue of their own. From then on the loop answers the PR exactly as it does an
  issue agent's. With no issue behind it, the PR's own title and description are the agents'
  request — so both its author and whoever added the label must have write access, or the loop
  refuses it — and a `- [ ] **AC1** …` checklist in the description is checked before hand-over
  like an issue's. The hand-over goes to whoever added the label. The loop never takes a PR whose
  branch is `main`, `agent-evidence` or `release/*`.
- **Never stranded.** A review that fails, or ends with no verdict for the latest commit (paused),
  hands the PR to a human with that reason — and so does a PR still in the loop once
  `AGENT_GH_TOKEN` is gone. A head that only merges `main` in (GitHub's *Update branch*) isn't
  reviewed again — the review skips a push that leaves the PR's diff unchanged — so the last
  verdict still applies.
- **Main is brought in when it matters — and conflicts get resolved, not waited on.** If `main` has
  changed a file the PR also changes, the fix job merges `main` first (the review reads the PR
  merged onto main, so a stale copy of such a file can only be fixed by a merge). A PR that
  *conflicts* with `main` gets no review at all — GitHub runs no `pull_request` workflow on it — so
  the loop doesn't wait for one: on every push to `main` a sweep starts a conflict cycle for each
  `agent:in-review` PR that now conflicts, and the push job does the same if `main` moved while it
  was fixing. In a conflict cycle the agent resolves the conflict markers (keeping both sides'
  intent) through the same gates and reviews; the push job then rebuilds the very same merge commit
  from `main` and the resolved files (`merges.mjs` — only the files git itself says conflict, never
  a forbidden path, never with markers left, never a lost file read as a deletion; tested on a real
  conflict), signed off, and pushes it only if the result is byte-for-byte the tree that was tested.
  A conflict found mid-cycle turns that cycle into a conflict cycle (its review threads wait for the
  next one). At the cycle cap a conflicting PR goes to a human instead.
- **"Ready" means the issue is done, not just that the reviewer is quiet.** Before handing over, the
  spec reviewer checks the PR description's acceptance-criteria checklist (the issue's own, written
  at publish) against the final code, once per head. All met → the boxes are ticked with the
  evidence and an "✔️ Acceptance criteria checked on the final code (<sha>)" comment is left; any
  unmet → a cycle makes them true — or, at the cycle cap, the PR goes to a human with the unmet ones
  named. A PR whose description has no checklist is handed over saying there was nothing to check.
- **The PR description stays true.** The agent can't edit it; it returns corrections, and the push
  job writes them into one "Updated after review cycle k" section.
- **Without `AGENT_GH_TOKEN`** the loop can't work — a push made with `GITHUB_TOKEN` starts no
  workflow, so the fix would never be reviewed again. PRs then open as drafts, as before.
- **To run it by hand:** *Actions → issue-agent-review → Run workflow* with the PR number, or
  locally: `run.mjs assess-review <pr> --dry-run`, `run.mjs fix-review review.json`,
  `run.mjs push-review <fix-dir> --review review.json --pr <pr> --dry-run`. A PR that was already
  handed over goes back into the loop by putting its `agent:in-review` label back (swap it for
  `agent:needs-human` or `agent:ready-for-human`), which starts a run by itself; to give it more cycles than the cap, raise the cap — the repo variable
  `ISSUE_AGENT_MAX_REVIEW_CYCLES` (`gh variable set ISSUE_AGENT_MAX_REVIEW_CYCLES --body 4`) for
  Actions runs, or the same environment variable locally. A review cancelled by hand without a new
  push starts nothing: run the loop by hand to resume it.

## What it trusts — and what it doesn't

The agents run code: the implementer writes it, and the gates, the tests and the agents' own tools
execute it. So the design limits **what that code can reach** and **who can steer it**:

| | |
| --- | --- |
| **Who can start it** | Anyone who can add a label — and the workflow then requires **write access**. |
| **Whose words reach the agents** | Only the title, body and comments **by people with write access** (for the title: its author, or whoever renamed it last), frozen at the label (with briefs: at the comment or the approval). The agents' own earlier briefs and replies come back marked as theirs — never as a maintainer's words. Anything by others, or written/edited after the label, is left out and listed in the report; an outsider's title becomes "Issue #n". An issue edited or renamed after its label is refused until re-labelled. A PR in the review loop with no issue behind it (any branch but `agent/issue-*`) is different: its title and description are the request, read afresh each cycle — its author and labeller must have write access, and what the loop itself wrote into the description (the "Updated after review" section, a checklist line's evidence) is removed first, so agent text never comes back as a maintainer's. |
| **GitHub credentials** | **None in the job that runs agent code** (CI): the `implement` job has read-only access, its checkout keeps no credential, and no token is in its environment — the same for the review loop's `fix` job. Only the trusted jobs hold a write token (`publish`, and the review loop's `assess` and `push`), all run from `main`, and none installs or runs anything the agents wrote — they apply a patch. |
| **What publish takes from the agents' job** | Treated as untrusted input. The issue number comes from the workflow and must match; the title is re-read from GitHub through the same filter; the base must be a commit on `main`; the files touched are read from git after the patch is applied (not from the patch's own headers), and a change touching `.github/`, or `.claude/` outside `.claude/skills/`, is never pushed. Code running in the agents' job *could* rewrite the patch or the report it hands over (the recorded sha256 catches accidents, not that) — so what reaches GitHub is a PR — a draft, or with the review loop on, an `agent:in-review` PR the Claude review reads first — that a human approves like any other before it merges. The agent never merges. |
| **Claude credential** | The agents need one to run, so it is in *their* environment — an agent's tools can read it. Code the agents wrote (npm scripts, tests, builds) runs with **every** credential stripped. |
| **Git hooks** | Disabled for every git command the script runs. |
| **Network** | Not restricted. An agent's `node`/`npm` can reach the internet. |

Tool denies (`git push`, `gh`, `curl`, `WebFetch` …) keep the agents tidy; they are **not** the
security boundary — `node`, `npm` and `npx`, which the implementer needs, can do all of those. The
boundary is that there is nothing to push *with*, and that only maintainers' words get in.

**Run locally, the boundary is weaker:** the agents run as you, on your machine, where your `gh` and
`npm` logins live in your keychain. They're still only fed maintainers' words and their code still
runs without credentials in its environment — but a `node` process can reach your keychain. Run
locally on issues you've read, and prefer `--no-publish` first.

## Run it

**On GitHub:** add the `agent` label to an issue (you need write access). Or *Actions → issue-agent
→ Run workflow* with an issue number. Results: the draft PR, a comment on the issue, and the run's
transcripts + media as a workflow artifact (kept 30 days).

**Locally** (your Claude Code login, your `gh` login):

```sh
npm install --prefix ci/issue-agent
ci/issue-agent/node_modules/.bin/playwright install chromium

node ci/issue-agent/run.mjs 286 --no-publish        # everything except pushing; open the report it prints
node ci/issue-agent/run.mjs publish ~/…/issue-286-<run>   # then publish that exact run
node ci/issue-agent/run.mjs 286                     # or both in one go
node ci/issue-agent/run.mjs --poll                  # every open `agent` issue with no PR yet
node ci/issue-agent/run.mjs 286 --trigger comment   # briefs on: answer the latest comment on the brief
node ci/issue-agent/run.mjs 286 --trigger approved  # briefs on: build the approved brief
```

Each run gets a folder (`--runs`, default `$TMPDIR/credentagent-issue-agent/issue-<n>-<run>`):
`run.log`, every agent's structured output (`spec.json`, `implement-r1.json`, `review-*.json`, …),
full transcripts in `transcripts/`, `change.patch` (what gets published), and `evidence/index.html`
— the report with the screenshots and playable videos.

## Using it in another repo

The pipeline lives here; another repo uses it through the reusable workflow
`.github/workflows/issue-agent-run.yml` (this repo's own `issue-agent.yml` calls it too). That repo
needs three things — [openmobilehub/credentagent-website](https://github.com/openmobilehub/credentagent-website)
is the worked example:

1. **`.github/issue-agent.json`** — how to install, build and test it (`config.mjs` lists every field
   with this repo's values as the defaults; a field left out keeps its default). For a static site
   with `node --test`:

   ```json
   {
     "install": null, "build": null,
     "gates": [{ "name": "test", "cmd": ["node", "--test", "tests/*.test.mjs"] }],
     "fastTest": null,
     "testRunner": ["node", "--test"], "testFile": "^tests/.+\\.test\\.mjs$",
     "source": "^[^/]+\\.(html|md|txt|xml)$",
     "checkTools": ["Bash(node --test*)"], "focusedTest": "node --test <file>", "reproduce": "node --test \"tests/*.test.mjs\"",
     "docs": ["CLAUDE.md"]
   }
   ```

   It also takes the agents' repo-specific text — `implementNotes`, review `lenses`, `reviewRules`,
   `serveHint` (how the evidence agent starts the site) — which otherwise point at this repo's
   REVIEW.md, SECURITY-INVARIANTS.md and examples. Commands are argv arrays, never shell strings. An
   unknown field or a command it can't run stops the run before any agent starts. The file is under
   `.github/` on purpose: the agent never publishes a change there, so it can't loosen its own gates.

2. **A caller workflow** — `.github/workflows/issue-agent.yml` with the same triggers as ours, whose job
   is `uses: openmobilehub/credentagent/.github/workflows/issue-agent-run.yml@main` with
   `secrets: inherit` and the inputs `issue`, `sender`, `snapshot_at`, `force`, `claude_auth` (with
   briefs on, also `trigger` and `wait_seconds`, and the comment and `agent:approved` triggers — copy
   ours). Pass
   `review_loop: false` unless the repo also runs the Claude review and `issue-agent-review.yml`:
   without them nothing would pick up a PR opened for the loop, so it stays a draft for a human.

3. **Secrets and protection** — `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY` + the `CLAUDE_AUTH`
   variable `api`), and **`AGENT_GH_TOKEN`** — in practice required: the workflow's own token may open
   a PR only if the repo allows "GitHub Actions to create and approve pull requests", which also lets
   workflows *approve* PRs, so leave that off. Without either, publish pushes the reviewed branch and
   the issue comment says to open the PR by hand. The token also lets the draft start CI. And branch
   protection on `main` requiring a review: the agent never merges, but that rule is what makes it so.

The jobs check out the caller's `main` at `target/` and this repo's harness next to it at `harness/`,
then run `run.mjs … --target target`. The trust model is unchanged: the agents' job holds no GitHub
token, publish applies the reviewed patch from trusted code, and the caller trusts this repo's `main`
as it trusts its own. Locally: `node ci/issue-agent/run.mjs <n> --target ../other-repo --no-publish`.

## Where the evidence lives

Media goes on the orphan branch **`agent-evidence`** (`issue-<n>/<run>/`), not in the PR, so the
PR's diff stays code-only. The PR embeds the screenshots and links the videos and the full report.
It's public, like the repo. Never merge `agent-evidence`.

## Who pays, and how much

The same switch as `agent-e2e` (CLAUDE.md, "Which account pays"): the repo variable `CLAUDE_AUTH`.
Unset → the Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`); `api` → `ANTHROPIC_API_KEY`. The agents
run on the Agent SDK, which the API key's credit accepts (unlike `claude-code-action`).

A clean run is 6 agent sessions (spec, implement, 3 reviews, evidence) — the runs so far cost about
$4–6 each. The worst case is 1 + 3 rounds × (1 + 3 fixes + 3 reviews) + 1 = **23 sessions**, so spend
is capped twice: each session at `ISSUE_AGENT_BUDGET_USD` (25) and the whole run at
`ISSUE_AGENT_RUN_BUDGET_USD` (100) — the three reviewers, which run at once, each get a third of what
is left, so together they can't pass the cap. A run that hits its cap stops and says so.

## Knobs

| env | default | |
| --- | --- | --- |
| `ISSUE_AGENT_MODEL` | `claude-opus-5-5` | model for the implementer (and its fixes, and the review loop's) and the evidence agent |
| `ISSUE_AGENT_REVIEW_MODEL` | `claude-sonnet-5-5` | model for the spec agent and the three reviewers |
| `ISSUE_AGENT_MAX_ROUNDS` | `3` | review rounds before `[needs human]` |
| `ISSUE_AGENT_MAX_FIXES` | `3` | gate / test-proof fixes inside a round |
| `ISSUE_AGENT_BUDGET_USD` | `25` | per-session cap |
| `ISSUE_AGENT_RUN_BUDGET_USD` | `100` | per-run cap |
| `ISSUE_AGENT_LABEL` | `agent` | the label `--poll` looks for |
| `ISSUE_AGENT_MAX_REVIEW_CYCLES` | `2` | review-loop fix cycles; at the cap 💬 → `agent:ready-for-human` (notes listed), ⛔ → `agent:needs-human` |
| `ISSUE_AGENT_DISCUSS_ROUTINE`, `ISSUE_AGENT_DISCUSS_TOKEN` | — | secrets: the brief's "talk it through live" routine ("The brief") |

Secrets/variables: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (+ `CLAUDE_AUTH`), and
**`AGENT_GH_TOKEN`** (used by the trusted jobs that write: `publish`, and the review loop's `push`;
`assess` only checks whether it's set) — in practice required. Without it, publish falls back to
`GITHUB_TOKEN`, which can open a PR only if the repo allows "GitHub Actions to create and approve pull
requests" (leave that off: it also lets workflows approve PRs); otherwise publish pushes the branch
and tells the issue to open the PR by hand. Even when `GITHUB_TOKEN` can open it, GitHub doesn't
start CI or the Claude review on that PR until someone marks it ready, and the review loop is off. Give it the **Workflows** permission too if `main` may carry workflow changes the loop
has to merge in; without it GitHub refuses that push and the loop hands the PR to a human.

## Files

- `run.mjs` — the orchestrator: `snapshot`, `implement`, `publish` (CI runs them as three jobs; locally
  they run back to back) — and with briefs on, `brief` / `publish-brief` in the same three jobs, and
  `publish-split` / `unblock` for a split brief's tickets.
- `brief.mjs` — the brief: its comment (and reading it back exactly), where the conversation stands,
  what approval refuses, what each trigger starts. `card.mjs` — the card's plain-language check.
  `brief.test.mjs` — their tests; each fails if its check is removed.
- `scope.mjs` — splitting a big issue: the plan's check, the ticket issues (sealed like a brief), and
  which tickets can start. `scope.test.mjs` — its tests, and `ci/pr-scope/` the same bar for people's PRs.
- `example.mjs` — the PR's "Before and after": checking the proposed example, running it on both
  checkouts, the side-by-side picture. Tested in `brief.test.mjs`.
- `config.mjs` — what the pipeline needs to know about the repo it works on (`.github/issue-agent.json`,
  "Using it in another repo"); the defaults are this repo's.
- `roles.mjs` — each agent's prompt and output schema, built for the repo's config (`forRepo`).
- `checks.mjs` — the trust decisions (who wrote the title, which paths publish refuses, id checks), and
  the speed rules that mustn't weaken them (model per role, which tests a gate run uses, publish's
  root-`npm test` refusal).
- `issue-agent.test.mjs` — tests for those, the baseline and the PR-body escaping; part of the root
  `npm test`, and each fails if its check is removed. `config.test.mjs` — the same for another repo's
  config: its commands reach the gates, the prompts and the PR, and a config it can't use is refused.
- `merges.mjs` — bringing `main` into a conflicting PR: the fix job's merge-and-resolve and the push
  job's replay of it, which must build the same tree (tested on a real conflict).
- `fingerprints.mjs` — gate failures → comparable fingerprints, for the baseline.
- `capture.mjs` — Playwright helpers the evidence agent imports (`session`, `startServer`).
- `report.mjs` — the test-proof page, the HTML report, the PR body, the issue comments.
