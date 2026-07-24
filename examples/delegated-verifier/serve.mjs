// Run the delegated-payment rail end-to-end LOCALLY — without the real Multipaz/UPay
// integration — so you can click a full delegated checkout in a browser.
//
//   npm run build -w @openmobilehub/credentagent-gate
//   npm run build -w @openmobilehub/credentagent-storefront
//   node examples/delegated-verifier/serve.mjs          # → http://localhost:3006
//   open http://localhost:3006/dev/buy                  # creates an order + drops you into the ceremony
//
// Try the REFUSAL paths (the security, end-to-end) by booting with a mode:
//   VERDICT=wrong-amount node examples/delegated-verifier/serve.mjs   # verifier approves the WRONG price → refused
//   VERDICT=underage     node examples/delegated-verifier/serve.mjs   # only 18+ disclosed on a 21+ item → refused
//   VERDICT=declined     node examples/delegated-verifier/serve.mjs   # verifier does not approve → refused
//
// ⚠️ The verifier here is a LOCAL STAND-IN — a dev/demo double, NOT a real trust anchor.
// It SIMULATES an external verifier + processor so the flow is clickable offline; it reports
// `trust_level: "presence-only-demo"` honestly (a REAL adapter — the downstream Multipaz/UPay
// work — verifies issuer signatures and reports "issuer-verified"). The point of THIS demo is
// the flow + the gate's own re-checks: the gate re-prices, re-runs your policy, and refuses a
// misbehaving verifier before any (simulated) money moves.
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, required, age, payment } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT) || 3006;
const MODE = process.env.VERDICT || "ok"; // ok | wrong-amount | underage | declined

// ── The local stand-in verifier (dev-only) ──────────────────────────────────
// It captures the amount the GATE priced at buildRequest and echoes it back at consume —
// exactly as a real adapter binds to what the gate sent. `settle` simulates the processor.
function standInVerifier(mode) {
  let captured;
  return {
    async buildRequest({ binding }) {
      captured = { amount: binding.amount, currency: binding.currency, payee: { id: binding.payee.id } };
      return { reference: `dev-${Date.now()}`, handoff: { note: "LOCAL STAND-IN — no external verifier is contacted" } };
    },
    async consume() {
      const verdict = {
        approved: true,
        // Honest: a local stand-in is NOT a real issuer/device trust anchor.
        trust_level: "presence-only-demo",
        claims: {
          age_mdl: { age_over_21: true },
          payment: { issuer_name: "Dev Bank", holder_name: "Local Tester", masked_account_reference: "•••• 4242" },
        },
        binding: { ...captured },
      };
      // Misbehaviour modes — to watch the gate REFUSE end-to-end (the whole safety story):
      if (mode === "wrong-amount") verdict.binding.amount = captured.amount - 1; // ≠ catalog price
      if (mode === "underage") verdict.claims.age_mdl = { age_over_18: true };   // not 21+
      if (mode === "declined") { verdict.approved = false; verdict.reason = "card not from a trusted issuer (stand-in)"; }
      return verdict;
    },
    async settle({ amount, currency }) {
      return { network: "dev-processor", txId: `dev_tx_${Date.now()}`, status: "settled", amount, currency };
    },
  };
}

// A tiny in-memory created-order store the dev route writes into (createStorefront reads it
// back through resolveOrder, re-pricing every line from the catalog — invariant 2).
const orders = new Map();
const createdOrderStore = {
  read: async (id) => orders.get(id) ?? null,
  write: async (id, order) => { orders.set(id, order); },
};

const store = createStorefront({
  baseUrl: `http://localhost:${PORT}`,
  allowEphemeralKey: true,          // single-process dev server
  createdOrderStore,
  verifier: standInVerifier(MODE),  // ← the only new thing vs. the built-in rails
});

// Declare the policy up front so EVERY order enforces it (no need to run a checkout first),
// and wire the SAME policy as the gate resolver so the manifest routes to the delegated page.
const hasAlcohol = (o) => (o.lines ?? []).some((l) => (l.minimumAge ?? 0) >= 21);
const ageCred = age.over(21).when(hasAlcohol);
const payCred = payment.in("usd");
const credentagent = new CredentAgent({ credentials: [ageCred, payCred] });
credentagent.mount(store.app); // zero-arg — picks the verifier up from app.locals
store.gate((order) => credentagent.requirements(order, [required(ageCred), required(payCred)]));

// ── Dev convenience: create an order and drop straight into the delegated ceremony ──
store.app.get("/dev/buy", async (req, res) => {
  const item = typeof req.query.item === "string" ? req.query.item : "oak-whiskey";
  const id = `ORD-${Math.random().toString(36).slice(2, 8)}`;
  orders.set(id, { id, lines: [{ id: item, quantity: 1 }] });
  res.redirect(`/credentagent/delegated?order=${encodeURIComponent(id)}`);
});

await new Promise((resolve) => store.app.listen(PORT, resolve));
console.log(`
  delegated-verifier demo → http://localhost:${PORT}
  verifier                → LOCAL STAND-IN (dev-only, not a real trust anchor) · mode: ${MODE}

  ▶ Open in a browser:      http://localhost:${PORT}/dev/buy
      creates an order, opens the delegated page — click "Continue" to run the ceremony.
      mode "ok" completes; wrong-amount / underage / declined are REFUSED by the gate.

  ▶ Or by hand (curl):
      REF=$(curl -s "http://localhost:${PORT}/credentagent/delegated/request?order=ORD-1" ...)
      (the /dev/buy route is the easy path — it mints the order for you.)
`);
