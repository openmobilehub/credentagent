---
name: review-to-our-bar
description: Use to review a pull request against this project's bar before a human reviewer spends time on it — your own PR before you ask for review, or someone else's you were asked to check — especially in a sibling repo (Multipaz SDK, Multipaz Wallet, multipaz-utopia) where no review bot runs. Four lenses (standards, spec, developer experience, skeptic), read-only, ending in a review a person approves before anything is posted. The automated review of a PR in this repo is REVIEW.md plus the review workflow, not this skill.
---

# Review to our bar

The bar is [`REVIEW.md`](../../../REVIEW.md) and the DX rubric it points to
([`architecture-principles.md`](../../../docs/reference/architecture-principles.md));
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md), "The same bar outside this repo", says
it follows the work into other repositories. This skill is the procedure for
applying it there, where nothing runs it for you.

Read-only throughout: read the code and run read-only `git` and `gh`. A pull
request's checkout is someone else's code, so build or run it only when the
person you are working for says to, and say in the review what you did not run.

## Steps

1. **Pin the change.** From the PR URL, record the head commit, the base, and the
   diff stat. Get the diff into a scratch checkout outside any working copy.
   *Done when* the commit and a non-empty diff are recorded.

2. **Name the three sources.** Each as a path or URL, or stated as missing:
   - **Standards** — the target repo's own contribution files, plus `REVIEW.md`
     §3, §4 and §8 when the target is a sibling repo.
   - **Spec** — the issue the PR closes, every external spec it cites, and the
     reference implementation of that spec if one exists.
   - **Caller** — whatever uses the change: a sample app, a dependent PR, the
     other side of a protocol.

3. **Measure the sample app before reading the implementation.** For each kind
   of developer the change touches (app developer on each platform, the other
   side of the protocol, someone extending it), write the smallest correct code
   they need today, from the caller's side, and count the lines. Over one
   screen, or it needs explaining: that is the first finding, ahead of anything
   else (the sample app is the measurement, `REVIEW.md` §3).
   *Done when* there is one snippet and one line count per developer.

4. **Run the lenses.** Dispatch standards, spec and developer experience as
   parallel subagents with fresh context, using the briefs in
   [`LENSES.md`](LENSES.md). Every finding carries the file and line, the rule
   or spec text it is measured against, and the exact change to make.
   *Done when* all three have reported what they read and what they did not.

5. **Check the PR's own claims.** For each "tested", "verified" or "passes" in
   the description or the author's replies, find the test, script or CI job that
   shows it. A claim with nothing behind it is a finding.

6. **Send in the skeptic.** A fresh subagent whose only job is to refute: every
   finding from steps 3 to 5 is opened in the code and marked confirmed, partly
   (with the corrected statement), or refuted. It also checks that each finding
   says what to change, and is fair to the author (the repo's own convention, a
   maintainer's earlier request, out of scope).
   *Done when* every finding has a verdict; refuted ones are dropped and
   corrections applied. A lens that skipped an area, or a new claim the skeptic
   could not check, gets one more pass before you go on.

7. **Write the review.** Order it by what costs the most if missed: what a user
   is shown before approving, then what a developer has to write, then evidence,
   then the repo's rules, then the rest.
   - **Reviewing someone else's PR:** a short body (the sample-app measurement,
     the code they should be able to write, at most five things before merge,
     scope) and comments on the changed lines. Offer a click-to-apply suggestion
     only for a one-line mechanical fix; otherwise state the problem and the
     behaviour expected.
   - **Reviewing your own before you ask:** fix what you found, then put the
     sample-app snippet, the findings, and what you did not verify in the PR
     description.

8. **Hand it over.** Show the person the review as it would be posted. Post, or
   move the card to *In review*, only on their word.
