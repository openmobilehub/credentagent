// The card page's dispatch (spec 015 FR-5): a result's `kind` picks the card, an unknown kind shows
// nothing, and every preview sample renders inside the gallery's frame — the trust line included.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "./CardView";
import { readCard } from "./card-store";
import { previewResult, previewViews } from "./preview";
import type { Bridge } from "./bridge";

const bridge: Bridge = { host: "preview", call: async () => null, open: async () => {} };
const render = (result: { structuredContent: unknown } | null): string =>
  renderToStaticMarkup(<CardView card={readCard(result)} bridge={bridge} show={() => false} />);

describe("CardView", () => {
  it("renders a grant result as the gallery's card", () => {
    const html = render(previewResult("grant-product"));
    expect(html).toContain("Oak Reserve Whiskey");
    expect(html).toContain("limits enforced server-side");
  });

  it("shows nothing for a kind it does not know", () => {
    expect(render({ structuredContent: { kind: "someone.else" } })).toBe("");
  });

  it("every preview sample is a card that carries the trust line", () => {
    expect(previewViews().length).toBe(8);
    for (const view of previewViews()) expect(render(previewResult(view)), view).toContain("delegated-demo");
  });

  it("an unknown or missing preview name is no card", () => {
    expect(previewResult("constructor")).toBeNull();
    expect(previewResult(null)).toBeNull();
  });
});
