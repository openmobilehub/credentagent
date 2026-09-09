// AP2 delegation probe — does a real wallet sign an AP2 Mandate?
//
// WHAT THIS ANSWERS (spec 014, FR-2). The Agent Payments Protocol delegates a mandate during
// an ordinary OpenID4VP presentation: the verifier puts the Mandate Content in a
// `transaction_data` entry of type `delegate`, and AP2 requires that the wallet return it
// "included as part of the Key Binding". Nothing in this repository has ever sent such a
// request, and no wallet here has ever answered one. This is the smallest thing that finds
// out, on a real phone.
//
// It is a PROBE, not a rail. It does not price anything, gate anything or complete anything,
// and no security decision depends on it. The real rail is FR-2 of spec 014; building that
// before knowing the ceremony works on a device would be building on a guess.
//
// The request is deliberately the simplest that can work: `openid4vp-v1-unsigned` with an
// unencrypted `dc_api` response. Fewer moving parts means a failure points at the delegation
// mechanism rather than at reader certificates or response encryption.
//
// REQUIRES a wallet whose Multipaz build registers the AP2 `delegate` transaction type.
// Stock Multipaz hard-rejects an unregistered type — `parseJsonTransactions` throws — so the
// whole request fails before the wallet can show anything. See
// TheBlackBit/multipaz @ feat/ap2-delegate-transaction.
//
// Usage:
//   node tools/ap2-delegate-probe/server.mjs
//   adb reverse tcp:4050 tcp:4050
//   → open http://localhost:4050 in Chrome ON THE PHONE
import express from "express";
import { randomUUID, webcrypto } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4050);
const ORIGIN = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/**
 * The credential types the probe will accept. DCQL `vct_values` is a list, so asking for
 * several costs nothing and saves a round trip to the phone when the wallet holds the card
 * under a different identifier: AP2's example uses `com.emvco.dpc`, while Multipaz registers
 * `urn:emvco:dpc:card:1` for its own SD-JWT payment credential.
 */
const VCTS = (process.env.DPC_VCT || "com.emvco.dpc,urn:emvco:dpc:card:1,org.multipaz.payment.sca.1").split(",").map((v) => v.trim()).filter(Boolean);

const b64u = (obj) => Buffer.from(JSON.stringify(obj), "utf-8").toString("base64url");
const rand = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");

/**
 * The two AP2 "open" mandates a human authorizes for an agent to spend later.
 *
 * `cnf` is the AGENT's key — AP2 binds an open mandate "to a particular Agent who is allowed
 * to use the Mandate", and the human is not present at spend time so their key cannot be the
 * presentation key. A placeholder here: the probe is testing the ceremony, not the chain.
 */
const openMandates = (agentJwk) => [
  {
    vct: "mandate.checkout.open.1",
    constraints: [
      { type: "checkout.allowed_merchants", allowed: [{ id: "utopia", name: "Utopia Store" }] },
      { type: "checkout.line_items", allowed: ["coffee", "espresso-machine"] },
    ],
    cnf: { jwk: agentJwk },
  },
  {
    vct: "mandate.payment.open.1",
    constraints: [
      { type: "payment.amount_range", currency: "USD", max: 13000 },
      { type: "payment.budget", currency: "USD", max: 20000 },
    ],
    cnf: { jwk: agentJwk },
  },
];

/** A throwaway agent key. The real one is generated and held by the agent (spec 014, FR-5). */
async function agentKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { kty, crv, x, y } = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty, crv, x, y };
}

const app = express();
app.use(express.json({ limit: "4mb" }));

const sessions = new Map(); // nonce → what we asked for, so /result can compare

