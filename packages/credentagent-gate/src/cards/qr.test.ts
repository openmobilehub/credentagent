import { describe, it, expect } from "vitest";
import { qrDataUrl } from "./qr.js";

describe("qrDataUrl", () => {
  it("is an SVG data URL the card shows as an image", () => {
    const url = qrDataUrl("https://beanbarn.example/credentagent/grants/g1");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toMatch(/^<svg [\s\S]*<\/svg>$/);
  });

  it("a different link is a different code", () => {
    expect(qrDataUrl("https://a.example/1")).not.toBe(qrDataUrl("https://a.example/2"));
  });
});
