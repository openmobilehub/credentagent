# Validation Guide — Quickstart Ladder (007)

How to prove the feature works, rung by rung. Prerequisites: Node ≥ 20, an MCP host (Claude,
Claude Code, ChatGPT, or Goose). Contracts referenced from
[contracts/quickstart-surface.md](./contracts/quickstart-surface.md).

## Rung 2 first (local) — the development loop

```bash
cd examples/quickstart
npm i          # resolves ONLY published @openmobilehub/credentagent-* from the registry
npm start      # → http://localhost:3005/mcp
npm run smoke  # in a second terminal — asserts contract rows a–e
```

Expected: server banner with the MCP URL; smoke prints a–e green and exits 0.
Manual pass (SC-004): add `http://localhost:3005/mcp` to Claude Code
(`claude mcp add --transport http shop http://localhost:3005/mcp`) or Goose → "what do you
sell?" → "add the whiskey and check out" (age 21+ surfaces) → "add the headphones instead"
(no age gate).

Negative checks (US2/US3): running from a clean clone WITHOUT `npm run build` at the repo root
must still work (proves no workspace dependency). `VERCEL=1 node server.mjs` with no
`GATE_SECRET` must refuse to boot with the actionable message.

## Rung 3 (own deployment)

Click the README's Deploy button (or `vercel --cwd examples/quickstart`), supply `GATE_SECRET`
(`openssl rand -hex 32`), then:

```bash
SMOKE_URL=https://<your-deployment>.vercel.app npm run smoke
```

Expected: a–e green against the public URL — including (e), which proves `statelessOrders`
completion on instances with no prior state.

## Rung 1 (hosted demo of record) + FR-009 cutover gate

Operational order (maintainer-gated; do not reorder):

1. Create Vercel project `credentagent-demo` — root directory `examples/quickstart`,
   `GATE_SECRET` set.
2. `SMOKE_URL=https://credentagent-demo.vercel.app npm run smoke` → a–e green. **This is the
   gate for every later step.**
3. Re-point `mcp-apps-nine.vercel.app` alias to the new deployment; rerun the smoke against the
   legacy alias (SC-005).
4. Land the banner README in `mcp-apps-shopping-demo`; `gh repo archive` (admin; reversible).

Manual rung-1 pass: paste `https://credentagent-demo.vercel.app/mcp` into Claude (custom
connector) / ChatGPT / Goose and run the whiskey-vs-headphones script — SC-001's stopwatch
starts at URL paste and ends at order confirmation.

## CI

`quickstart-smoke` job (independent of `build-test`): checkout → setup-node 22 →
`cd examples/quickstart && npm ci && npm run smoke`. Red job = the published packages and the
example have drifted, or a security assertion regressed — both are release-blocking signals.
