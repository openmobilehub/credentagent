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
import { CredentAgent, pageHead, brandHeader, progressRail } from "@openmobilehub/credentagent-gate";

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
  { label: "Age-restricted · not yet proved", note: "The warning, the items it names, the wallet button, and “Approve without them”.", grant: unproved, rail: [{ label: "Age" }, { label: "Approve" }] },
  { label: "Age-restricted · proved", note: "Age ✓ on the stepper, and a plain “Approve”.", grant: proved, rail: [{ label: "Age", done: true }, { label: "Approve" }] },
  { label: "Nothing restricted", note: "No warning and no stepper — one decision.", grant: unrestricted, rail: [] },
  { label: "Already approved", note: "The terminal state.", grant: approved, rail: [] },
];

// ── an index so you can walk the states ──────────────────────────────────────
// Built from the gate's OWN design-system primitives (pageHead / brandHeader / progressRail), not
// hand-rolled CSS — so this page can't drift from the approve page it links to. Each card previews
// that state's stepper: the same rail the page itself renders, at the same point in the flow.
store.app.get("/", (_req, res) => {
  const cards = STATES.map((s, i) => {
    // The rail marks the first unfinished step current, exactly as the approve page does. A state
    // with nothing to prove has no rail at all — a one-dot stepper says nothing.
    const rail = s.rail.length > 1 ? progressRail(s.rail, s.rail.findIndex((r) => !r.done)) : "";
    return `<div class="card">
      <p class="card-title"><span class="step-no">${i + 1}.</span> ${s.label}</p>
      ${rail}
      <p class="row-pending" style="margin:0 0 14px">${s.note}</p>
      <a class="btn btn-secondary" href="/credentagent/grants/${s.grant.id}">Open this state</a>
    </div>`;
  }).join("\n");

  res.type("html").send(`<!doctype html>
<html lang="en">
${pageHead("Spending grant · approve page states")}
<body>
  <div class="wrap">
  ${brandHeader({ h1: "Approve page", tagline: "The page a human opens when an agent asks to spend on their behalf. Four states, one per grant." })}
  ${cards}
  <div class="trust"><div class="trust-line">🔒 Approving here stands in for the wallet ceremony (delegated-demo), and the age proof is presence-only-demo — the wire crypto is real, but there is no issuer trust anchor yet. Not a real age-safety control. No real money moves.</div></div>
  </div>
</body>
</html>`);
});

await store.listen(PORT);
console.log(`\n  Spending-grant approve page → ${BASE}\n`);
STATES.forEach((s, i) => console.log(`  ${i + 1}. ${s.label.padEnd(34)} ${BASE}/credentagent/grants/${s.grant.id}`));
console.log(`\n  Tap "Verify 21+ with your wallet" on state 1 for the live age ceremony.\n`);
