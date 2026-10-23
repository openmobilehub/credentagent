// Grant gallery tests (spec 011). The load-bearing one is HONESTY: every view — stock or custom,
// card or dense row — renders the non-omittable trust line (FR-4). The bypass discipline: these
// assertions go RED if the frame becomes skippable (remove <TrustLine/> from Frame and the trust
// text vanishes — the honesty test fails). Also covers the display-only projection (A1), the
// specificity selection (A3), and the BudgetMeter severity + aria (FR-3).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { GrantCard, GrantList, grantViews, defineGrantView, BudgetMeter } from "./index";
import type { GrantViewContext, GrantViewData } from "./index";
import styles from "./grants.module.css";

const render = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// The base grant below is an authorized click-to-approve grant; a pending one says it is not approved yet.
const FULL_TRUST = "🔒 Limits enforced server-side. As the store reports it: a demo, approved with a click on a page";
const NOT_APPROVED = "🔒 Limits enforced server-side. Not approved yet";
const REVOKED = "🔒 Limits enforced server-side. Revoked — nothing can be spent.";

const base: GrantViewData = {
  kind: "credentagent.grant",
  id: "grant_test",
  merchant: "Utopia",
  status: "authorized",
  lifecycle: "active",
  budget: 200,
  spent: 54,
  remaining: 146,
  perSpend: 130,
  allow: { skus: [], categories: [] },
  approveUrl: "http://localhost:3005/credentagent/grants/grant_test",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
};
const g = (over: Partial<GrantViewData>): GrantViewData => ({ ...base, ...over });

// One grant that selects each stock view.
const product = g({ allow: { skus: ["oak-whiskey"], categories: [] }, product: { id: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, currency: "USD", category: "Beverages" } });
const category = g({ allow: { skus: ["drift-mouse"], categories: ["Beverages", "Electronics"] } });
const open = g({ allow: { skus: [], categories: [] } });
const pending = g({ status: "pending", lifecycle: "pending" });
const revoked = g({ status: "revoked", lifecycle: "revoked", remaining: 62 });
const exhausted = g({ lifecycle: "exhausted", remaining: 0, spent: 200 });

describe("honesty frame — the non-omittable trust line (FR-4, bypass-tested)", () => {
  // Every stock view rendered via its selecting grant must carry the FULL trust sentence AND both
  // literal presence/trustLevel tokens. This fails if the frame stops rendering the trust line.
  const cases: Array<[string, GrantViewData, Parameters<typeof GrantCard>[0]["views"]?]> = [
    ["productGrantCard", product],
    ["categoryGrantCard", category],
    ["openGrantCard", open],
    ["approvalCard", pending],
    ["terminalCard(revoked)", revoked],
    ["terminalCard(exhausted)", exhausted],
    ["budgetMeter (explicit)", open, [grantViews.budgetMeter]],
  ];
  for (const [label, grant, views] of cases) {
    it(`${label} renders the trust line + presence/trustLevel tokens`, () => {
      const html = render(<GrantCard grant={grant} views={views} />);
      expect(html).toContain(grant.status === "pending" ? NOT_APPROVED : grant.status === "revoked" ? REVOKED : FULL_TRUST);
      expect(html).toContain("delegated-demo");
      expect(html).toContain("server-issued-demo");
    });
  }

  it("a CUSTOM defineGrantView renders inside the frame with the same trust line (no gallery edit)", () => {
    const wineClub = defineGrantView({
      id: "wine-club-row",
      // A niche view scored to win its category over the stock category card (design §9 A3).
      fits: (grant) => (grant.allow.categories.includes("Wine") ? 60 : false),
      body: ({ grant }) => (
        <div>
          <span>Utopia Wine Club</span>
          <BudgetMeter grant={grant} />
        </div>
      ),
    });
    const wineGrant = g({ allow: { skus: [], categories: ["Wine"] } });
    const html = render(<GrantCard grant={wineGrant} views={[wineClub, ...grantViews.all]} accent="#7c3aed" />);
    expect(html).toContain("Utopia Wine Club"); // the custom body rendered
    expect(html).toContain(FULL_TRUST); // …still inside the immovable frame
    expect(html).toContain("delegated-demo");
  });

  it("dense layout (A7): full sentence de-duplicates to the container; each row keeps the literal token", () => {
    const grants = [
      g({ id: "a", merchant: "Utopia", remaining: 146 }),
      g({ id: "b", merchant: "Utopia", remaining: 16, lifecycle: "low" }),
      g({ id: "c", merchant: "Utopia", remaining: 0, lifecycle: "exhausted" }),
    ];
    const html = render(<GrantList grants={grants} />);
    // The full trust SENTENCE appears exactly once (the container footer) — repetition would
    // train the eye to skip it.
    expect(count(html, FULL_TRUST)).toBe(1);
    // …but the literal presence token stays on every row (3 rows); the footer sentence no longer
    // repeats it (spec 015 FR-10: the sentence is the card's own words, the data rides as data).
    expect(count(html, "delegated-demo")).toBeGreaterThanOrEqual(3);
  });
});

