// "the black court sneakers, US 10" → a catalog product, plus the choices still missing.
//
// This is the resolution half of the multi round-trip grant flow (#174): a human who is about to
// walk away names what they want in their own words, and the storefront works out WHICH product
// that is — asking again when the words fit several products, or none, or leave a size unchosen.
//
// It is deliberately dumb and server-side: token overlap against the catalog, never a guess the
// human is not shown. The caller (server.ts) turns a `many`/`none`/missing-choice outcome into
// the next question, and the human sees the resolved product on the approve page before it counts.
import type { Product, ProductVariant } from "./index.js";

/** What the words resolved to. `many` and `none` are questions, not failures. */
export type ProductMatch =
  | { kind: "one"; product: Product }
  | { kind: "many"; candidates: Product[] }
  | { kind: "none" };

/** Words that carry no product meaning — dropped before scoring so they can't create matches. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "the", "of", "in", "for", "with", "some", "please", "buy", "get", "me", "my",
  "one", "pair", "size", "colour", "color", "brand", "new", "want", "would", "like", "to", "on",
]);

/** Lowercase, split on anything that isn't a letter/digit, drop noise, fold a trailing plural. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Score every product against the words and return the best match — or the tie, or nothing.
 *
 * A name/id hit is REQUIRED: "black" alone must not match every product whose description happens
 * to mention black. Category and description hits only break ties among products already named.
 */
export function matchProducts(catalog: Product[], query: string, limit = 5): ProductMatch {
  const q = new Set(tokens(query));
  if (q.size === 0) return { kind: "none" };

  const scored = catalog
    .map((product) => {
      const named = new Set(tokens(`${product.name} ${product.id}`));
      const context = new Set(tokens(`${product.category} ${product.description}`));
      let nameHits = 0;
      let contextHits = 0;
      for (const t of q) {
        if (named.has(t)) nameHits++;
        else if (context.has(t)) contextHits++;
      }
      return { product, score: nameHits > 0 ? nameHits * 2 + contextHits : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  const top = scored.filter((s) => s.score === scored[0].score);
  if (top.length === 1) return { kind: "one", product: top[0].product };
  return { kind: "many", candidates: top.slice(0, limit).map((s) => s.product) };
}

/** The choices this product needs pinned down (size, colour …). Empty when it needs none. */
export function variantsOf(product: Product): ProductVariant[] {
  const v = product.variants;
  return Array.isArray(v) ? v.filter((x) => x && typeof x.name === "string" && Array.isArray(x.options)) : [];
}

/**
 * Choices the human already made in their own words ("the BLACK ones, US 10").
 *
 * Only an UNAMBIGUOUS hit pre-fills: if two options both appear, the choice is still open and the
 * flow asks. Nothing is inferred beyond the option values the catalog itself declares.
 */
export function prefillVariants(product: Product, query: string): Record<string, string> {
  const haystack = ` ${normalize(query)} `;
  const chosen: Record<string, string> = {};
  for (const variant of variantsOf(product)) {
    const hits = variant.options.filter((o) => haystack.includes(` ${normalize(o)} `));
    if (hits.length === 1) chosen[variant.name] = hits[0];
  }
  return chosen;
}

/** Keep only selections this product actually offers — an off-menu value is dropped, not honoured. */
export function validSelections(product: Product, answers: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const variant of variantsOf(product)) {
    const given = answers[variant.name];
    if (typeof given !== "string") continue;
    const match = variant.options.find((o) => normalize(o) === normalize(given));
    if (match) kept[variant.name] = match;
  }
  return kept;
}

/** Which choices are still open — each one becomes a question in the next round. */
export function missingVariants(product: Product, selections: Record<string, string>): ProductVariant[] {
  return variantsOf(product).filter((v) => !selections[v.name]);
}

/** The sentence the human approves: exactly what is being bought, priced. */
export function describeChoice(product: Product, selections: Record<string, string>): string {
  const chosen = variantsOf(product)
    .map((v) => selections[v.name])
    .filter(Boolean);
  const detail = chosen.length ? ` — ${chosen.join(", ")}` : "";
  return `${product.name}${detail} ($${product.price.toFixed(2)})`;
}
