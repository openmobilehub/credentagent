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
  ├─ gates       build · typecheck · lint · root `npm test`, vs main's own failures          (script)
  ├─ mutation    revert the source change → the changed tests must FAIL; restore → pass     (script)
  ├─ review      spec · security · DX, in parallel, adversarial                            (3 agents)
  │                └─ any red above → back to the SAME implement session (≤3 review rounds;
  │                   mechanical failures get up to 3 fixes inside a round)
  ├─ freeze      the reviewed change is saved as a patch — the only thing ever published   (script)
  ├─ evidence    anything browser-visible: before (main) vs after, screenshots + video     (agent)
  │              every change: a recorded test-proof page                                  (script)
  └─ publish     the patch on a clean checkout · one DCO-signed commit · draft PR · comment (script)
```

The script checks; the agents do. What an agent *claims* is re-checked mechanically or by a
different agent before it reaches the PR:

- **Gates** run from the repo root (CLAUDE.md's authoritative run). Failures are compared against a
  baseline of `main`'s own, **by count**: a red `main` isn't charged to the change, and the change
  can't add even one more failure of a kind `main` already has.
- **The mutation check** enforces CLAUDE.md's "a test that would still pass with the security control
  removed is not a useful test": every changed source file is reverted to `main` (new ones deleted),
  the changed test files run, and they must fail. It is per file — a file fails if any test in it
  does — so the reviewers are told to judge each new case on its own.
- **New files count.** They're registered with git (`--intent-to-add`) before every diff, so the
  mutation check, the reviewers and the patch all see them.
- **Reviewers didn't write the code.** They can read, and run the project's checks; whatever their
  runs leave in the tree is thrown away. A criterion with no verdict counts as not met.
- **Only the reviewed patch is published**, applied to a clean checkout — so nothing the evidence
  agent, a test run or a server leaves behind *in the working tree* can reach the PR. A patch
  touching `.github/` is never pushed. (What the publish job does and doesn't trust is below.)
- If the agents don't converge (or a budget runs out, or a reviewer can't finish), the PR still
  opens as `[needs human]` with the open findings, or the issue gets a comment saying why.

## The review loop

With an `AGENT_GH_TOKEN` secret set, a converged change doesn't stop at "draft PR": it opens as a
real PR (labelled **`agent:in-review`**, with a banner saying it isn't ready for a human yet), the
Claude review runs on it, and `.github/workflows/issue-agent-review.yml` takes over after every
review:

```
Claude review finishes on an agent/issue-* PR
  ├─ assess   read the verdict + the open threads (the review bot's and maintainers' only)    (script)
  │             ✅ Ready to merge, or 💬 with no thread open → hand to a human: label
  │                agent:ready-for-human, request the labeller's review, drop the banner      ← stop
  │             cycle cap reached with 💬 → the same hand-over, with the open notes listed      ← stop
  │             cycle cap reached with ⛔ → label agent:needs-human, say why                   ← stop
  ├─ fix      answer every thread — fix it, or decline it with a reason; then the same gates,
  │           mutation check (over the whole PR) and three reviews as the first run         (agents)
  └─ push     apply the checked fix to the PR head (fast-forward, no force), reply to every
              thread with the agent's answer and resolve it                                  (script)
                → the push starts the next Claude review → assess again
