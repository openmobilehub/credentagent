// The widget shows nothing until the tool result that opened it arrives (#428). A static render is
// exactly the first paint — no effects run — so it is the moment the product grid used to flash.

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FIRST_RESULT_WAIT_MS, WidgetView, armFallback, firstChatGptView, isResult, useFirstResult } from "./WidgetView";
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

describe("the first paint in ChatGPT — the result it already holds is read before painting", () => {
  it("a grant result held at mount paints the grant card first, never the grid", () => {
    const first = firstChatGptView(grant);
    expect(first).toEqual({ received: true, grantView: grant });
    const html = view(first.received, first.grantView);
    expect(html).toContain("Approve a spending grant");
    expect(html).not.toContain("PRODUCT GRID");
  });

  it("a shopping result held at mount paints the picker; no result yet paints nothing", () => {
    expect(firstChatGptView({ products: [] })).toEqual({ received: true, grantView: null });
    expect(firstChatGptView(undefined)).toEqual({ received: false, grantView: null });
    expect(view(firstChatGptView(undefined).received, null)).toBe("");
  });

  it("useFirstResult keeps the received flag it is given for the first paint", () => {
    const Probe = ({ already }: { already: boolean }) => <span>{String(useFirstResult(already)[0])}</span>;
    expect(renderToStaticMarkup(<Probe already />)).toBe("<span>true</span>");
    expect(renderToStaticMarkup(<Probe already={false} />)).toBe("<span>false</span>");
  });
});

describe("the fallback — a host that never sends a result still gets the picker", () => {
  afterEach(() => vi.useRealTimers());

  it("fires after FIRST_RESULT_WAIT_MS, not before", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    armFallback(onTimeout);
    vi.advanceTimersByTime(FIRST_RESULT_WAIT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("never fires once cancelled — a result that arrives in time wins", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const cancel = armFallback(onTimeout);
    cancel();
    vi.advanceTimersByTime(FIRST_RESULT_WAIT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
