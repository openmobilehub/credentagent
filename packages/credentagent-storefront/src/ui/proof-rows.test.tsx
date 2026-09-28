// The confirmed-order card lists what was proven for the order (the gate's order proof
// receipt): one row per gate with its trust level, an "Inspect ↗" link to Multipaz Tools only
// for a wallet proof the store kept bytes for, and an instant-demo proof labelled as such.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofRows, type WidgetProof } from "./ProofRows";

const url = "https://tools.multipaz.org/mdocDeviceResponse#o2d2";
const proofs: WidgetProof[] = [
  { gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", presentation: { inspectUrl: url } },
  { gate: "Pay (USD)", rail: "instant-demo", trust_level: "presence-only-demo" },
];

describe("ProofRows", () => {
  it("lists each proof with its trust level and links only a wallet proof to the inspector", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={proofs} />);
    expect(html).toContain("Age 21+");
    expect(html).toContain("presence-only-demo");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("Inspect");
    expect(html).toContain("instant demo");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("never links a non-Multipaz URL", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={[{ ...proofs[0], presentation: { inspectUrl: "javascript:alert(1)" } }]} />);
    expect(html).not.toContain("<a ");
  });

  it("renders nothing without proofs", () => {
    expect(renderToStaticMarkup(<ProofRows proofs={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ProofRows proofs={[]} />)).toBe("");
  });
});
