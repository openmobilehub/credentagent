# gate-my-tool-sample — the skill's before/after target

A tiny runnable MCP server with **one deliberately ungated tool**, `release-records`:
a consequential disclosure action (identity-first — no cart, no checkout anywhere).

```bash
npm run build --workspaces                    # once, from the repo root
node examples/gate-my-tool-sample/server.mjs  # serves release-records over stdio
```

## The demo

1. **Before** — this server, as committed: any agent can call `release-records`
   and the records come back. No consent, no proof.
2. **Run the skill** — tell your coding agent: *"gate my `release-records` tool"*.
   The [`gate-my-tool`](../../.claude/skills/gate-my-tool/SKILL.md) skill wraps the
   handler in `credentagent.gate(handler, { require, provenBy, name })`.
3. **After** — the same call now returns a typed `verification_required` refusal
   (approve link + agent instruction) until the credential is proven, and the
   change is pinned by a **load-bearing bypass test** (it goes red if the wrap is
   removed).

`server.mjs` exports `buildServer()` so the bypass test can drive the tool
in-memory (`InMemoryTransport.createLinkedPair()`) — no process spawning.
