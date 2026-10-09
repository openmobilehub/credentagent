// "Open receipt" is a bare event handler: it never awaits the host's promise, so a rejected open must be
// caught and said on the card or it vanishes (spec 015 FR-5: no silent failure). The page has no DOM to
// click in, so `useState` is faked: the handler runs as the browser would run it, and the card is drawn
// again with the state the handler set. Bypass: drop `openOrSay` from the button and these go red.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { ReceiptCard } from "./ReceiptCard";
import { previewResult } from "../preview";
import type { ReceiptCardData } from "../../contract";

const failed = vi.hoisted(() => ({ value: false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [failed.value, (next: boolean) => void (failed.value = next)],
}));

const data = previewResult("receipt")!.structuredContent as ReceiptCardData;

/** The first `button` in an element tree: the card's own markup holds it, so no rendering is needed to find it. */
function findButton(node: ReactNode): ReactElement<{ onClick: () => void }> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map(findButton).find((found) => found !== null) ?? null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === "button") return element as ReactElement<{ onClick: () => void }>;
  return findButton(element.props?.children);
}

describe("ReceiptCard: Open receipt", () => {
  beforeEach(() => {
    failed.value = false;
  });

  it("asks the host to open the receipt link", () => {
    const open = vi.fn(async () => {});
    findButton(ReceiptCard({ data, open }))!.props.onClick();
    expect(open).toHaveBeenCalledWith("https://beanbarn.example/agent/orders/ord_preview");
  });

  it("says so when the host would not open it, and says nothing before", async () => {
    const open = vi.fn(async () => {
      throw new Error("blocked");
    });
    expect(renderToStaticMarkup(<ReceiptCard data={data} open={open} />)).not.toContain("Couldn&#x27;t open the receipt.");
    findButton(ReceiptCard({ data, open }))!.props.onClick();
    await vi.waitFor(() => expect(failed.value).toBe(true));
    expect(renderToStaticMarkup(<ReceiptCard data={data} open={open} />)).toContain("Couldn&#x27;t open the receipt.");
  });

  it("clears an old failure when it is pressed again", () => {
    failed.value = true;
    findButton(ReceiptCard({ data, open: async () => {} }))!.props.onClick();
    expect(failed.value).toBe(false);
  });
});
