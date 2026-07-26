# HNP on Claude — the away-agent story, live in a Claude chat

"Approve once, the agent spends while you're away — and age never delegates."
This example connects the whole store (checkout **and** grants) to the Claude app so
you can run the human-not-present flow in a real conversation.

> A recorded walkthrough of the flow below is attached to the PR that introduced this
> example ([#118](https://github.com/openmobilehub/credentagent/pull/118)) — kept out of
> the repo so the tree carries no binaries.

## What the flow shows (real, end to end)

1. **You:** "Set up a spending grant — $200 total, $130 per purchase, Beverages and Electronics only. Give me the approval link."
2. **Claude** calls `create-spending-grant` and hands back an **approve link** + the sealed bounds. It explains, unprompted, that spending is enforced by the server, age-restricted items come back to you, and the grant is revocable.
3. **You** open the link and click **Approve** once (the wallet-ceremony stand-in — *no real money moves*).
4. **You:** "I'm heading out — grab the Oak Reserve Whiskey and a wireless mouse."
5. **Claude** buys the **mouse** ($49 charged, **$151 of $200 remaining**, a real delegation id) …
6. … and **refuses the whiskey**: *"age verification can't be delegated, so that one waits for your tap."* — even though it's in an allowed category and under budget.

Every rule is enforced on the server (`credentagent.grants`), not by Claude's goodwill: the caps,
the category bounds, and the non-delegable age gate. See the sibling test
`packages/credentagent-storefront/src/grants-tools.test.ts` for the same lifecycle driven
over the MCP wire, including the bypass assertions.

## Run it yourself

```bash
node examples/hnp-on-claude/serve.mjs            # → http://localhost:3005/mcp
```

To drive it from the **Claude app**, expose the port and point a connector at it:

```bash
ngrok http 3005                                  # or: cloudflared tunnel --url http://localhost:3005
PUBLIC_URL=https://<your-tunnel> node examples/hnp-on-claude/serve.mjs   # so approve links are reachable
```

Then in **claude.ai → Settings → Connectors → Add custom connector** paste
`https://<your-tunnel>/mcp`, and have the conversation above. The grant approve pages are
served at `https://<your-tunnel>/credentagent/grants/:id`.

> The grant store is in-memory, so this targets a single-process server (local + tunnel).
> The Redis-backed grant store for the serverless demo is the follow-up (epic #12).
