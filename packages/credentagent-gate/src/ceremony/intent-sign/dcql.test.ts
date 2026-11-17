// The rail's DCQL pinned to what a REAL wallet will actually answer.
//
// This is the test the rail was missing before, and it matters more since spec 014, not less.
// `simulate.ts` mints a credential that discloses every claim whatever the query asks for, so the
// in-process presentation tests cannot see a query a phone would not match — only a phone can
// show that. These assertions therefore use LITERALS, and they pin the shapes that were found to
// fail silently on a device.
import { describe, it, expect } from "vitest";
import { buildIntentSignDcql, PAYMENT_CREDENTIAL_ID, PAYMENT_CREDENTIAL_VCTS } from "./dcql.js";

/** What `tools/demo-pki/mint/mint-dpc-sdjwt.mjs` puts in `vct`, and AP2's own example value. */
const MINTED_VCT = "urn:emvco:dpc:card:1";
const AP2_EXAMPLE_VCT = "com.emvco.dpc";
/** The instrument leaf the minted credential discloses. */
const FIXTURE_INSTRUMENT_CLAIM = "payment_instrument_id";
/** The claims the official Multipaz Payment card (`payment_sca_sd_jwt`) carries, as read from
 *  Multipaz `main`. A phone run (2026-11-13) matched the card on `credential_id`; `network` and
 *  `last_four` are not requested, so they are not confirmed on a device. */
const OFFICIAL_CARD_CLAIMS = ["credential_id", "network", "last_four"];

describe("intent-sign DCQL matches the credential a wallet actually holds", () => {
  it("asks for the payment credential as an SD-JWT VC", () => {
    const q = buildIntentSignDcql() as unknown as {
      credentials: { id: string; format: string; meta?: { vct_values?: string[] }; claims?: { path: string[] }[] }[];
    };
    expect(q.credentials).toHaveLength(1);
    // mdoc cannot carry an AP2 delegation: the chain format is SD-JWT syntax and mdoc has no
    // equivalent. Asking for one would make the ceremony unbuildable, not merely different.
    expect(q.credentials[0].format).toBe("dc+sd-jwt");
    expect(q.credentials[0].meta?.vct_values).toContain(MINTED_VCT);
  });

  it("also accepts AP2's example credential type, so a naming difference costs no device session", () => {
    expect([...PAYMENT_CREDENTIAL_VCTS]).toEqual(expect.arrayContaining([MINTED_VCT, AP2_EXAMPLE_VCT]));
  });

  // Found on a device: with `meta.vct_values` alone the wallet answers "Your info wasn't
  // found" — the same message it gives when it holds no credential at all. An mdoc query
  // matches on `meta` alone, which is what made this hard to see. Deleting `claims` from the
  // query is therefore a silent, total break, and this is the test that catches it.
  it("REQUIRES a claims entry — a dc+sd-jwt query with meta alone matches nothing", () => {
    const claims = (buildIntentSignDcql() as unknown as { credentials: { claims?: { path: string[] }[] }[] })
      .credentials[0].claims;
    expect(claims).toBeDefined();
    expect(claims!.length).toBeGreaterThan(0);
  });

  it("requires a claim the minted credential can disclose", () => {
    const leaves = ((buildIntentSignDcql() as unknown as { credentials: { claims?: { path: string[] }[] }[] })
      .credentials[0].claims ?? []).map((c) => c.path.at(-1));
    expect(leaves).toContain(FIXTURE_INSTRUMENT_CLAIM);
  });

  it("matches the official Multipaz card: asks for a claim it carries (credential_id)", () => {
    const query = buildIntentSignDcql() as unknown as {
      credentials: { claims?: { path: string[] }[] }[];
    };
    const leaves = (query.credentials[0].claims ?? []).map((claim) => claim.path.at(-1));
    // At least one requested claim must exist on the official card.
    expect(leaves.some((leave) => OFFICIAL_CARD_CLAIMS.includes(leave!))).toBe(true);
  });

  // Asking for two claims WITHOUT `claim_sets` means "both", and no single card carries both —
  // the official card has no payment_instrument_id and the test card has no credential_id. Delete
  // `claim_sets` from dcql.ts and every card stops matching, yet the test above still passes.
  it("offers one option per card: an official-card option and a test-card option, not 'both'", () => {
    const cred = (buildIntentSignDcql() as unknown as {
      credentials: { claims: { id: string; path: string[] }[]; claim_sets?: string[][] }[];
    }).credentials[0];
    expect(cred.claim_sets).toBeDefined();
    // The exact options, official card first. Spelled as literals so a change here is deliberate.
    expect(cred.claim_sets).toEqual([["credential_id"], ["payment_instrument_id"]]);
    const leafOf = new Map(cred.claims.map((c) => [c.id, c.path.at(-1)]));
    const options = cred.claim_sets!.map((set) => set.map((id) => leafOf.get(id)));
    // Every option names a claim that exists in `claims`, and none is empty (`every` below is
    // vacuously true for an empty option, which no card could ever match) ...
    for (const option of options) {
      expect(option.length).toBeGreaterThan(0);
      expect(option).not.toContain(undefined);
    }
    // ... one option is answerable by the official card alone ...
    expect(options.some((o) => o.every((l) => OFFICIAL_CARD_CLAIMS.includes(l!)))).toBe(true);
    // ... and one by the test card alone.
    expect(options.some((o) => o.every((l) => l === FIXTURE_INSTRUMENT_CLAIM))).toBe(true);
  });

  // SD-JWT claim paths are top-level names. Namespacing them the way an mdoc query does
  // (`[doctype, leaf]`) is a shape a wallet will not match.
  it("does not namespace claims the way an mdoc query would", () => {
    for (const claim of (buildIntentSignDcql() as unknown as { credentials: { claims?: { path: string[] }[] }[] })
      .credentials[0].claims ?? []) {
      expect(claim.path).toHaveLength(1);
    }
  });

  // `transaction_data.credential_ids` must reference this id. A mismatch there is one of the
  // ways the whole presentation fails with an error that points nowhere near the cause.
  it("uses the credential id the transaction data references", () => {
    const q = buildIntentSignDcql() as unknown as { credentials: { id: string }[] };
    expect(q.credentials[0].id).toBe(PAYMENT_CREDENTIAL_ID);
  });
});
