// The built card page (spec 015 FR-2): read once, hashed, and FAIL FAST when missing — never a
// "dev" fallback URI, which would poison connected hosts' caches (the storefront's #55 lesson).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CardsPage {
  html: string;
  /** First 12 hex characters of the page's SHA-256 — the resource URIs carry it. */
  hash: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Next to the compiled module (dist/cards/), or — when this module runs from source under the
 *  test runner — in the package's dist/cards/. */
function pageCandidates(): string[] {
  return [join(here, "cards.html"), join(here, "..", "..", "dist", "cards", "cards.html")];
}

/** `candidates` is the seam the tests use; production always uses the default. */
export function loadCardsPage(candidates: string[] = pageCandidates()): CardsPage {
  for (const path of candidates) {
    let html: string;
    try {
      html = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only a path that does not exist moves on to the next candidate. A page that exists but
      // cannot be read (EACCES, EISDIR, EIO, ...) is a different problem and must not be reported
      // as "not found", so it fails here with its real cause.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error(`credentagent-gate/cards: the card page ${path} exists but could not be read (${code ?? "unknown error"}).`, {
        cause: error,
      });
    }
    return { html, hash: createHash("sha256").update(html).digest("hex").slice(0, 12) };
  }
  throw new Error(
    "credentagent-gate/cards: the card page cards.html was not found — the package was built without it " +
      "(run `npm run build` in packages/credentagent-gate) or a serverless deploy's includeFiles is missing it. " +
      `Looked in: ${[...new Set(candidates)].join(", ")}.`,
  );
}