```

- **A human is asked only at the end** — when the review is satisfied with nothing left open, or
  when the loop stops (cycle cap `ISSUE_AGENT_MAX_REVIEW_CYCLES`, default 3; a budget; a fix that
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
- **Only PRs the loop opened, only from this repository.** It acts only on `agent/issue-*` branches
  in this repository that carry `agent:in-review` (so a PR a human has taken over is left alone),
  and spends nothing at all when `AGENT_GH_TOKEN` is missing. Both workflows run their trusted
  jobs from `main`, even when started by hand from another branch.
- **Never stranded.** A review that fails, or ends with no verdict for the latest commit (paused,
  skipped), hands the PR to a human with that reason instead of leaving it "in review" forever.
- **Main is brought in when it matters.** If `main` has changed a file the PR also changes, the fix
  job merges `main` first (the review reads the PR merged onto main, so a stale copy of such a file
  can only be fixed by a merge); the push job re-does that merge from a commit it checks is on
  `main`, signed off, and hands over on a conflict.
- **The PR description stays true.** The agent can't edit it; it returns corrections, and the push
  job writes them into one "Updated after review cycle k" section.
- **Without `AGENT_GH_TOKEN`** the loop can't work — a push made with `GITHUB_TOKEN` starts no
  workflow, so the fix would never be reviewed again. PRs then open as drafts, as before.
- **To run it by hand:** *Actions → issue-agent-review → Run workflow* with the PR number, or
  locally: `run.mjs assess-review <pr> --dry-run`, `run.mjs fix-review review.json`,
  `run.mjs push-review <fix-dir> --review review.json --pr <pr> --dry-run`.

## What it trusts — and what it doesn't

The agents run code: the implementer writes it, and the gates, the tests and the agents' own tools
execute it. So the design limits **what that code can reach** and **who can steer it**:

| | |
| --- | --- |
| **Who can start it** | Anyone who can add a label — and the workflow then requires **write access**. |
| **Whose words reach the agents** | Only the title, body and comments **by people with write access** (for the title: its author, or whoever renamed it last), frozen at the label. Anything by others, or written/edited after the label, is left out and listed in the report; an outsider's title becomes "Issue #n". An issue edited or renamed after its label is refused until re-labelled. |
| **GitHub credentials** | **None in the job that runs agent code** (CI): the `implement` job has read-only access, its checkout keeps no credential, and no token is in its environment — the same for the review loop's `fix` job. Only the trusted jobs hold a write token (`publish`, and the review loop's `assess` and `push`), all run from `main`, and none installs or runs anything the agents wrote — they apply a patch. |
| **What publish takes from the agents' job** | Treated as untrusted input. The issue number comes from the workflow and must match; the title is re-read from GitHub through the same filter; the base must be a commit on `main`; the files touched are read from git after the patch is applied (not from the patch's own headers), and a change touching `.github/` is never pushed. Code running in the agents' job *could* rewrite the patch or the report it hands over (the recorded sha256 catches accidents, not that) — so what reaches GitHub is a PR — a draft, or with the review loop on, an `agent:in-review` PR the Claude review reads first — that a human approves like any other before it merges. The agent never merges. |
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
```

Each run gets a folder (`--runs`, default `$TMPDIR/credentagent-issue-agent/issue-<n>-<run>`):
`run.log`, every agent's structured output (`spec.json`, `implement-r1.json`, `review-*.json`, …),
full transcripts in `transcripts/`, `change.patch` (what gets published), and `evidence/index.html`
— the report with the screenshots and playable videos.

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
| `ISSUE_AGENT_MODEL` | `claude-opus-5-5` | model for every role |
| `ISSUE_AGENT_MAX_ROUNDS` | `3` | review rounds before `[needs human]` |
| `ISSUE_AGENT_MAX_FIXES` | `3` | gate / test-proof fixes inside a round |
| `ISSUE_AGENT_BUDGET_USD` | `25` | per-session cap |
| `ISSUE_AGENT_RUN_BUDGET_USD` | `100` | per-run cap |
| `ISSUE_AGENT_LABEL` | `agent` | the label `--poll` looks for |
| `ISSUE_AGENT_MAX_REVIEW_CYCLES` | `3` | review-loop fix cycles; at the cap 💬 → `agent:ready-for-human` (notes listed), ⛔ → `agent:needs-human` |

Secrets/variables: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (+ `CLAUDE_AUTH`), and optionally
**`AGENT_GH_TOKEN`** (used only by the publish job) — without it, PRs are opened by `GITHUB_TOKEN`,
and GitHub doesn't start CI or the Claude review on those until someone marks the draft ready.

## Files

- `run.mjs` — the orchestrator: `snapshot`, `implement`, `publish` (CI runs them as three jobs; locally
  they run back to back).
- `roles.mjs` — each agent's prompt and output schema.
- `checks.mjs` — the trust decisions (who wrote the title, which paths publish refuses, id checks).
- `issue-agent.test.mjs` — tests for those, the baseline and the PR-body escaping; part of the root
  `npm test`, and each fails if its check is removed.
- `fingerprints.mjs` — gate failures → comparable fingerprints, for the baseline.
- `capture.mjs` — Playwright helpers the evidence agent imports (`session`, `startServer`).
- `report.mjs` — the test-proof page, the HTML report, the PR body, the issue comments.