describe("the trust line says how THIS grant's consent was given (#429, spec 015 FR-10)", () => {
  const line = (grant: GrantViewData): string => render(<GrantCard grant={grant} />);
  const phoneSigned = g({ presence: "delegated", trustLevel: "device-signed" });

  it("a grant signed with the wallet says so, and never 'not wallet-signed'", () => {
    const html = line(phoneSigned);
    expect(html).toContain("As the store reports it: signed on the person&#x27;s phone");
    expect(html).not.toContain("not wallet-signed");
    expect(html).not.toContain("approved with a click");
  });

  it("a click-to-approve grant says nothing was signed on a phone", () => {
    expect(line(open)).toContain("approved with a click on a page — nothing was signed on a phone");
  });

  it("a pending grant claims no consent at all — even though it reports server-issued-demo before signing", () => {
    const html = line(g({ status: "pending", lifecycle: "pending", trustLevel: "server-issued-demo" }));
    expect(html).toContain("Not approved yet — nothing can be spent until the person approves.");
    expect(html).not.toContain("approved with a click");
    expect(html).not.toContain("signed on the person");
  });

  it("a declined grant says nothing can be spent", () => {
    expect(line(g({ status: "denied", lifecycle: "denied" }))).toContain("Declined — nothing can be spent.");
  });

  it("a grant revoked before anyone approved it never claims an approval", () => {
    // What revoking a PENDING grant projects: status revoked, and the server-issued-demo fallback level
    // a grant nobody approved reports — the same level a click-approved grant has.
    const html = line(g({ status: "revoked", lifecycle: "revoked", spent: 0, remaining: 200, trustLevel: "server-issued-demo" }));
    expect(html).toContain("Revoked — nothing can be spent.");
    expect(html).not.toContain("approved with a click");
  });

  it("a wallet-signed grant revoked later still says how it was signed", () => {
    expect(line(g({ ...phoneSigned, status: "revoked", lifecycle: "revoked" }))).toContain("signed on the person&#x27;s phone");
  });

  it("a level the card does not know — even issuer-verified from the server's word — is never shown as given", () => {
    // …including names every JavaScript object inherits, which a plain property lookup would find.
    for (const trustLevel of ["issuer-verified", "totally-trusted", "", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const html = line(g({ trustLevel }));
      expect(html).toContain("Trust level not recognised by this card; treat it as unverified.");
      expect(html).not.toContain("As the store reports it");
    }
  });

  it("a dense list of grants approved in different ways puts each one's sentence on its own row", () => {
    const html = render(<GrantList grants={[open, phoneSigned, g({ id: "c", status: "pending", lifecycle: "pending" })]} />);
    const rows = html.split(`class="${styles.mrow}"`).slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("approved with a click on a page");
    expect(rows[1]).toContain("signed on the person&#x27;s phone");
    expect(rows[2]).toContain("Not approved yet");
    expect(html).not.toContain(styles.listTrust); // no shared footer to mismatch them
  });
});

describe("display-only projection (A1) — a view can never touch the live grant", () => {
  it("body receives inert GrantViewData: no spend()/revoke() methods, just data + the marker", () => {
    const seen: GrantViewContext[] = [];
    const spy = defineGrantView({ id: "spy", fits: () => 1, body: (ctx) => { seen.push(ctx); return <span>spy</span>; } });
    render(<GrantCard grant={product} views={[spy]} />);
    expect(seen).toHaveLength(1);
    const received = seen[0].grant as GrantViewData & { spend?: unknown; revoke?: unknown };
    expect(received.kind).toBe("credentagent.grant");
    expect(received.spend).toBeUndefined();
    expect(received.revoke).toBeUndefined();
    expect(typeof received.remaining).toBe("number"); // the computed money is present
  });
});

describe("selection by specificity (A3) — highest score wins, not array order", () => {
  it("a pending grant selects the approvalCard over the active cards", () => {
    const html = render(<GrantCard grant={pending} />);
    expect(html).toContain("Approve a spending grant"); // approvalCard body
    expect(html).toContain("Opens the CredentAgent approval page"); // its disclosed deep-link
  });

  it("a single-SKU grant selects the flagship productGrantCard over the categoryGrantCard", () => {
    const html = render(<GrantCard grant={product} />);
    expect(html).toContain("Oak Reserve Whiskey"); // product tile
    expect(html).toContain("per purchase"); // qty math
  });

  it("a custom high-score view shadows every stock view; array order is only a tie-break", () => {
    const win = defineGrantView({ id: "win", fits: () => 999, body: () => <span>CUSTOM-WON</span> });
    const alsoHigh = defineGrantView({ id: "tie", fits: () => 999, body: () => <span>SECOND</span> });
    const html = render(<GrantCard grant={product} views={[win, alsoHigh, ...grantViews.all]} />);
    expect(html).toContain("CUSTOM-WON");
    expect(html).not.toContain("SECOND"); // equal score → first in array wins
    expect(html).not.toContain("Oak Reserve Whiskey"); // the stock product view did NOT win
  });
});

describe("<BudgetMeter/> — severity (FIXED colors) + accessible value text (FR-3)", () => {
  it("healthy: teal accent fill, aria-valuetext carries the money + cap", () => {
    const html = render(<div>{BudgetMeter({ grant: g({ lifecycle: "active", remaining: 146 }) })}</div>);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="146"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain("$146 of $200 remaining · up to $130 per purchase");
    expect(html).not.toContain(styles.meterFillLow);
    expect(html).not.toContain(styles.meterFillCrit);
  });

  it("low: FIXED amber fill class; the cap notes the budget now caps the next purchase", () => {
    const html = render(<div>{BudgetMeter({ grant: g({ lifecycle: "low", remaining: 28, spent: 172 }) })}</div>);
    expect(html).toContain(styles.meterFillLow); // amber — never the accent
    expect(html).toContain("budget caps next purchase at $28"); // remaining < perSpend overshoot
  });

  it("exhausted: FIXED red fill class; headline flips to 'used', value pinned at 0", () => {
    const html = render(<div>{BudgetMeter({ grant: g({ lifecycle: "exhausted", remaining: 0, spent: 200 }) })}</div>);
    expect(html).toContain(styles.meterFillCrit); // red — never the accent
    expect(html).toContain("of $200 used"); // headline flips from "remaining" to "used"
    expect(html).toContain('aria-valuenow="0"');
  });

  it("a branded accent themes the healthy fill but NOT the status colors (they stay fixed)", () => {
    // The low fill is the fixed amber class regardless of the host accent override.
    const html = render(<GrantCard grant={g({ lifecycle: "low", remaining: 28 })} accent="#7c3aed" />);
    expect(html).toContain(styles.meterFillLow);
    expect(html).toContain("#7c3aed"); // the accent override is applied to the container
  });
});
