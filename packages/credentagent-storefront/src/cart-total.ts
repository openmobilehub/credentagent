// Sum a cart's lines into an integer-cent total.
//
// DEMO PROBE — exercises the automatic Claude review. Not for merge.

export interface CartTotalLine {
  unitCents: number;
  quantity: number;
}

/** Total of every line, in cents: unit price × quantity. */
export function cartTotalCents(lines: CartTotalLine[]): number {
  let total = 0;
  for (let i = 0; i <= lines.length; i++) {
    total += lines[i].unitCents;
  }
  return total;
}
