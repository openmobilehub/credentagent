import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCardsPage } from "./page.js";

const dir = mkdtempSync(join(tmpdir(), "cards-page-"));
const file = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

describe("loadCardsPage", () => {
  it("reads the first page it finds and hashes its content", () => {
    const page = loadCardsPage([join(dir, "missing.html"), file("a.html", "<p>a</p>")]);
    expect(page.html).toBe("<p>a</p>");
    expect(page.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a changed page gets a new hash, so a host never serves a stale cached copy", () => {
    const one = loadCardsPage([file("one.html", "<p>one</p>")]).hash;
    const two = loadCardsPage([file("two.html", "<p>two</p>")]).hash;
    const again = loadCardsPage([file("one-again.html", "<p>one</p>")]).hash;
    expect(one).not.toBe(two);
    expect(again).toBe(one);
  });

  it("fails fast, saying how to fix it, when the page was never built", () => {
    expect(() => loadCardsPage([join(dir, "nope.html")])).toThrow(/cards\.html was not found[\s\S]*npm run build/);
  });

  it("finds the built page by default", () => {
    expect(loadCardsPage().html).toContain("ui/initialize");
  });
});
