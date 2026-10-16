// Identity-ONLY delegated gate — the external verifier checks a fact about the person (21+),
// and nobody pays anything.
//
//   npm run build:packages
//   node examples/delegated-verifier-identity/serve.mjs     # → http://localhost:3009
//
// The shopping twin (examples/delegated-verifier/serve.mjs) uses an external checker to
// verify a card and move (simulated) money. This is the other half of the thesis —
// "identity leads; payments is one application": the SAME `verifier` seam gates a
// non-commerce action — an MCP tool that releases a sealed record — behind an identity
// credential. No cart, no price, no `payment.in(...)` anywhere in this file, and the
// stand-in verifier below has NO `settle` member at all: if the gate ever reached for the
// money path, the proof would be refused with the rail's own "verifier has no settle()"
// error, and the walk-through below prints it as a settlement error. It never does here:
// this instance resolves no payment policy, so the rail builds no settle step (pinned by the
// package test "an identity-only delegated gate (no payment) completes with NO settlement
// call"). The rail decides that from every policy the instance has resolved, not from this
// request alone — issue #353.
//
// Try the refusal paths (the security, end-to-end) by booting with a mode:
//   VERDICT=underage node examples/delegated-verifier-identity/serve.mjs  # only 18+ disclosed on a 21+ gate → refused
//   VERDICT=declined node examples/delegated-verifier-identity/serve.mjs  # verifier does not vouch → refused
//
// ⚠️ HONESTY: the verifier here is a LOCAL STAND-IN — a dev/demo double, NOT a real trust
// anchor. It reports `trust_level: "presence-only-demo"` honestly; a REAL adapter (the
// downstream Multipaz work, multipaz-utopia#16) verifies issuer signatures and reports
// "issuer-verified". A real adapter alone would still not make THIS server safe: `mount()`
// also serves the built-in demo rails, whose instant-demo branch takes claims straight from
// the request body, so a hand-made POST can complete a request without the external
// verifier at all (issue #352). Don't put this gate in front of anything that
// needs a real safety guarantee.
import { randomUUID } from "node:crypto";
import express from "express";
import {
  CredentAgent,
  defineHost,
  age,
  required,
  buildVerificationRequired,
  isVerificationRequired,
  ageDcql,
} from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT) || 3009;
const MODE = process.env.VERDICT || "ok"; // ok | underage | declined

// ── The gated ACTION — not a sale. The "catalog" prices every action at $0: the gate
//    re-derives the amount server-side as always (invariant 2), and here that amount is
//    zero because there is nothing to pay.
//    `minimumAge: 21` is what makes the shared completion enforce the age gate: it reads the
//    threshold from the line, not from `age.over(21)` in the policy. Drop the tag and an
//    18+ proof would complete (issue #354).
const ACTIONS = { "sealed-record": { name: "Sealed record", minimumAge: 21 } };
const subjects = new Map(); // requestId → the ONE record its approval covers (server-side)
function priceAction(items, orderId) {
  const lines = items.map(({ productId, quantity }) => {
    const a = ACTIONS[productId];
    // The approve page shows this name, so the person sees exactly which record they unlock.
    const name = `${a.name} — ${subjects.get(orderId) ?? "unknown"}`;
    return { id: productId, name, unitPrice: 0, quantity, lineTotal: 0, currency: "USD", minimumAge: a.minimumAge };
  });
  return { id: orderId, lines, itemCount: lines.length, subtotal: 0, discount: 0, total: 0, currency: "USD" };
}

// ── The local stand-in IDENTITY verifier (dev-only). Same two-leg shape a real adapter
//    has — buildRequest creates a transaction row, consume fetches it BY REFERENCE,
//    server-to-server — but deliberately NO `settle`: this verifier cannot move money.
function standInVerifier(mode) {
  const presentments = new Map();
  return {
    async buildRequest({ binding }) {
      const reference = `dev-${Date.now()}`;
      presentments.set(reference, { amount: binding.amount, currency: binding.currency, payee: { id: binding.payee.id } });
      return { reference, handoff: { note: "LOCAL STAND-IN — no external verifier is contacted" } };
    },
    async consume({ reference }) {
      const verdict = {
        approved: true,
        trust_level: "presence-only-demo", // honest: a stand-in is not a trust anchor
        claims: { age_mdl: { age_over_21: true } },
        binding: { ...presentments.get(reference) },
      };
      if (mode === "underage") verdict.claims.age_mdl = { age_over_18: true }; // not 21+ → the gate refuses
      if (mode === "declined") { verdict.approved = false; verdict.reason = "identity not vouched for (stand-in)"; }
      return verdict;
    },
    // ← no settle(). The money path does not exist on this verifier.
  };
}

// ── Wire the seams on a plain Express app (no storefront anywhere).
const app = express();
app.use(express.json());
const requests = new Map(); // requestId → the pending release request (the "created order")
const released = new Map(); // requestId → the completion record — the RELEASE LOG (invariant 1)
const host = defineHost({
  catalog: { createOrder: (items, orderId) => priceAction(items, orderId) },
  orderStore: { read: (id) => requests.get(id) ?? null },
  records: { read: (id) => released.get(id), write: (rec) => { released.set(rec.orderId, rec); } },
  returnUrl: (id) => `/records/${id}`, // where the ceremony returns the requester after the proof
  allowEphemeralKey: true, // single-process dev server
});
// `defineHost` doesn't expose the `verifier` seam yet (issue #355), so
// publish it on app.locals BEFORE publish() — publish merges around it, and zero-arg mount()
// picks it up.
app.locals.credentagent = { verifier: standInVerifier(MODE) };
host.publish(app);

