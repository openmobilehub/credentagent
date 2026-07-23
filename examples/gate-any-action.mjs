// "Gate ANY consequential action with ANY credential" — identity-first, NO checkout.
//
//   npm run build --workspaces       # build the @openmobilehub/credentagent-* packages
//   node examples/gate-any-action.mjs
//
// The storefront example gates a PURCHASE. This one gates a NON-commerce action — an MCP
// tool that releases sensitive records — behind an identity credential, with no payment
// anywhere. Identity leads; commerce is just one of the actions you can gate.
//
// `credentagent.gate(handler, { require, provenBy })` is the whole integration: an unproven
// call returns a TYPED REFUSAL the agent drives — share the approve link, the person proves
// the credential on their phone, the agent re-calls and the action runs. Agents detect the
// handshake with isVerificationRequired(result.structuredContent).
//
// HONESTY: the envelope + the gating decision are real today. The person proves on the
// approve_url PAGE the ceremony mount serves (see examples/storefront.mjs) — gate() warns
// below because nothing is mounted in this process. trust_level is "presence-only-demo":
// the wire crypto is real, the issuer trust anchor is not yet, so don't put a
// presence-only gate in front of anything that needs a real safety guarantee.

import { CredentAgent, age, isVerificationRequired } from "@openmobilehub/credentagent-gate";

const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });

// A sensitive action an agent might be asked to perform — NOT a purchase. The same wrap
// fits "approve-deploy", "file-prescription-refill", or "grant-access".
const releaseRecords = credentagent.gate(
  async ({ subject }) => ({ released: true, subject, records: [`record:${subject}:summary`] }),
  {
    require: age.over(21),               // the credential to prove — swap in any defineCredential
    provenBy: ({ subject }) => subject,  // self-service: the subject proves their OWN age
    //                                      (multi-user servers key by the CALLER: (_args, extra) => extra.sessionId)
    name: "release-records",
  },
);

// 1) Ungated call — the agent receives a verification_required envelope, not the records.
const refusal = await releaseRecords({ subject: "patient-7" });
console.log("\n— ungated tool call —");
console.log("  is a verification handshake:", isVerificationRequired(refusal.structuredContent));
console.log("  gate:", refusal.structuredContent.reason.gate, "| trust_level:", refusal.structuredContent.trust_level);
console.log("  agent instruction:\n   ", refusal.content[0].text);

// 2) The person proves age on the approve_url page (served by the ceremony mount), which
//    records the proof for THIS subject — simulated here by writing the store directly.
await credentagent.store.write("patient-7", { ageVerified: true });
const ok = await releaseRecords({ subject: "patient-7" });
console.log("\n— after the credential is proven —");
console.log("  ", JSON.stringify(ok), "\n");
