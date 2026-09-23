// The rail's DCQL pinned to the credential a REAL wallet holds.
//
// This is the test the rail was missing. simulate.ts mints its credential from the same
// constant verify.ts checks, so every in-process test agrees with itself no matter what
// the constant says — only a phone could show a mismatch. These assertions use LITERALS
// taken from the committed demo-PKI fixture, so they break the moment the request drifts
// from the credential the toolkit actually mints.
//
// The literals below come from `tools/demo-pki/out/payment.mpzpass`. Re-derive them with:
//   python3 tools/demo-pki/mint/inspect_mpzpass.py tools/demo-pki/out/payment.mpzpass
// (documented in tools/demo-pki/mint/README.md).
import { describe, it, expect } from "vitest";
import { buildIntentSignDcql, PAYMENT_CREDENTIAL_DOCTYPE, PAYMENT_INSTRUMENT_CLAIM } from "./dcql.js";
import { buildDcPaymentDcql } from "../dc-payment/dcql.js";

/** The doctype `payment.mpzpass` mints — NOT `org.openwallet.payment.1`. */
const FIXTURE_DOCTYPE = "org.multipaz.payment.sca.1";
/** The instrument leaf the fixture discloses — it has no `account` element at all. */
const FIXTURE_INSTRUMENT_CLAIM = "payment_instrument_id";

describe("intent-sign DCQL matches the credential a wallet actually holds", () => {
  it("asks for the doctype the demo-PKI toolkit mints", () => {
    expect(PAYMENT_CREDENTIAL_DOCTYPE).toBe(FIXTURE_DOCTYPE);
    const q = buildIntentSignDcql();
    expect(q.credentials).toHaveLength(1);
    expect(q.credentials[0].format).toBe("mso_mdoc");
    expect(q.credentials[0].meta?.doctype_value).toBe(FIXTURE_DOCTYPE);
  });

  it("requires a claim the fixture can disclose (never the absent `account`)", () => {
    expect(PAYMENT_INSTRUMENT_CLAIM).toBe(FIXTURE_INSTRUMENT_CLAIM);
    const leaves = (buildIntentSignDcql().credentials[0].claims ?? []).map((c) => c.path.at(-1));
    expect(leaves).toContain(FIXTURE_INSTRUMENT_CLAIM);
    expect(leaves).not.toContain("account");
  });

  it("namespaces every claim under that same doctype", () => {
    for (const claim of buildIntentSignDcql().credentials[0].claims ?? []) {
      expect(claim.path[0]).toBe(FIXTURE_DOCTYPE);
    }
  });

  it("is the SAME query the dc-payment rail sends — one source of truth, no drift", () => {
    expect(buildIntentSignDcql()).toEqual(buildDcPaymentDcql());
  });
});
