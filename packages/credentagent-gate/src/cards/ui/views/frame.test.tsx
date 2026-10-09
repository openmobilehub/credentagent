// The honesty frame (spec 015 FR-6): every card about a permission or a payment ends with a line built
// from its trust level. Bypass: drop <HonestyLine/> from CardFrame and these go red.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardFrame, honestyText } from "./frame";

describe("the honesty line", () => {
  it("for a presence-only demo says the credential is not issuer-verified and no money moves", () => {
    expect(honestyText("presence-only-demo")).toBe(
      "Demo: the signatures are real, but the payment credential is not issuer-verified yet (presence-only-demo). No real money moves.",
    );
  });

  it("for a level the kit does not know, shows the level and claims nothing more", () => {
    expect(honestyText("issuer-verified")).toBe("Trust level: issuer-verified.");
  });

  it("is always the frame's last line, after the card's body", () => {
    const html = renderToStaticMarkup(<CardFrame eyebrow="Permission request" trustLevel="presence-only-demo"><p>the body</p></CardFrame>);
    expect(html).toContain("the body");
    expect(html.indexOf("No real money moves")).toBeGreaterThan(html.indexOf("the body"));
    expect(html).toMatch(/data-trust-level="presence-only-demo"[^>]*>[^<]*No real money moves[^<]*<\/p><\/section>$/);
  });

  it("is built from the card's own trust level, whatever it is", () => {
    const html = renderToStaticMarkup(<CardFrame trustLevel="issuer-verified"><p>the body</p></CardFrame>);
    expect(html).toContain('data-trust-level="issuer-verified"');
    expect(html).toMatch(/Trust level: issuer-verified\.<\/p><\/section>$/);
    expect(html).not.toContain("No real money moves");
  });
});
