// The widget shows nothing until the tool result that opened it arrives (#428). A static render is
// exactly the first paint — no effects run — so it is the moment the product grid used to flash.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetView, isResult } from "./WidgetView";
import type { GrantViewData } from "../../../credentagent-gate/src/cards/ui/grants";

const grant: GrantViewData = {
  kind: "credentagent.grant",
  id: "grant_test",
  merchant: "utopia",
  status: "pending",
  lifecycle: "pending",
  budget: 200,
  spent: 0,
  remaining: 200,
  perSpend: 130,
  allow: { skus: [], categories: ["Beverages", "Electronics"] },
  approveUrl: "http://localhost:3005/credentagent/grants/grant_test",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
};
const picker = <p>PRODUCT GRID</p>;
const view = (received: boolean, grantView: GrantViewData | null): string =>
  renderToStaticMarkup(
    <WidgetView received={received} grantView={grantView} grantActions={{}} itemCount={0} onShowProducts={() => {}} picker={picker} />,
  );

describe("WidgetView — no product grid before the result that opened the widget (#428)", () => {
  it("shows nothing at all before a result arrives", () => {
    expect(view(false, null)).toBe("");
  });

  it("a grant result shows the grant card, and the product grid never", () => {
    const html = view(true, grant);
    expect(html).toContain("Approve a spending grant");
    expect(html).not.toContain("PRODUCT GRID");
  });

  it("any other result shows the product picker", () => {
    expect(view(true, null)).toContain("PRODUCT GRID");
  });

  it("only null and undefined count as no result", () => {
    expect(isResult(undefined)).toBe(false);
    expect(isResult(null)).toBe(false);
    expect(isResult({})).toBe(true);
    expect(isResult(grant)).toBe(true);
  });
});