app.get("/request", async (_req, res) => {
  const nonce = rand();
  const mandates = openMandates(await agentKey());

  // Entry 0 — what the HUMAN reads. AP2 defines this display payload; Multipaz renders only
  // the transaction type's name ("Payment"), never the amount, so the page is still the
  // reading surface. Sent anyway: it is what AP2 specifies, and a wallet that learns to
  // render it should find it here.
  const payment = {
    type: "urn:eudi:sca:payment:1",
    credential_ids: ["dpc_credential"],
    transaction_data_hashes_alg: ["sha-256"],
    payee: { id: "utopia", name: "Utopia Store" },
    amount: 130.0,
    currency: "USD",
    transaction_id: randomUUID(),
  };

  // Entry 1 — what the WALLET SIGNS. The delegate mechanism itself.
  const delegate = {
    type: "delegate",
    format: "dc+sd-jwt",
    credential_ids: ["dpc_credential"],
    transaction_data_hashes_alg: ["sha-256"],
    delegate_payload: mandates,
  };

  const request = {
    response_type: "vp_token",
    response_mode: "dc_api", // unencrypted, on purpose — see the header
    nonce,
    // `client_id` is omitted: OpenID4VP requires that for unsigned requests.
    dcql_query: {
      credentials: [
        // CONTROL MODE. `FORMAT=mso_mdoc` asks for the mdoc payment credential instead — the
        // one this project has always used. It cannot carry a delegation (Delegate SD-JWT is
        // SD-JWT syntax), so it is useless for the real ceremony; it is here to tell a broken
        // request shape apart from a credential the wallet will not offer.
        process.env.FORMAT === "mso_mdoc"
          ? {
              id: "dpc_credential",
              format: "mso_mdoc",
              meta: { doctype_value: "org.multipaz.payment.sca.1" },
              claims: [{ path: ["org.multipaz.payment.sca.1", "masked_account_reference"] }],
            }
          : {
              id: "dpc_credential",
              format: "dc+sd-jwt",
              meta: { vct_values: VCTS },
              // A claim the credential actually carries. The matcher appears to need one for
              // `dc+sd-jwt`: with `meta` alone the wallet reports no matching credential.
              claims: [{ path: ["masked_account_reference"] }],
            },
      ],
    },
    // PaymentTransaction.isApplicable requires `vct == org.multipaz.payment.sca.1`; our
    // credential is a different type, so including that entry makes the whole presentation
    // fail. Set WITH_PAYMENT=1 to send it anyway (it is what AP2's example does, and it is
    // what a wallet would render once it learns to).
    transaction_data: process.env.WITH_PAYMENT ? [b64u(payment), b64u(delegate)] : [b64u(delegate)],
  };

  sessions.set(nonce, { mandates, at: Date.now() });
  console.log(`\n  → request built · nonce ${nonce.slice(0, 12)}… · vct ${VCTS.join(" | ")}`);
  res.json({ protocol: "openid4vp-v1-unsigned", data: request, nonce });
});

app.post("/result", (req, res) => {
  const { nonce, response, error } = req.body ?? {};
  if (error) {
    console.log(`\n  ✗ the wallet refused: ${error}\n`);
    return res.json({ ok: false, error });
  }

  const asked = sessions.get(nonce);
  const vpToken = response?.vp_token?.dpc_credential?.[0] ?? response?.vp_token?.dpc_credential;
  if (typeof vpToken !== "string") {
    console.log(`\n  ? unexpected response shape:\n${JSON.stringify(response).slice(0, 600)}\n`);
    return res.json({ ok: false, error: "no vp_token for dpc_credential", response });
  }

  // An SD-JWT presentation is `<jwt>~<disclosure>~…~<kb-jwt>`. The KB-JWT is the last part,
  // and it is where AP2 requires the delegate payload to be.
  const parts = vpToken.split("~");
  const kbJwt = parts[parts.length - 1];
  let kb;
  try {
    kb = JSON.parse(Buffer.from(kbJwt.split(".")[1], "base64url").toString("utf-8"));
  } catch {
    console.log(`\n  ✗ no readable KB-JWT — the wallet returned ${parts.length} parts, last: ${kbJwt.slice(0, 40)}…\n`);
    return res.json({ ok: false, error: "no KB-JWT" });
  }

  const delegated = kb._delegate_payload;
  console.log(`\n  KB-JWT claims: ${Object.keys(kb).join(", ")}`);

  if (!Array.isArray(delegated)) {
    console.log(`  ✗ NO _delegate_payload in the key binding.`);
    console.log(`    The wallet signed something, but not the mandates. AP2 requires them here.\n`);
    return res.json({ ok: false, error: "_delegate_payload missing", kb });
  }

  // The whole point: did the mandates survive verbatim into what the human signed?
  const same = asked && JSON.stringify(delegated) === JSON.stringify(asked.mandates);
  console.log(`  ✓ _delegate_payload present — ${delegated.length} mandate(s)`);
  console.log(`    ${delegated.map((m) => m.vct).join(" · ")}`);
  console.log(`  ${same ? "✓ verbatim: identical to what we asked the wallet to sign" : "✗ CHANGED in transit — the signature does not cover what we requested"}\n`);
  res.json({ ok: true, verbatim: !!same, mandates: delegated, kb });
});

