// The built card page must reach the chat apps intact (spec 015 FR-3). The AP2 demo learned this the
// hard way: it inlined the MCP Apps client with a replacement STRING, where "$&", "$`" and "$$" are
// patterns, and ChatGPT showed a bare "Runtime error". This test fails if a build step mangles the
// page's script, if the page loads anything from elsewhere, or if the MCP Apps client goes missing.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const page = fileURLToPath(new URL("../../../dist/cards/cards.html", import.meta.url));

describe("the built card page", () => {
  it("exists — run `npm run build` first", () => {
    expect(existsSync(page)).toBe(true);
  });

  it("is one self-contained file: no script or stylesheet loaded from elsewhere", () => {
    const html = readFileSync(page, "utf8");
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/);
  });

  it("its inline script parses as a module and carries the MCP Apps client", () => {
    const html = readFileSync(page, "utf8");
    const scripts = [...html.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "cards-page-"));
    for (const [i, code] of scripts.entries()) {
      const file = join(dir, `script-${i}.mjs`);
      writeFileSync(file, code);
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    }
    expect(scripts.join("\n")).toContain("ui/initialize");
  });
});
