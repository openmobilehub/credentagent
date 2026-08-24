// Self-contained product images — generated here, no external image service.
// Each is a clean SVG tile: a category-tinted gradient + the product's emoji
// (instantly recognizable, renders crisply at any size), embedded as a data URI.
// The widget shows the product name beneath, so the tile is just the visual.

function tile(emoji: string, bg: [string, string]): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${bg[0]}'/><stop offset='1' stop-color='${bg[1]}'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='300' fill='url(#g)'/>` +
    `<text x='200' y='150' font-size='150' text-anchor='middle' dominant-baseline='central'>${emoji}</text>` +
    `</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** Product id → a generated, self-contained image (data URI). */
export const PRODUCT_IMAGES: Record<string, string> = {
  "aurora-headphones": tile("🎧", ["#7c3aed", "#a78bfa"]),
  "oak-whiskey": tile("🥃", ["#b45309", "#f59e0b"]),
  "drift-mouse": tile("🖱️", ["#0f766e", "#2dd4bf"]),
  "celebration-champagne": tile("🍾", ["#be185d", "#f9a8d4"]),
  "summit-backpack": tile("🎒", ["#1d4ed8", "#60a5fa"]),
  "court-sneakers": tile("👟", ["#334155", "#94a3b8"]),
  "lumen-desk-lamp": tile("💡", ["#a16207", "#fde047"]),
};
