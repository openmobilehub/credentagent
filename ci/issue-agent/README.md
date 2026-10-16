# Issue agent

Label an issue **`agent`** and agents implement it, then open a **draft PR** that carries its own
proof: acceptance criteria checked off, the pipeline's own test runs, three independent reviews,
and before/after **screenshots and video** recorded in a real browser.

One way in, one way out — the shape of Stripe's "minions": a person states what they want in the
place they already work (here, a GitHub issue), the agent works unattended in an isolated
checkout, and what comes back is an ordinary PR a human reviews and merges. The agent never
merges; branch protection still needs a human approval and every review thread resolved.

## The pipeline

```
issue labelled `agent`
  │
  ├─ preflight   open? not needs-decision / epic? no open PR already fixing it?        (script)
  ├─ spec        reads the issue + code → acceptance criteria, or "not actionable"       (agent)
  │                └─ not actionable → comment on the issue saying exactly why, stop
  ├─ implement   failing test first, then the fix                                        (agent)
  ├─ gates       build · typecheck · lint · root `npm test`                              (script)
  ├─ mutation    revert the source change → the new tests must FAIL; restore → pass      (script)
  ├─ review      spec · security · DX lenses, in parallel, adversarial                   (3 agents)
  │                └─ any red above → findings go back to the SAME implement session (≤3 rounds)
  ├─ evidence    UI changes: before (main) vs after (fix), screenshots + video           (agent)
  │              every change: a recorded test-proof page                                (script)
  └─ publish     one DCO-signed commit · branch · draft PR · comment on the issue        (script)
```

The script checks, the agents do. Anything an agent *claims* (tests pass, criterion met) is
re-checked mechanically or by a different agent before it reaches the PR:

- **Gates** are run by the script from the repo root — CLAUDE.md's authoritative run.
- **The mutation check** enforces CLAUDE.md's rule that "a test that would still pass with the
  security control removed is not a useful test": the script reverts every changed source file to
  `main`, runs only the changed test files, and requires them to fail.
- **Reviewers didn't write the code** and run with read-only tools. A criterion with no file or
  test proving it is "not met".
- **No agent holds a GitHub token.** Agents can't push, commit, open PRs, run `gh`, or fetch from
  the web; only the script does, after every check.
- If the agents don't converge, the PR still opens — titled `[needs human]`, with the open findings
  listed — so nothing is silently dropped.

## Run it

**On GitHub:** add the `agent` label to an issue (you need write access). Or *Actions → issue-agent
→ Run workflow* with an issue number. Results: the draft PR, a comment on the issue, and the run's
transcripts + media as a workflow artifact.

**Locally** (uses your Claude Code login and your `gh` login):

```sh
npm install --prefix ci/issue-agent
ci/issue-agent/node_modules/.bin/playwright install chromium

node ci/issue-agent/run.mjs 286 --no-publish    # everything except pushing; open the report it prints
node ci/issue-agent/run.mjs --publish-run ~/…/issue-286-<run>   # then publish that exact run
node ci/issue-agent/run.mjs 286                 # or both in one go
node ci/issue-agent/run.mjs --poll              # every open `agent` issue with no PR yet
```

Each run gets a folder (default `$TMPDIR/credentagent-issue-agent/issue-<n>-<run>`, or `--runs`):
`run.log`, every agent's structured output (`spec.json`, `implement-r1.json`, `review-*.json`, …),
full transcripts in `transcripts/`, and `evidence/index.html` — the report with the screenshots and
playable videos.

## Where the evidence lives

Media goes on the orphan branch **`agent-evidence`** (`issue-<n>/<run>/`), not in the PR, so the
PR's diff stays code-only. The PR embeds the screenshots from there and links the videos and the
full report. Never merge `agent-evidence`.

## Who pays

The same switch as `agent-e2e` (CLAUDE.md, "Which account pays"): the repo variable `CLAUDE_AUTH`.
Unset → the Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`); `api` → `ANTHROPIC_API_KEY`, with each
agent capped at `ISSUE_AGENT_BUDGET_USD` (default 25). The agents run on the Agent SDK, which the
API key's credit accepts (unlike `claude-code-action`). A typical issue is ~6–8 agent sessions.

## Knobs

| env | default | |
| --- | --- | --- |
| `ISSUE_AGENT_MODEL` | `claude-opus-5-5` | model for every role |
| `ISSUE_AGENT_MAX_ROUNDS` | `3` | implement → review rounds before `[needs human]` |
| `ISSUE_AGENT_LABEL` | `agent` | the trigger label for `--poll` |
| `ISSUE_AGENT_BUDGET_USD` | `25` | per-agent cap, API-key runs only |

Secrets/variables: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (+ `CLAUDE_AUTH`), and
optionally **`AGENT_GH_TOKEN`** — without it, PRs are opened by `GITHUB_TOKEN`, and GitHub doesn't
start CI or the Claude review on those (mark the draft ready for review to start them).

## Files

- `run.mjs` — the orchestrator (preflight, gates, mutation check, publish).
- `roles.mjs` — each agent's prompt and output schema.
- `capture.mjs` — Playwright helpers the evidence agent imports (`session`, `startServer`).
- `report.mjs` — the test-proof page, the HTML report, the PR body, the issue comment.
