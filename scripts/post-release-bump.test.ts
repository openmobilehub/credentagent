import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdits, bumpQuickstart, releaseHeadline, websiteEdits } from "./post-release-bump.mjs";

// The post-release catch-up edits publish.yml runs. The fixture is credentagent-website as it read
// at 0.5.0; the expected text is what credentagent-website#51 put live for 0.6.0 by hand.
const SITE_050 = {
  "index.html": [
    `<script type="application/ld+json">{"@type":"SoftwareApplication","softwareVersion":"0.5.0","license":"x"}</script>`,
    `      <span class="pill">v0.5 · OPEN SOURCE</span>`,
    `      <a class="news" href="https://github.com/openmobilehub/credentagent/releases/tag/v0.5.0"><b>NEW</b><span>0.5 — wallet-signed spending grants, a cart per conversation →</span></a>`,
    `        <p>Install it with the gate at the same version — <code>npm i @openmobilehub/credentagent-gate@0.5.0 @openmobilehub/credentagent-storefront@0.5.0</code>.</p>`,
    `  // The store-issued cartId from a cart-related tool result (browse-products carries one from 0.5.0).`,
  ].join("\n"),
  "index.md": "> your server enforces it.\n\nv0.5 · Apache-2.0 · Express + any MCP client\n",
  "llms.txt": "> the server completes the action. Pre-1.0 (v0.5).\n",
  "CLAUDE.md": [
    "co-presented with Multipaz. Two npm packages, versioned in lockstep, both live at `0.5.0`:",
    "- The site reflects the published **0.5.0** packages (released 2026-09-26: claude.ai's MCP 2026-07-28",
    "  revision, wallet-signed spending grants, a cart per conversation). The in-browser demo uses the dev",
    "- **Trust levels (0.5.0):** `presence-only-demo` (age, membership, payment)",
  ].join("\n"),
};
const RELEASE = {
  version: "0.6.0",
  title: "v0.6.0 — an AI agent can spend a permission you signed on your phone",
  date: "2026-10-19",
};

function site(files: Record<string, string> = SITE_050) {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  return root;
}
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

describe("post-release-bump website", () => {
  it("moves every version string on the site to the release, as #51 did by hand", () => {
    const root = site();
    applyEdits(root, websiteEdits(RELEASE));
    const html = read(root, "index.html");
    expect(html).toContain(`"softwareVersion":"0.6.0"`);
    expect(html).toContain(`<span class="pill">v0.6 · OPEN SOURCE</span>`);
    expect(html).toContain(
      `href="https://github.com/openmobilehub/credentagent/releases/tag/v0.6.0"><b>NEW</b><span>0.6 — an AI agent can spend a permission you signed on your phone →</span>`,
    );
    expect(html).toContain("npm i @openmobilehub/credentagent-gate@0.6.0 @openmobilehub/credentagent-storefront@0.6.0");
    // A historical mention ("carries one from 0.5.0") is not the current version and stays.
    expect(html).toContain("browse-products carries one from 0.5.0");
    expect(read(root, "index.md")).toContain("v0.6 · Apache-2.0");
    expect(read(root, "llms.txt")).toContain("Pre-1.0 (v0.6).");
    const notes = read(root, "CLAUDE.md");
    expect(notes).toContain("both live at `0.6.0`");
    expect(notes).toContain(
      "The site reflects the published **0.6.0** packages (released 2026-10-19: an AI agent can spend a permission you signed on your phone). The in-browser demo",
    );
    // Trust claims are checked by a person against the release, never bumped by a script.
    expect(notes).toContain("**Trust levels (0.5.0):**");
  });

  it("runs again on its own output (a re-run after a partial failure)", () => {
    const root = site();
    applyEdits(root, websiteEdits(RELEASE));
    applyEdits(root, websiteEdits({ ...RELEASE, version: "0.7.0", title: "v0.7.0" }));
    expect(read(root, "index.html")).toContain("<b>NEW</b><span>0.7 — see what's new →</span>");
  });

  it("writes nothing when one place no longer matches, so a redesign can't half-bump the site", () => {
    const root = site({ ...SITE_050, "llms.txt": "no version here\n" });
    expect(() => applyEdits(root, websiteEdits(RELEASE))).toThrow(/llms\.txt: expected 1 match/);
    expect(read(root, "index.html")).toBe(SITE_050["index.html"]);
  });

  it("escapes a release title before putting it in the page", () => {
    const [, , news] = websiteEdits({ ...RELEASE, title: 'v0.6.0 — <img src=x onerror="alert(1)">' });
    expect(news[2]).toContain("&lt;img src=x");
    expect(news[2]).not.toContain("<img");
  });
});

describe("releaseHeadline", () => {
  it.each([
    ["v0.6.0 — an AI agent can spend", "an AI agent can spend"],
    ["0.6.0: an AI agent can spend", "an AI agent can spend"],
    ["v0.6.0", ""],
    ["", ""],
  ])("%j → %j", (title, headline) => expect(releaseHeadline(title, "0.6.0")).toBe(headline));
});

describe("post-release-bump quickstart", () => {
  it("moves both packages' caret to the release (a ^0.x caret never reaches the next minor)", () => {
    const root = mkdtempSync(join(tmpdir(), "lib-"));
    mkdirSync(join(root, "examples/quickstart"), { recursive: true });
    const file = join(root, "examples/quickstart/package.json");
    writeFileSync(
      file,
      JSON.stringify({
        dependencies: {
          "@openmobilehub/credentagent-gate": "^0.5.0",
          "@openmobilehub/credentagent-storefront": "^0.5.0",
          "@upstash/redis": "^1.34.0",
        },
      }),
    );
    bumpQuickstart(root, "0.6.0");
    expect(JSON.parse(readFileSync(file, "utf8")).dependencies).toEqual({
      "@openmobilehub/credentagent-gate": "^0.6.0",
      "@openmobilehub/credentagent-storefront": "^0.6.0",
      "@upstash/redis": "^1.34.0",
    });
  });
});
