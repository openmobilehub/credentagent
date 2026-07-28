# agent-e2e — agent-in-the-loop end-to-end

A REAL agent drives the deployed MCP storefront unaided, and we assert on FACTS in the tool
trace (never on prose). `agent-e2e.mjs` uses Claude (needs `ANTHROPIC_API_KEY`); its twin
`agent-e2e-openai.mjs` uses ChatGPT (needs `OPENAI_API_KEY`). Both share `assertions.mjs`;
each harness skips cleanly when its key is absent.

**Target the deployed store with `E2E_MCP_URL`** — defaults to the prod demo
(`https://credentagent-demo.vercel.app/mcp`), so the nightly workflow needs no env. Set it to the
dev twin `https://credentagent-demo-dev.vercel.app/mcp` (which runs `main`'s unpublished source) to
exercise unreleased changes. `MCP_URL` is still accepted as an alias for back-compat.

```sh
npm ci
ANTHROPIC_API_KEY=… node agent-e2e.mjs                                  # Claude vs the prod demo
E2E_MCP_URL=https://credentagent-demo-dev.vercel.app/mcp OPENAI_API_KEY=… node agent-e2e-openai.mjs  # ChatGPT vs the dev twin
```
