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
import { NOT_APPROVED_TRUST, REVOKED_TRUST, UNRECOGNISED_TRUST } from "../trust";

const render = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// The kit's fixed sentence for `server-issued-demo` (spec 015 FR-10), the level every fixture below carries.
const FULL_TRUST = "🔒 As the merchant reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.";
const DEVICE_SIGNED =
  "🔒 As the merchant reports it: signed on the person&#x27;s phone. This card did not check that signature, and the credential is not checked against its issuer yet.";
// The lines of a grant whose level isn't shown, whatever it is: pending or declined, and revoked with
// nothing spent.
const NOT_APPROVED = `🔒 ${NOT_APPROVED_TRUST.replace("can't", "can&#x27;t")}`;
const REVOKED = `🔒 ${REVOKED_TRUST}`;
const NOT_RECALLED = "If you signed it, the agent keeps its signed copy: revoking doesn&#x27;t recall it.";

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
  agentHeld: false,
};
const g = (over: Partial<GrantViewData>): GrantViewData => ({ ...base, ...over });

// One grant that selects each stock view.
const product = g({ allow: { skus: ["oak-whiskey"], categories: [] }, product: { id: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, currency: "USD", category: "Beverages" } });
const category = g({ allow: { skus: ["drift-mouse"], categories: ["Beverages", "Electronics"] } });
const open = g({ allow: { skus: [], categories: [] } });
const pending = g({ status: "pending", lifecycle: "pending" });
const declined = g({ status: "denied", lifecycle: "denied" });
const revoked = g({ status: "revoked", lifecycle: "revoked", remaining: 62 });
const exhausted = g({ lifecycle: "exhausted", remaining: 0, spent: 200 });

