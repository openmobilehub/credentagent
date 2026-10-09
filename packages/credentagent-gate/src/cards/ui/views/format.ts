/** "$21.00" — the cards show dollars with cents, as the AP2 demo did. */
export const usd = (dollars: number): string => `$${dollars.toFixed(2)}`;
/** "House Blend, 1 lb bag" → "House Blend": the short name the cards show. */
export const shortName = (name: string): string => name.split(",")[0];
