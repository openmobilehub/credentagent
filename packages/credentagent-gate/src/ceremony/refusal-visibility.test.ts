// A refused completion must never be SILENT on the buyer's page.
//
// `completeOrder` answers `{ completed: false, reason }` for every refusal it makes, and
// each rail's verify route forwards that `reason` in its JSON. But the payment pages only
// rendered the success banner (`if (out.completed)`) — so a legitimate refusal painted
// "✓ Payment Mandate authorized" plus four green gates and then stopped dead. The buyer
// could not tell a refusal from a hang, and the operator could not tell either.
//
// That is an honesty failure as much as a DX one: the page showed every check that PASSED
// and hid the one decision that mattered. These tests pin the fix from both sides:
//   • the copy exists for EVERY reason the seam can return (no reason falls through), and
//   • both human-present payment pages actually render it on a non-completion.
// Each assertion fails if the rendering branch (or the copy) is removed again.

import { describe, it, expect } from "vitest";
import { refusalNotices } from "./theme.js";
import { renderDcPaymentPage } from "./dc-payment/page.js";
import { renderPasskeyPage } from "./passkey/page.js";
import type { CeremonyOrder, CompletionRefusalReason } from "./types.js";

// Every reason in CompletionResult["reason"]. Listed literally (not derived) so that
// adding a reason to the union without adding its copy fails HERE, not on a buyer's phone.
const EVERY_REASON: CompletionRefusalReason[] = [
  "gates",
  "cart-mandate",
  "reprice",
  "reconcile",
  "age",
  "gate",
  "draw",
];

const lines = [{ name: "Oak Reserve Whiskey Collection", quantity: 1, lineTotal: 124, currency: "USD" }];

// The same 21+ order both rails price, in each rail's own page shape.
const order: CeremonyOrder = {
  id: "ORD-1",
  lines: [{ id: "oak-whiskey", name: "Oak Reserve Whiskey Collection", unitPrice: 124, currency: "USD", quantity: 1, lineTotal: 124, minimumAge: 21 }],
  itemCount: 1,
  subtotal: 124,
  discount: 0,
  total: 124,
  currency: "USD",
};

describe("refusalNotices — buyer-facing copy for every refusal the completion seam makes", () => {
  it("has non-empty copy for every reason completeOrder can return", () => {
    const notices = refusalNotices();
    for (const reason of EVERY_REASON) {
      expect(notices[reason], `no copy for reason "${reason}"`).toBeTruthy();
      expect(notices[reason].length).toBeGreaterThan(40);
    }
  });

  it("says plainly that the order was NOT placed — never just the machine reason", () => {
    const notices = refusalNotices();
    for (const reason of EVERY_REASON) {
      expect(notices[reason], `reason "${reason}" must state the outcome`).toContain("not placed");
    }
  });

  it("names the age requirement and the way forward for the age refusal", () => {
    const age = refusalNotices().age;
    expect(age).toMatch(/age/i);
    // The buyer's next step, in their language — not "reason: age".
    expect(age).toMatch(/prove/i);
  });

  it("renders a visible notice for an unrecognised reason (never an empty dead end)", () => {
    const notices = refusalNotices();
    expect(notices.unknown).toBeTruthy();
    expect(notices.unknown).toContain("not placed");
  });

  it("offers the way back to checkout when a returnUrl is configured", () => {
    const withUrl = refusalNotices({ returnUrl: "/checkout?order=ORD-1" });
    expect(withUrl.age).toContain("/checkout?order=ORD-1");
    // …and stays well-formed without one (the MCP flow has no browser hub to return to).
    expect(refusalNotices().age).not.toContain("href");
  });

  it("escapes a hostile returnUrl instead of emitting live markup", () => {
    const hostile = refusalNotices({ returnUrl: `" onmouseover="alert(1)` });
    expect(hostile.age).not.toContain(`onmouseover="alert(1)`);
  });
});

describe("the payment pages render the refusal (a non-completion is visible)", () => {
  it("the dc-payment page carries the refusal copy and branches on out.reason", () => {
    const html = renderDcPaymentPage({ order: "ORD-1", total: 124, currency: "USD", lines });
    // The map of notices is embedded server-side (escaping happens there, not in the page JS)…
    expect(html).toMatch(/age/i);
    expect(html).toContain("not placed");
    // …and the receipt handler actually consults the reason on a non-completion. Deleting
    // the branch drops this token and fails the test.
    expect(html).toContain("out.reason");
  });

  it("the passkey page carries the refusal copy and branches on out.reason", () => {
    const html = renderPasskeyPage({ order });
    expect(html).toContain("not placed");
    expect(html).toContain("out.reason");
  });
});
