import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptCard } from "./ReceiptCard";
import { previewResult } from "../preview";
import type { ReceiptCardData } from "../../contract";

const render = (view: string): string =>
  renderToStaticMarkup(<ReceiptCard data={previewResult(view)!.structuredContent as ReceiptCardData} open={async () => {}} />);

describe("ReceiptCard", () => {
  it("paid: the total, the items, what the store checked, and the receipt link", () => {
    const html = render("receipt");
    expect(html).toContain("Paid $21.00 at BeanBarn");
    expect(html).toContain("Verified by the store before it accepted the order");
    expect(html).toContain("1 × House Blend, 1 lb bag");
    expect(html).toContain("What BeanBarn checked");
    expect(html).toContain("The permission&#x27;s wallet signature verifies");
    expect(html).toContain("Open receipt");
    expect(html).toMatch(/No real money moves\.<\/p><\/section>$/);
  });

  it("refused: who refused, why, and that nothing was charged", () => {
    const html = render("refused");
    expect(html).toContain("Acme Coffee Co refused this purchase");
    expect(html).toContain("Nothing was charged.");
    expect(html).toContain("This permission was signed for another store");
    expect(html).toContain("constraint");
    expect(html).toMatch(/No real money moves\.<\/p><\/section>$/);
  });

  // The honesty line is built from the answer's own trust level, on both answers. Bypass: hard-code
  // trustLevel="presence-only-demo" in ReceiptCard's CardFrame and this goes red.
  it("ends with the honesty line of the answer's own trust level, paid or refused", () => {
    for (const view of ["receipt", "refused"]) {
      const data = { ...(previewResult(view)!.structuredContent as ReceiptCardData), trustLevel: "issuer-verified" };
      const html = renderToStaticMarkup(<ReceiptCard data={data} open={async () => {}} />);
      expect(html, view).toContain("Trust level: issuer-verified.");
      expect(html, view).not.toContain("No real money moves");
    }
  });

  // "Nothing was charged." is a claim: only an answer that says `ok: false` makes it.
  it("an answer that is neither paid nor refused is no card — never a refusal", () => {
    const paid = previewResult("receipt")!.structuredContent as ReceiptCardData & { ok: true };
    const refused = previewResult("refused")!.structuredContent as ReceiptCardData;
    for (const [what, answer] of [
      ["no ok", { kind: paid.kind, order: paid.order, trustLevel: paid.trustLevel }],
      ["no ok and a reason", { kind: refused.kind, reason: "Declined", trustLevel: refused.trustLevel }],
      ["ok that is not a boolean", { ...paid, ok: "yes" }],
    ] as const) {
      const html = renderToStaticMarkup(<ReceiptCard data={answer as unknown as ReceiptCardData} open={async () => {}} />);
      expect(html, what).toBe("");
    }
  });

  it("no receipt link, no button", () => {
    const data = { ...(previewResult("receipt")!.structuredContent as ReceiptCardData) };
    delete (data as { receiptUrl?: string }).receiptUrl;
    expect(renderToStaticMarkup(<ReceiptCard data={data} open={async () => {}} />)).not.toContain("Open receipt");
  });
});
