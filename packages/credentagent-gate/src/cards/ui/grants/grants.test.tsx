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
import { UNSAFE_LINKS } from "../__fixtures__/links";

const render = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const LIMITS = "limits enforced server-side · ";
// What the card says about consent, for each state and level (spec 015 FR-10).
const FULL_TRUST = LIMITS + "As the merchant reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.";
const NOT_APPROVED = LIMITS + "As the merchant reports it: not approved, so this grant can't spend anything.";
const REVOKED_UNUSED = LIMITS + "As the merchant reports it: revoked.";
const DEVICE_SIGNED =
  LIMITS + "As the merchant reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet.";
const NOT_RECOGNISED = LIMITS + "Trust level not recognised by this card; treat it as unverified.";

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
const revoked = g({ status: "revoked", lifecycle: "revoked", remaining: 62 }); // spent 54: it was approved
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
      const html = render(<GrantCard grant={grant} views={views} />).replace(/&#x27;/g, "'");
      // A grant nobody approved yet has no consent to describe, whatever level it carries.
      expect(html).toContain(grant.lifecycle === "pending" ? NOT_APPROVED : FULL_TRUST);
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
    // …but the literal presence token stays on every row (3 rows) + the footer sentence = 4.
    expect(count(html, "delegated-demo")).toBeGreaterThanOrEqual(4);
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

describe("Approve / Decline carry only a safe link (spec 015 FR-11)", () => {
  const opener = { openLink: () => {} };

  it("a safe link is on both buttons", () => {
    expect(count(render(<GrantCard grant={pending} actions={opener} />), `href="${pending.approveUrl}"`)).toBe(2);
  });

  // Both ways: with an openLink, as the chat apps and the storefront pass, so a check that leaned on the
  // click handler would fail; and with none, as the zero-config <GrantCard grant={grant} /> renders,
  // where no click handler runs and the href is all there is.
  for (const [how, actions] of [["with an openLink", opener], ["with no actions", undefined]] as const) {
    it.each(UNSAFE_LINKS)(`an unsafe link (%s), rendered ${how}, is never in the markup`, (approveUrl) => {
      const html = render(<GrantCard grant={{ ...pending, approveUrl }} actions={actions} />);
      expect(html).not.toContain(approveUrl);
      expect(html).not.toContain(">Approve<");
      expect(html).toContain("The merchant&#x27;s link isn&#x27;t a safe web address, so this card doesn&#x27;t show it.");
    });
  }
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

describe("trust line: the grant's state first, then the level the store reports (FR-10)", () => {
  // Read the visible sentence, not the data-* attributes that carry the same tokens.
  const line = (grant: GrantViewData): string => {
    const m = render(<GrantCard grant={grant} />).match(/<div class="[^"]*trustLine[^"]*">([^<]*)<\/div>/);
    return m ? m[1].replace(/&#x27;/g, "'") : "";
  };

  it("a device-signed grant is attributed to the store, never 'your wallet signed'", () => {
    const text = line(g({ presence: "delegated", trustLevel: "device-signed" }));
    expect(text).toBe(`🔒 delegated · ${DEVICE_SIGNED}`);
    expect(text).not.toContain("not wallet-signed");
    expect(text).not.toContain("your wallet");
  });

  it("a pending device-mode grant says not approved, not 'not wallet-signed' (the card before signing)", () => {
    const text = line(g({ status: "pending", lifecycle: "pending", presence: "delegated-demo", trustLevel: "server-issued-demo" }));
    expect(text).toBe(`🔒 delegated-demo · ${NOT_APPROVED}`);
    expect(text).not.toContain("wallet-signed");
  });

  it("a declined grant says not approved, even if it carries a signed level", () => {
    expect(line(g({ status: "denied", lifecycle: "denied", trustLevel: "device-signed" }))).toContain(NOT_APPROVED);
  });

  it("only the exact device-signed level gets the phone sentence", () => {
    for (const trustLevel of ["", "issuer-verified", "device-signed-ish", "DEVICE-SIGNED"]) {
      const text = line(g({ trustLevel }));
      expect(text, trustLevel).toContain(NOT_RECOGNISED);
      expect(text, trustLevel).not.toContain("signed on the person's phone");
    }
    expect(line(g({ trustLevel: undefined as unknown as string }))).toContain(NOT_RECOGNISED);
  });

  it("presence-only-demo says the credential is not checked against its issuer", () => {
    expect(line(g({ trustLevel: "presence-only-demo" }))).toContain("not checked against its issuer");
  });

  it("a grant revoked while pending (nothing spent) says revoked, not 'approved with a click'", () => {
    const text = line(g({ status: "revoked", lifecycle: "revoked", spent: 0, remaining: 200 }));
    expect(text).toBe(`🔒 delegated-demo · ${REVOKED_UNUSED}`);
  });

  it("a revoked grant that spent keeps its level's sentence (it was approved)", () => {
    expect(line(g({ status: "revoked", lifecycle: "revoked", spent: 54 }))).toContain("approved with a click on a page");
  });

  it("a mixed list shows one line per distinct sentence, not the first grant's for all", () => {
    const html = render(<GrantList grants={[g({ id: "a" }), g({ id: "b", presence: "delegated", trustLevel: "device-signed" })]} />);
    expect(count(html, "a demo, approved with a click on a page")).toBe(1);
    expect(count(html, "signed on the person&#x27;s phone")).toBe(1);
  });
});