const releasePolicy = [required(age.over(21))]; // the WHOLE policy — no payment credential
const credentagent = new CredentAgent({ walletOrigin: `http://localhost:${PORT}`, credentials: releasePolicy.map((s) => s.credential) });
credentagent.mount(app); // zero-arg — seams + verifier come from app.locals

// ── The MCP-shaped tool, gated (the same shape as examples/gate-any-action.mjs).
//    First call: the SERVER mints the request id and stores which record it is for, then
//    returns the typed Mode-B refusal the agent drives. Re-call with that id: it releases
//    the STORED record once the shared completion has written a record for this request —
//    server-side state, never anything the caller passes. A re-call naming another record
//    is refused, and an unknown id just starts a new request.
function releaseRecord({ subject, requestId }) {
  const approvedFor = requestId ? subjects.get(requestId) : undefined;
  if (approvedFor !== undefined) {
    if (subject !== approvedFor) {
      return { released: false, error: `request ${requestId} covers a different record` };
    }
    if (released.has(requestId)) {
      return { released: true, subject: approvedFor, records: [`record:${approvedFor}:summary`] };
    }
    return releaseRefusal(requestId); // still unproven: same request, same approve link
  }
  const id = `REQ-${randomUUID()}`;
  subjects.set(id, subject);
  requests.set(id, priceAction([{ productId: "sealed-record", quantity: 1 }], id));
  // Registers this request's policy with the gate. The manifest it returns is unused: the
  // refusal below is built by hand (see there).
  credentagent.requirements(requests.get(id), releasePolicy);
  return releaseRefusal(id);
}

function releaseRefusal(requestId) {
  // Hand-built: there is no helper that builds this refusal from `releasePolicy` yet (#23),
  // so `credential`, `minAge` and `request` restate the policy.
  return buildVerificationRequired({
    order: { id: requestId, total: 0, currency: "USD" },
    credential: "age",
    minAge: 21,
    request: ageDcql(),
    // The manifest routes identity approve links to the BUILT-IN rail by design; this
    // example is specifically about the delegated ceremony, so it links there directly
    // (issue #356, under epic #60).
    approveUrl: `http://localhost:${PORT}/credentagent/delegated?order=${encodeURIComponent(requestId)}`,
    gate: "Age over 21",
    detail: "Releasing this record requires proof that the requester is 21 or older.",
    resumeTool: "release-record",
  });
}

// ── Browser conveniences: click the whole flow, then read the release log.
app.get("/dev/release", (req, res) => {
  res.redirect(releaseRecord({ subject: "patient-7" }).present.approve_url);
});
app.get("/records/:id", (req, res) => {
  const rec = released.get(req.params.id);
  res.json(rec ? { released: true, requestId: req.params.id, trust_level: rec.trustLevel } : { released: false, requestId: req.params.id });
});

await new Promise((resolve) => app.listen(PORT, resolve));

// ── Scripted walk-through: the agent's view, end-to-end over real HTTP. ──────────────
console.log(`\nidentity-only delegated gate → http://localhost:${PORT}  (verifier: LOCAL STAND-IN · mode: ${MODE})`);

// 1) Ungated tool call → the typed refusal, not the records.
const refusal = releaseRecord({ subject: "patient-7" });
const requestId = refusal.order.id; // minted by the server, not chosen by the agent
console.log("\n— ungated tool call —");
console.log("  is a verification handshake:", isVerificationRequired(refusal));
console.log("  gate:", refusal.reason.gate, "| approve:", refusal.present.approve_url);

// 2) The requester proves through the EXTERNAL verifier — the two HTTP legs the mounted
//    /credentagent/delegated page drives in a browser (open /dev/release to click it).
const base = `http://localhost:${PORT}/credentagent/delegated`;
const { referenceToken } = await (await fetch(`${base}/request?order=${encodeURIComponent(requestId)}`)).json();
const verdict = await (await fetch(`${base}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ order: requestId, referenceToken }),
})).json();
console.log("\n— delegated ceremony (external verifier) —");
console.log("  completed:", verdict.completed, "| trust_level:", verdict.trust_level ?? "—", verdict.reason ? `| refused: ${verdict.reason}` : "");
console.log("  settlement on the completion:", verdict.settlementError ? `ATTEMPTED and failed — ${verdict.settlementError}` : "settlement" in verdict ? verdict.settlement : "NONE — the money path never fired");

// 3) Re-call the tool: released iff the gate completed (server-side, off the record store).
const again = releaseRecord({ subject: "patient-7", requestId });
console.log("\n— tool re-called —");
if (again.released) {
  console.log("  ", JSON.stringify(again));
} else {
  console.log("   still gated (refused proof releases nothing):", isVerificationRequired(again));
}

// 4) The same approval cannot be pointed at another record.
const other = releaseRecord({ subject: "patient-99", requestId });
console.log("\n— re-called for a different record —");
console.log("  ", JSON.stringify(other));
console.log(`\n▶ Click it yourself: http://localhost:${PORT}/dev/release  (Ctrl-C to stop)\n`);
