// server.mjs — the spending-grant APPROVE PAGE, in every state it can be in (issue #172).
//
//   (npm run build --workspaces)                   # once, if not built
//   node examples/grants-approve/server.mjs        # → http://localhost:4021
//
// This is the page a human opens on their phone when an agent asks to spend on their behalf —
// `grant.approveUrl`, served by `grants.serve(app)`. It seeds four grants so you can see, side by
// side, every state the page has:
//
//   1. age-restricted scope, unproved  — the warning, the wallet button, "Approve without them"
//   2. age-restricted scope, proved    — Age ✓ on the stepper, a plain "Approve"
//   3. nothing restricted              — no warning, no stepper: one decision
//   4. already approved                — the terminal state
//
// The whole flow is live: tap "Verify 21+ with your wallet" on grant 1 and you get the REAL age
// ceremony (a signed OpenID4VP request; use the instant-demo button if you have no wallet on this
// device), land back here with the proof in hand, and approve.
//
// HONESTY: approving here stands in for the wallet key-signing ceremony (presence
// "delegated-demo"), and the age proof's trust level is "presence-only-demo" — the wire crypto is
// real, but there is no issuer trust anchor yet, so a self-made credential would pass. Not a real
// age-safety control. No real money moves.

import express from "express";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 4021);
const BASE = `http://localhost:${PORT}`;

// The gate's priced catalog (dollars) — the ONE price source, and what the approve page reads to
// work out which grants cover age-restricted goods. Both Beverages are 21+; that is the whole bug
// #172 reported: a "Beverages only" grant could spend $0.00 and nobody was told.
const GATE_CATALOG = {
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages", name: "Oak Reserve Whiskey" },
  "celebration-champagne": { price: 89, minAge: 21, category: "Beverages", name: "Celebration Champagne" },
  "drift-mouse": { price: 49, category: "Electronics", name: "Drift Wireless Mouse" },
};

// The storefront's own catalog (what the shop sells). `minimumAge` is the field that ties the two
// together — the live catalog is what a delegated purchase is re-checked against.
const p = (id, name, price, category, minimumAge) => ({ id, name, price, currency: "USD", image: "", description: "", category, ...(minimumAge ? { minimumAge } : {}) });
const PRODUCTS = [
  p("oak-whiskey", "Oak Reserve Whiskey", 124, "Beverages", 21),
  p("celebration-champagne", "Celebration Champagne", 89, "Beverages", 21),
  p("drift-mouse", "Drift Wireless Mouse", 49, "Electronics"),
];

const credentagent = new CredentAgent({ walletOrigin: BASE, catalog: GATE_CATALOG, signingKey: "grants-approve-example" });
const store = createStorefront({ grants: credentagent.grants, catalog: PRODUCTS, signingKey: "grants-approve-example" });
store.app.use(express.json());
credentagent.mount(store.app); // the /credentagent/* ceremony rails — incl. the grant age gate
credentagent.grants.serve(store.app); // grant.approveUrl → the real approve page

const grants = credentagent.grants;
const bar = (description, allow) => grants.create({ merchant: "utopia", budget: 300, perSpend: 150, allow, description });

// ── the four states ──────────────────────────────────────────────────────────
const unproved = await bar("Your shopping agent wants to restock the bar cart while you're away.", { categories: ["Beverages"] });

const proved = await bar("Your shopping agent wants to restock the bar cart while you're away.", { categories: ["Beverages"] });
// What the age ceremony does when the human's wallet proves 21+ on the approve page. Doing it
// here just saves you the tap — the button on grant 1 runs the real thing.
await grants._recordAgeProof(proved.id, { provenAge: 21 });

const unrestricted = await grants.create({
  merchant: "utopia", budget: 300, perSpend: 150, allow: { categories: ["Electronics"] },
  description: "Your shopping agent wants to replace your mouse.",
});

const approved = await bar("Your shopping agent wants to restock the bar cart while you're away.", { categories: ["Beverages"] });
await grants._authorize(approved.id);

const STATES = [
  { n: 1, label: "Age-restricted · not yet proved", note: "The warning, the wallet button, and “Approve without them”.", grant: unproved },
  { n: 2, label: "Age-restricted · proved", note: "Age ✓ on the stepper, and a plain “Approve”.", grant: proved },
  { n: 3, label: "Nothing restricted", note: "No warning and no stepper — a single decision.", grant: unrestricted },
  { n: 4, label: "Already approved", note: "The terminal state.", grant: approved },
];

// ── an index so you can walk the states ──────────────────────────────────────
store.app.get("/", (_req, res) => {
  const cards = STATES.map(
    (s) => `<a class="card" href="/credentagent/grants/${s.grant.id}">
      <span class="n">${s.n}</span>
      <span class="t">${s.label}</span>
      <span class="d">${s.note}</span>
    </a>`,
  ).join("\n");
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spending grant · approve page states</title>
<style>
  :root { color-scheme: light }
  body { font: 16px/1.55 system-ui, -apple-system, sans-serif; background: #f7f9f9; color: #10201c;
         margin: 0; padding: 40px 20px; }
  .wrap { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 6px; }
  p.lede { color: #5b6f6a; margin: 0 0 26px; }
  .card { display: grid; grid-template-columns: 32px 1fr; gap: 2px 12px; text-decoration: none;
          color: inherit; background: #fff; border: 1px solid #e2eae7; border-radius: 12px;
          padding: 16px 18px; margin-bottom: 12px; }
  .card:hover { border-color: #0d9488; }
  .n { grid-row: span 2; display: flex; align-items: center; justify-content: center; width: 28px;
       height: 28px; border-radius: 999px; background: #0d9488; color: #fff; font-weight: 700;
       font-size: .85rem; }
  .t { font-weight: 600; }
  .d { color: #5b6f6a; font-size: .9rem; }
  .foot { color: #5b6f6a; font-size: .82rem; border-top: 1px solid #e2eae7; margin-top: 26px;
          padding-top: 16px; }
</style>
<div class="wrap">
  <h1>Spending grant — approve page</h1>
  <p class="lede">The page a human opens when an agent asks to spend on their behalf. Four states, one per grant.</p>
  ${cards}
  <p class="foot">🔒 Approving here stands in for the wallet ceremony (<code>delegated-demo</code>), and the age proof is
  <code>presence-only-demo</code> — the wire crypto is real, but there is no issuer trust anchor yet. Not a real
  age-safety control. No real money moves.</p>
</div>`);
});

await store.listen(PORT);
console.log(`\n  Spending-grant approve page → ${BASE}\n`);
for (const s of STATES) console.log(`  ${s.n}. ${s.label.padEnd(34)} ${BASE}/credentagent/grants/${s.grant.id}`);
console.log(`\n  Tap "Verify 21+ with your wallet" on state 1 for the live age ceremony.\n`);
