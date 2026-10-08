import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCardsPage } from "./page.js";

const dir = mkdtempSync(join(tmpdir(), "cards-page-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

  it("hashes with SHA-256, truncated to 12 hex characters (a known vector)", () => {
    const expected = createHash("sha256").update("<p>a</p>").digest("hex").slice(0, 12);
    expect(loadCardsPage([file("vector.html", "<p>a</p>")]).hash).toBe(expected);
  });

  it("when several pages exist, the first one wins", () => {
    const page = loadCardsPage([file("first.html", "<p>first</p>"), file("second.html", "<p>second</p>")]);
    expect(page.html).toBe("<p>first</p>");
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

  it("a page that exists but cannot be read says so, instead of 'not found'", () => {
    // A directory exists but cannot be read as a file (EISDIR), so it must not be skipped as missing.
    let message = "";
    try {
      loadCardsPage([dir]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/could not be read/);
    expect(message).not.toMatch(/was not found/);
  });

  it("finds the built page by default", () => {
    expect(loadCardsPage().html).toContain("ui/initialize");
  });
});
