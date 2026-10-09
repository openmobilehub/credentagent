# Review: agents that buy while the person is away (October 2026)

**In one sentence:** the security core works, building with it is still hard, and a design review of 150+ AI agents found a clear target for "best in class". The review also found that the target is reached by building less, not more.

This folder keeps the evidence behind GitHub issues #260–#269 and #280–#286, so they can link to it:

- [`converged-spec.md`](converged-spec.md): the most complete compact design. It has a 1,300-word README and a red team that ended with no blockers in scope. It is a reference, not a plan to build as-is (see "What didn't converge").
- [`repros/`](repros/): one runnable script per confirmed bug. Run them from the repo root after `npm ci && npm run build`, for example `node docs/reviews/2026-10-agent-purchases/repros/negative.mjs`.

## How it was done

| Step | Agents | What it produced |
|---|---|---|
| Cold-reader review of today's docs and code | 8 | Issues #260–#269, and the baseline: 5/10 "aha, super easy" |
| Benchmarks: Stripe, the agent-payment protocols (AP2, ACP, UCP), approve-on-your-phone flows, AI tool design, docs for coding agents | 5 | Patterns worth copying, each with sources |
| Audits of today's experience: store developer, agent developer, shopping model, coding agent in someone else's repo | 4 | 60 findings |
| Rival designs (Stripe-style, agent-first, standards-first, one-line, consent-first) | 5 | — |
| Persona judges: store developer, agent developer, coding agent, shopping model, security, maintainer | 6 | Winner: consent-first (7.5) with the agent-first toolkit (7.4) grafted on |
| Red team, first-time readers, simulated chats, coding-agent dry run, feasibility, standards check, over 4 + 5 rounds | ~70 | The convergence results below |
| Two independent reproductions plus a skeptic per bug claim | ~30 | 8 bugs confirmed, 1 refuted |
| Calibration: the same readers grading Stripe's own docs | 8 | See below |

## What every judge and benchmark agreed on (the target)

1. **Opt in with the trust label in hand:** `agents: { trust: "presence-only-demo" }`. Ship on `order.settled`, and every purchase finishes through `completeOrder`.
2. **The store mints one purchase id** (`pur_…`). It is at once the one-time code, the safe-retry key and a 5-minute quote expiry, the way Stripe's PaymentIntent and UCP's checkout session work.
3. **The library owns the atomic spend check:** reuse the existing revoke + single-use + cap check (`RevocationStore.commitDraw`). Memory by default, Redis optional.
4. **The agent checks a quote before it signs it:** products, quantities, total within the limit, the right store, the cart's signature.
5. **The phone page is written from the signed limits,** never from the agent's own words. A short check code shows on both the phone and in the chat. The approval window and the grant both expire (7 days by default, 30 at most).
6. **Every result says who acts next** (`agent | person | store | nobody`) and carries a sentence that is safe to show the person.
7. **A test wallet with fixed outcomes,** like Stripe's test cards. A store accepts it only after opting in, and `doctor()` fails if that's on in a deployment.
8. **One set of chat tools** for the shopping model, at most six. Each has explicit next steps, dollars only, the standard MCP hints, and state scoped to each person.
9. **Docs that ship inside the npm package:** an `AGENTS.md` block, a "which API do I use?" table, error pages linked from every refusal, `llms.txt`, and the integrator skill.

## What didn't converge, and why that matters

- **Covering everything (run 1):** standards interop with any company's agents, hosted sign-in, a CLI and more. Each round fixed about 10 blockers and found about 10 new ones. The spec grew from 158 KB to 363 KB, and a first-time reader's score fell from 7 to 6.
- **Scoped to 0.6 (run 2):** CredentAgent stores and agents only, with the README capped at 1,300 words. The red team's in-scope blockers fell from 4 to 0, but first-time readers stayed at 6–7 and the runtime simulation at about 6.
- **The remaining problems are the hard part of buying later:** what happens when the person stops a purchase that is in flight, retries after "did it go through?", lowers a limit that is already part spent, or two people share one connector. Each is a decision about behaviour, not a missing paragraph. They are best settled by building the first increment and testing it, not by more rounds on paper.

## Calibration: how good is a 7?

Both convergence runs aimed for 9/10 from first-time readers and never got there. To see whether that bar was realistic, the same tough readers answered the same 12 questions about four documents, two readers each:

| Document | Scores | Unanswered questions |
|---|---|---|
| Stripe, "Accept a payment" quickstart (Node, Stripe-hosted Checkout) | **7, 7** | 18, 22 |
| Stripe, "Sell through agents" (Agentic Commerce Suite seller guide) | 6, 5 | 19, 16 |
| **CredentAgent today** (gate README, agent purchases) | **4, 4** | 23, 24 |
| **CredentAgent converged design** (`converged-spec.md`, README section) | **7, 7** | 25, 18 |

These readers give Stripe's flagship quickstart a 7, so 9 wasn't a fair target. **The converged design already reads at Stripe's quickstart level, and above Stripe's own agent-commerce guide.** What's left is deciding behaviour and building it, not writing more docs.

## Confirmed bugs (each reproduced twice independently, then attacked by a skeptic)

| Issue | What's wrong | Severity |
|---|---|---|
| #139 | Custom credential checks (a prescription, say) are skipped when a spending grant buys | High |
| #286 | A cart line with quantity −1 lets an agent pay $12.50 for a $22 coffee (on main, not on npm yet) | High |
| #280 | The AI can switch a grant to click-to-approve and approve it itself | Medium |
| #281 | An agent-held grant drops the loyalty discount the person proved | Medium |
| #282 | A signed $50 budget reads as $5,000 to AP2's reference code | Medium |
| #284 | The npm pages link to the archived demo repo | Medium |
| #283 | Spending a grant can report a purchase that didn't happen, or the wrong reason for a refusal | Low |
| #261 | Two purchases at once can overrun the budget when the store keeps the ledger (the README pattern) | Medium |

**Refuted:** "a store's grant charges only the first item in a cart". A cart with several items is refused, not undercharged.

The decisions these findings raise are in #285.