describe("honesty frame — the non-omittable trust line (FR-4, bypass-tested)", () => {
  // Every stock view rendered via its selecting grant must carry the kit's trust sentence for its level.
  // This fails if the frame stops rendering the trust line.
  const cases: Array<[string, GrantViewData, string, Parameters<typeof GrantCard>[0]["views"]?]> = [
    ["productGrantCard", product, FULL_TRUST],
    ["categoryGrantCard", category, FULL_TRUST],
    ["openGrantCard", open, FULL_TRUST],
    ["approvalCard", pending, NOT_APPROVED],
    ["terminalCard(revoked)", revoked, FULL_TRUST],
    ["terminalCard(exhausted)", exhausted, FULL_TRUST],
    ["terminalCard(declined)", declined, NOT_APPROVED],
    ["budgetMeter (explicit)", open, FULL_TRUST, [grantViews.budgetMeter]],
  ];
  for (const [label, grant, sentence, views] of cases) {
    it(`${label} renders the trust line`, () => {
      expect(render(<GrantCard grant={grant} views={views} />)).toContain(sentence);
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
  });

  it("dense layout (A7): each distinct sentence appears once, in the container footer", () => {
    const grants = [
      g({ id: "a", merchant: "Utopia", remaining: 146 }),
      g({ id: "b", merchant: "Utopia", remaining: 16, lifecycle: "low" }),
      g({ id: "c", merchant: "Utopia", remaining: 0, lifecycle: "exhausted", trustLevel: "device-signed" }),
    ];
    const html = render(<GrantList grants={grants} />);
    // Repetition would train the eye to skip it; a row at another level still gets its own.
    expect(count(html, FULL_TRUST)).toBe(1);
    expect(count(html, DEVICE_SIGNED)).toBe(1);
    expect(count(html, "🔒")).toBe(5); // a lock on each of the 3 rows + the 2 sentences
    expect(html).not.toContain("delegated-demo"); // the merchant's own words never reach a row
  });
});

describe("the trust line is the kit's sentence, never the merchant's words (spec 015 FR-10)", () => {
  // Bypass guard: printing `presence` or `trustLevel` again, or trusting a level the kit doesn't
  // list, fails here. The merchant's claim is data the card can't check.
  it("a phone-signed grant gets the attributed sentence, not the old 'not wallet-signed'", () => {
    const html = render(<GrantCard grant={g({ trustLevel: "device-signed" })} />);
    expect(html).toContain(DEVICE_SIGNED);
    expect(html).not.toContain("wallet-signed");
  });

  it("a payment credential with no issuer anchor gets the demo sentence", () => {
    expect(render(<GrantCard grant={g({ trustLevel: "presence-only-demo" })} />)).toContain(
      "🔒 As the merchant reports it: a demo — the credential is not checked against its issuer, so a made-up one would pass. No real money moves.",
    );
  });

  // A grant waiting for the phone reports `server-issued-demo` until it is signed (grants.ts view()),
  // and `revoke()` works on a pending or declined grant too, so a line picked by level alone would
  // tell a person who never approved that they approved with a click. These say neither, whatever
  // the level.
  const revokedWhilePending = g({ status: "revoked", lifecycle: "revoked", spent: 0, remaining: 200 });
  it.each(["server-issued-demo", "device-signed", "presence-only-demo"])(
    "a pending, declined, or revoked-with-nothing-spent grant at %s doesn't say how it was approved",
    (trustLevel) => {
      for (const [grant, line] of [[pending, NOT_APPROVED], [declined, NOT_APPROVED], [revokedWhilePending, REVOKED]] as const) {
        const html = render(<GrantCard grant={{ ...grant, trustLevel }} />);
        expect(html).toContain(line);
        expect(html).not.toContain("approved with a click");
        expect(html).not.toContain("signed on the person");
        expect(html).not.toContain("a demo");
      }
    },
  );

  it("a dense list of pending grants doesn't say how they were approved either", () => {
    const html = render(<GrantList grants={[pending, g({ ...pending, id: "p2", trustLevel: "device-signed" })]} />);
    expect(count(html, NOT_APPROVED)).toBe(1);
    expect(html).not.toContain("approved with a click");
  });

  it("a revoked grant that spent was approved, so it keeps its level's line, demo note included", () => {
    expect(render(<GrantCard grant={revoked} />)).toContain(FULL_TRUST); // spent: 54
  });

  it("a revoked grant with no spent figure counts as nothing spent", () => {
    const grant = { ...revoked, spent: undefined } as unknown as GrantViewData;
    expect(render(<GrantCard grant={grant} />)).toContain(REVOKED);
  });

  // `issuer-verified` from a store's word is not recognised: the gate never claims it (#14).
  it.each(["issuer-verified", "bank-approved", "", "constructor", "__proto__", "toString"])(
    "an unknown level (%j) is 'not recognised', and the store's text never shows",
    (trustLevel) => {
      const html = render(<GrantCard grant={g({ trustLevel, presence: "verified-by-the-store" })} />);
      expect(html).toContain(`🔒 ${UNRECOGNISED_TRUST}`);
      expect(html).not.toContain("verified-by-the-store");
      if (trustLevel) expect(html).not.toContain(trustLevel);
    },
  );

  it("a missing level is 'not recognised' too, and nothing throws", () => {
    const grant = { ...base, trustLevel: undefined } as unknown as GrantViewData;
    expect(render(<GrantCard grant={grant} />)).toContain(`🔒 ${UNRECOGNISED_TRUST}`);
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

// `revoke()` doesn't recall a permission the agent holds itself (GLOSSARY.md, Revoke): such a grant has
// no engine, and the agent keeps buying with its signed copy. The card says what revoking stops only as
// far as the server's `agentHeld` tells it; the trust line never says it.
describe("what revoking stops, said only as far as agentHeld tells (GLOSSARY.md, Revoke)", () => {
  const revokedAs = (agentHeld: unknown) => ({ ...revoked, spent: 0, remaining: 200, agentHeld }) as unknown as GrantViewData;
  const pendingAs = (agentHeld: unknown) => ({ ...pending, agentHeld }) as unknown as GrantViewData;
  const HEDGED = "Further purchases are refused, unless the agent holds its own signed copy of this permission: revoking doesn&#x27;t recall that.";

  it("a grant the server spends: revoking stops every purchase, and the approval card says so", () => {
    expect(render(<GrantCard grant={revokedAs(false)} />)).toContain("No further purchases will be made.");
    expect(render(<GrantCard grant={pendingAs(false)} />)).toContain("until the budget runs out — or you revoke it.");
  });

  // Conditional, because a grant revoked before it was signed left nothing in the agent's hands.
  it("a grant whose permission the agent holds: no card says revoking stops it", () => {
    const html = render(<GrantCard grant={revokedAs(true)} />);
    expect(html).toContain(NOT_RECALLED);
    expect(html).toContain(REVOKED);
    expect(html).not.toContain("No further purchases");
    expect(html).not.toContain("can&#x27;t spend");
    const approval = render(<GrantCard grant={pendingAs(true)} />);
    expect(approval).toContain("Once you sign, revoking won&#x27;t recall it from the agent.");
    expect(approval).not.toContain("or you revoke it");
  });

  it.each([undefined, "false", 0, "true"])("agentHeld %j is unknown: the card promises neither", (agentHeld) => {
    const html = render(<GrantCard grant={revokedAs(agentHeld)} />);
    expect(html).toContain(HEDGED);
    expect(html).not.toContain("No further purchases");
    expect(html).not.toContain(NOT_RECALLED);
    const approval = render(<GrantCard grant={pendingAs(agentHeld)} />);
    expect(approval).toContain("until the budget runs out.</div>");
    expect(approval).not.toContain("revok");
  });
});
