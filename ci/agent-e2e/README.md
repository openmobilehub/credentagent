# agent-e2e — agent-in-the-loop end-to-end

A REAL agent drives the deployed MCP storefront unaided, and we assert on FACTS in the tool
trace (never on prose). `agent-e2e.mjs` runs a Claude agent on the Claude Agent SDK; the checks
live in `assertions.mjs`. It signs in like Claude Code does: in CI with the `CLAUDE_CODE_OAUTH_TOKEN`
secret (create one with `claude setup-token`; the nightly workflow skips cleanly without it), and
locally with your existing Claude Code login.

**Target the deployed store with `E2E_MCP_URL`** — defaults to the prod demo
(`https://credentagent.ai/marketplace/mcp`), so the nightly workflow needs no env. Set it to the
dev twin `https://credentagent.ai/marketplace-dev/mcp` (which runs `main`'s unpublished source) to
exercise unreleased changes. `MCP_URL` is still accepted as an alias for back-compat.

```sh
npm ci
node agent-e2e.mjs                                                        # vs the prod demo
E2E_MCP_URL=https://credentagent.ai/marketplace-dev/mcp node agent-e2e.mjs  # vs the dev twin
```
