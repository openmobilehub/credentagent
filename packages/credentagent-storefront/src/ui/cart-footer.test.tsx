// The picker's footer always carries the Checkout button — the widget exists to get to checkout.
// It is disabled (not hidden) while the cart is empty, while an order is being minted, and outside
// an MCP host (standalone mode has no checkout), and it shows how many items it will check out.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CartFooter } from "./CartFooter";
import type { PricedCart } from "../index";

const cart = (itemCount: number, total = 0): PricedCart =>
  ({ lines: [], unknownIds: [], itemCount, subtotal: total, discount: 0, total, currency: "USD",
    hasAgeRestricted: false, ageVerified: false, loyaltyApplied: false });
const noop = () => {};

describe("CartFooter", () => {
  it("shows a disabled Checkout button when the cart is empty", () => {
    const html = renderToStaticMarkup(<CartFooter cart={cart(0)} canCheckout checkingOut={false} onCheckout={noop} />);
    expect(html).toContain("Cart is empty");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Checkout<\/button>/);
  });

  it("enables Checkout and shows the item count when the cart has items", () => {
    const html = renderToStaticMarkup(<CartFooter cart={cart(3, 42)} canCheckout checkingOut={false} onCheckout={noop} />);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Checkout \(3\)<\/button>/);
    expect(html).toContain('aria-label="Checkout 3 items"');
  });

  it("uses the singular for one item", () => {
    const html = renderToStaticMarkup(<CartFooter cart={cart(1, 5)} canCheckout checkingOut={false} onCheckout={noop} />);
    expect(html).toContain('aria-label="Checkout 1 item"');
  });

  it("disables the button while the order is being opened", () => {
    const html = renderToStaticMarkup(<CartFooter cart={cart(2, 10)} canCheckout checkingOut={true} onCheckout={noop} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Opening…<\/button>/);
  });

  it("still shows Checkout, disabled, when there is no host to check out through", () => {
    const html = renderToStaticMarkup(<CartFooter cart={cart(2, 10)} canCheckout={false} checkingOut={false} onCheckout={noop} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Checkout \(2\)<\/button>/);
  });
});
