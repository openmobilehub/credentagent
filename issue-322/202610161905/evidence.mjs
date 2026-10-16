import { session, startServer } from "/Users/diegozuluaga/git/credentagent/.claude/worktrees/issue-minion-loop/ci/issue-agent/capture.mjs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const RUN = "/Users/diegozuluaga/credentagent-issue-agent-runs/issue-322-202610161905";
const OUT = join(RUN, "evidence");
const SERVER = join(OUT, "server.mjs");
await rm(join(OUT, "manifest.json"), { force: true });

const SIDES = [
  { side: "before", dir: join(RUN, "before"), label: "main" },
  { side: "after", dir: join(RUN, "repo"), label: "fix" },
];

let port = 4320;
for (const { side, dir, label } of SIDES) {
  // 1) Path-mounted store: walletOrigin https://shop.example/store, app behind a /store prefix.
  {
    const p = port++;
    const server = await startServer({
      cwd: dir, cmd: `node ${SERVER}`, port: p, readyPath: "/__resolve", outDir: OUT,
      env: { WALLET_ORIGIN: "https://shop.example/store", MOUNT_PREFIX: "/store", SIDE_LABEL: `${side} (${label}) — path-mounted store` },
    });
    const s = await session({ outDir: OUT, name: `${side}-path-mounted`, side });
    await s.page.goto(`${server.url}/store/did.json`);
    await s.page.waitForTimeout(700);
    await s.shot(side === "before"
      ? "before: https://shop.example/store/did.json (where did:web resolution looks for a path-mounted store) is not served — 404"
      : "after: https://shop.example/store/did.json returns the store's DID document with id did:web:shop.example:store and both key ids under that DID");
    await s.page.goto(`${server.url}/store/.well-known/did.json`);
    await s.page.waitForTimeout(700);
    await s.shot(side === "before"
      ? "before: the key is published at /store/.well-known/did.json, but its id is did:web:shop.example — an id that points at the site root, not the store"
      : "after: /store/.well-known/did.json is still served (same document), now carrying the path-scoped id did:web:shop.example:store");
    await s.page.goto(`${server.url}/__resolve`);
    await s.page.waitForTimeout(1200);
    await s.shot(side === "before"
      ? "before: a stranger resolving did:web:shop.example goes to https://shop.example/.well-known/did.json and gets 404 — the store's key can't be found (FAIL)"
      : "after: resolving did:web:shop.example:store goes to https://shop.example/store/did.json and gets this store's own key document (PASS)");
    await s.close(`${side}: path-mounted store (walletOrigin https://shop.example/store) — /store/did.json, /store/.well-known/did.json, then the did:web resolution check`);
    await server.stop();
  }
  // 2) Control: root store, walletOrigin https://shop.example, mounted at the site root.
  {
    const p = port++;
    const server = await startServer({
      cwd: dir, cmd: `node ${SERVER}`, port: p, readyPath: "/__resolve", outDir: OUT,
      env: { WALLET_ORIGIN: "https://shop.example", MOUNT_PREFIX: "", SIDE_LABEL: `${side} (${label}) — root store (control)` },
    });
    const s = await session({ outDir: OUT, name: `${side}-root-control`, side });
    await s.page.goto(`${server.url}/.well-known/did.json`);
    await s.page.waitForTimeout(700);
    await s.shot(`${side}: control — root store's /.well-known/did.json has id did:web:shop.example (unchanged)`);
    await s.page.goto(`${server.url}/__resolve`);
    await s.page.waitForTimeout(1200);
    await s.shot(`${side}: control — resolving did:web:shop.example finds the root store's own key document (PASS)`);
    await s.close(`${side}: control — root store (walletOrigin https://shop.example) resolves the same before and after`);
    await server.stop();
  }
}
console.log("done");
