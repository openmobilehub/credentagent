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
    // Links: the wallet proof's Inspect + the verifier. The instant-demo row carries none.
    expect(html.match(/<a /g)?.length).toBe(2);
    expect(html.split("Pay (USD)")[1].split("</div>")[0]).not.toContain("<a ");
  });

  it("never links a non-Multipaz URL", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={[{ ...proofs[0], presentation: { inspectUrl: "javascript:alert(1)" } }]} />);
    expect(html).not.toContain("<a ");
  });

  it("renders nothing without proofs", () => {
    expect(renderToStaticMarkup(<ProofRows proofs={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ProofRows proofs={[]} />)).toBe("");
  });

  it("adds the issuer certificate, the Multipaz verifier, and the order record", () => {
    const cert = "https://tools.multipaz.org/x509#MIIC";
    const withCert: WidgetProof[] = [{ ...proofs[0], presentation: { inspectUrl: url, issuerCertUrl: cert } }, proofs[1]];
    const record = "https://store.example/checkout/order-status?orderId=O1";
    const html = renderToStaticMarkup(<ProofRows proofs={withCert} recordUrl={record} />);
    expect(html).toContain(`href="${cert}"`);
    expect(html).toContain('href="https://tools.multipaz.org/verifier"');
    expect(html).toContain(`href="${record}"`);
    expect(html).toContain("Order record");
  });

  it("the order record shows even without proofs; the verifier only with a wallet proof; unsafe URLs never link", () => {
    const html = renderToStaticMarkup(<ProofRows proofs={[proofs[1]]} recordUrl="http://localhost:3015/checkout/order-status?orderId=O1" />);
    expect(html).toContain("Order record");
    expect(html).not.toContain("tools.multipaz.org/verifier");
    const bad = renderToStaticMarkup(<ProofRows proofs={[{ ...proofs[0], presentation: { inspectUrl: url, issuerCertUrl: "https://evil.example/x" } }]} recordUrl="javascript:alert(1)" />);
    expect(bad).not.toContain("evil.example");
    expect(bad).not.toContain("javascript:");
  });
});