// Serve the credential for import. A phone cannot open a `file://` path pushed with adb —
// Android's scoped storage denies the wallet read access, and the import fails with an IO
// error that looks nothing like a permissions problem. Downloading it through the browser
// hands the wallet a `content://` URI it is allowed to read.
app.get("/dpc.mpzpass", (_req, res) => {
  const file = process.env.MPZPASS || "";
  if (!file) return res.status(404).send("set MPZPASS=/path/to/dpc.mpzpass");
  res.setHeader("content-type", "application/vnd.multipaz.mpzpass");
  res.setHeader("content-disposition", 'attachment; filename="dpc.mpzpass"');
  res.sendFile(file);
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AP2 delegation probe</title>
<body style="font-family:system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>AP2 delegation probe</h1>
<p>Asks your wallet to sign two AP2 open mandates — <em>"an agent may buy coffee at Utopia,
up to $130 a purchase, $200 total"</em> — using the delegation mechanism AP2 specifies.</p>
<p><b>The wallet screen will only say "Payment".</b> It does not render the terms in any
credential format; that is a wallet limitation, not a missing signature.</p>
<button id="go" style="font-size:1.1rem;padding:.7rem 1.4rem">Authorize on this device</button>
<pre id="out" style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:1rem;border-radius:.5rem;margin-top:1.5rem"></pre>
<script>
const out = document.getElementById('out');
const log = (s) => { out.textContent += s + "\\n"; };
document.getElementById('go').onclick = async () => {
  out.textContent = '';
  try {
    if (!navigator.credentials || !('DigitalCredential' in window)) {
      log('✗ This browser has no Digital Credentials API. Use Chrome on Android, signed in.');
      return;
    }
    log('… building request');
    const { protocol, data, nonce } = await (await fetch('/request')).json();
    log('… calling the wallet');
    const cred = await navigator.credentials.get({
      digital: { requests: [{ protocol, data }] },
      mediation: 'required',
    });
    const raw = cred.data ?? cred;
    const response = typeof raw === 'string' ? JSON.parse(raw) : raw;
    log('… wallet answered, checking the key binding');
    const verdict = await (await fetch('/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, response }),
    })).json();
    if (verdict.ok) {
      log('✓ SIGNED — the key binding carries ' + verdict.mandates.length + ' mandate(s):');
      verdict.mandates.forEach(m => log('    ' + m.vct));
      log(verdict.verbatim ? '✓ verbatim — identical to what was requested'
                           : '✗ the payload CHANGED in transit');
    } else {
      log('✗ ' + verdict.error);
    }
  } catch (e) {
    log('✗ ' + (e && e.message ? e.message : String(e)));
    await fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String(e && e.message || e) }) }).catch(() => {});
  }
};
</script>
</body>`);
});

app.listen(PORT, () => {
  console.log(`\n  AP2 delegation probe on :${PORT} · origin ${ORIGIN}`);
  console.log(`  asking for vct: ${VCTS.join(" | ")}   (override with DPC_VCT=a,b)`);
  console.log(`\n  NEEDS a wallet built with the AP2 \`delegate\` transaction type registered.`);
  console.log(`  Stock Multipaz rejects the whole request with "Unknown transaction type 'delegate'".`);
  console.log(`\n  1. adb reverse tcp:${PORT} tcp:${PORT}`);
  console.log(`  2. open this on the PHONE, in Chrome:\n`);
  console.log(`       http://localhost:${PORT}\n`);
  console.log(`  waiting… (ctrl-c to stop)\n`);
});
