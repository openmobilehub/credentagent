// The built card page (spec 015 FR-2): read once, hashed, and FAIL FAST when missing — never a
// "dev" fallback URI, which would poison connected hosts' caches (the storefront's #55 lesson).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CardsPage {
  html: string;
  /** First 12 hex characters of the page's SHA-256 — the resource URIs carry it. */
  hash: string;
}

/** Next to the compiled module (dist/cards/), or — when this module runs from source under the
 *  test runner — in the package's dist/cards/. */
function pageCandidates(): string[] {
  return [join(import.meta.dirname, "cards.html"), join(import.meta.dirname, "..", "..", "dist", "cards", "cards.html")];
}

export function loadCardsPage(candidates: string[] = pageCandidates()): CardsPage {
  for (const path of candidates) {
    let html: string;
    try {
      html = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    return { html, hash: createHash("sha256").update(html).digest("hex").slice(0, 12) };
  }
  throw new Error(
    "credentagent-gate/cards: the card page cards.html was not found — the package was built without it " +
      "(run `npm run build` in packages/credentagent-gate) or a serverless deploy's includeFiles is missing it. " +
      `Looked in: ${[...new Set(candidates)].join(", ")}.`,
  );
}
