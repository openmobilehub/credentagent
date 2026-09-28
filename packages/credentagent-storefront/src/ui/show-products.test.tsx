// The grant card replaces the picker in the same widget; ShowProducts is the way back to it.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShowProducts } from "./ShowProducts";

const noop = () => {};

describe("ShowProducts", () => {
  it("offers a button back to the product picker", () => {
    const html = renderToStaticMarkup(<ShowProducts itemCount={0} onShow={noop} />);
    expect(html).toMatch(/<button[^>]*>🛍 Show products<\/button>/);
    expect(html).not.toContain("in cart");
  });

  it("mentions what is already in the cart", () => {
    const html = renderToStaticMarkup(<ShowProducts itemCount={2} onShow={noop} />);
    expect(html).toContain("🛒 2 in cart");
  });
});
