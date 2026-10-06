// ap2-multistore/up.mjs — everything a live demo needs, in one command: four public HTTPS tunnels
// (three stores the phone must reach, one agent Claude must reach), then the stores and the agent.
//
//   node examples/ap2-multistore/up.mjs        # needs `cloudflared` (brew install cloudflared)
//
// Each store gets its OWN tunnel because a store's merchant id is its host — share one and a
// permission signed for one store would name all three.
import { spawn } from "node:child_process";

const here = (f) => new URL(f, import.meta.url).pathname;
const kids = [];
const stop = () => { for (const k of kids) k.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function tunnel(port) {
  return new Promise((resolve, reject) => {
    const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    kids.push(cf);
    cf.on("error", reject);
    let seen = "";
    cf.stderr.on("data", (d) => {
      seen += d;
      const m = seen.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { cf.stderr.removeAllListeners("data"); cf.stderr.resume(); resolve(m[0]); }
    });
    setTimeout(() => reject(new Error(`no tunnel for :${port} after 30 s`)), 30_000);
  });
}

console.log("Opening four tunnels…");
const [agent, acme, beanbarn, roastworks] = await Promise.all([4100, 4101, 4102, 4103].map(tunnel));
// A fresh quick tunnel can take a few seconds to resolve in DNS; the stores bind to it at startup regardless.
kids.push(spawn(process.execPath, [here("./stores.mjs")], { stdio: "inherit", env: { ...process.env, ACME_URL: acme, BEANBARN_URL: beanbarn, ROASTWORKS_URL: roastworks } }));
kids.push(spawn(process.execPath, [here("./agent.mjs")], { stdio: "inherit", env: { ...process.env, STORES: [acme, beanbarn, roastworks].join(",") } }));

setTimeout(() => {
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  Claude connector URL:  ${agent}/mcp`);
  console.log(`  (claude.ai → Settings → Connectors → Add custom connector)`);
  console.log(`  Ctrl-C stops everything. Tunnels are new each run — re-add the connector.`);
  console.log(`────────────────────────────────────────────────────────────────\n`);
}, 1500);
