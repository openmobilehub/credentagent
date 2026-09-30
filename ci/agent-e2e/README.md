# agent-e2e — agent-in-the-loop end-to-end

A REAL agent drives the deployed MCP storefront unaided, and we assert on FACTS in the tool
trace (never on prose). `agent-e2e.mjs` runs a Claude agent (needs `ANTHROPIC_API_KEY`; the
nightly workflow skips cleanly without it); the checks live in `assertions.mjs`.

**Target the deployed store with `E2E_MCP_URL`** — defaults to the prod demo
(`https://credentagent.ai/marketplace/mcp`), so the nightly workflow needs no env. Set it to the
dev twin `https://credentagent.ai/marketplace-dev/mcp` (which runs `main`'s unpublished source) to
exercise unreleased changes. `MCP_URL` is still accepted as an alias for back-compat.

```sh
npm ci
ANTHROPIC_API_KEY=… node agent-e2e.mjs                                                        # vs the prod demo
E2E_MCP_URL=https://credentagent.ai/marketplace-dev/mcp ANTHROPIC_API_KEY=… node agent-e2e.mjs  # vs the dev twin
```
