// device-signed-grants.mjs — the wallet SIGNS the spending grant first (spec 012, #144).
//
//   npm run build --workspaces                       # once, if not built
//   node examples/device-signed-grants.mjs           # → runs the full ceremony in-process
//
// A spending grant is an AP2 "Intent Mandate" — the record of "here is what I authorize an
// agent to spend on my behalf while I'm away". Today a grant is approved with one click on a
// server page. This example opts a grant into DEVICE signing: its approveUrl serves a signing
// ceremony, and it only reaches "authorized" once a wallet on the phone signs its exact bounds.
//
// The phone is SIMULATED in-process here (devSimulateWalletSignature) so the whole flow runs
// with no device — the way Stripe's test cards let you exercise a charge without a real card.
// The signature the gate verifies is a REAL mdoc DeviceAuth ES256 signature; what stays demo is
// the trust ANCHOR (the payment credential is self-minted — no issuer check yet, issue #14), so
// the gate reports trust_level "device-signed", never "issuer-verified". The maintainer's
// on-device test (import payment.mpzpass into Multipaz, sign on a Pixel) is what proves the real
// wallet path — that step is still open.
import express from "express";
import { CredentAgent, devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 4030);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

// Configure once. `gateSecret` seals the signing ceremony; the priced catalog bounds spends.
const credentagent = new CredentAgent({
  walletOrigin: ORIGIN,
  gateSecret: "example-gate-secret",
  catalog: { coffee: { price: 18, category: "Beverages" }, "espresso-machine": { price: 120, category: "Beverages" } },
});

const app = express();
app.use(express.json());
credentagent.grants.serve(app); // serves the approve/sign pages + the /sign endpoints
const server = app.listen(PORT);

const step = (s) => console.log(s);

try {
  // 1) Open a grant that must be DEVICE-signed (additive: omit `signing` for today's page-approve).
  const grant = await credentagent.grants.create({
    merchant: "utopia",
    budget: 200,
    perSpend: 130,
    allow: { categories: ["Beverages"] },
    signing: "device",
    description: "Coffee runs while I'm away — up to $200 at Utopia, $130 per purchase.",
  });
  step(`1. created grant ${grant.id} · signing=${grant.signing} · status=${grant.status}`);
  step(`   send this to the phone → ${grant.approveUrl}`);

  // 2) The phone opens approveUrl and signs. Here we SIMULATE that: fetch the request the
  //    signing page would, produce a real device signature over the bounds, and POST it back.
  const reqRes = await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/request`);
  const oid = await reqRes.json();
  step(`2. wallet received the signed request (trust_level=${oid.trust_level})`);

  const walletResult = await devSimulateWalletSignature({
    request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query },
    origin: ORIGIN,
  });
  const verifyRes = await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ readerContextToken: oid.readerContextToken, result: walletResult }),
  });
  const verdict = await verifyRes.json();
  step(`3. gate verified the DEVICE signature → ok=${verdict.ok} · trustLevel=${verdict.trustLevel} · verifiedBy=${verdict.verifiedBy}`);

  // 3) The grant is now authorized — ONLY because the device signature verified.
  const signed = await credentagent.grants.retrieve(grant.id);
  step(`4. grant status=${signed.status} · trustLevel=${signed.trustLevel}`);
  step(`   mandate: boundsHash=${signed.mandate.boundsHash.slice(0, 16)}… · doctype=${signed.mandate.credentialDoctype} · signedAt=${signed.mandate.signedAt}`);

  // 4) The agent spends within the signed bounds — and every spend traces to the signed mandate.
  const buy = await signed.spend({ idempotencyKey: "coffee-run-1", items: [{ sku: "coffee" }] });
  step(`5. spend → ok=${buy.ok} · $${buy.amount} · remaining $${buy.remaining}`);
  step(`   this spend draws against Intent Mandate ${buy.mandate.id} (boundsHash ${buy.mandate.boundsHash.slice(0, 16)}…)`);

  // The invariant this establishes: signed by the device FIRST, spent by the agent SECOND. A
  // device-mode grant that was never device-signed can never spend; try it and watch it refuse.
  const unsigned = await credentagent.grants.create({ merchant: "utopia", budget: 50, perSpend: 20, signing: "device" });
  const refused = await unsigned.spend({ idempotencyKey: "x", items: [{ sku: "coffee" }] });
  step(`6. spend on an UNSIGNED device grant → ok=${refused.ok} · code=${refused.code}`);

  if (!verdict.ok || signed.trustLevel !== "device-signed" || !buy.ok || refused.ok) {
    throw new Error("device-signed grant example did not behave as expected");
  }
  step("\n✓ signed by the device first, spent by the agent second.");
} finally {
  server.close();
}
