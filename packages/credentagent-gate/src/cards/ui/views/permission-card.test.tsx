import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionCard, WAITING, openFailedMessage, openOrSay, type SignatureState } from "./PermissionCard";
import { PERMISSION_KIND, type PermissionCardData } from "../../contract";

const data: PermissionCardData = {
  kind: PERMISSION_KIND,
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend ($21).",
  trustLevel: "presence-only-demo",
};
const qr = "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E";
// `renderWith` takes the QR value as given — a default parameter would swallow an explicit `undefined`.
const renderWith = (state: SignatureState, code: unknown, card: PermissionCardData = data): string =>
  renderToStaticMarkup(<PermissionCard data={card} qr={code} state={state} open={async () => {}} />);
const render = (state: SignatureState = WAITING): string => renderWith(state, qr);

describe("PermissionCard", () => {
  it("asks the person to sign at one store, with the limits, the reason and the QR code", () => {
    const html = render();
    expect(html).toContain("Permission request");
    expect(html).toContain("Sign on your phone to let the agent buy at BeanBarn");
    expect(html).toContain("Why BeanBarn: lowest price for House Blend ($21).");
    expect(html).toContain("beanbarn.example");
    expect(html).toContain(">House Blend<");
    expect(html).toContain("up to $25.00");
    expect(html).toContain("up to $50.00");
    expect(html).toContain(`src="${qr}"`);
    expect(html).toContain('alt="QR code for the signing link at BeanBarn"');
    expect(html).toContain("Scan with your phone&#x27;s camera");
    expect(html).toContain("Open link");
    expect(html).toContain("Only this store, only these products, only up to these amounts.");
  });

  it("shows the live status: waiting, signed, or not signed", () => {
    expect(render()).toContain("Waiting for your signature");
    expect(render({ kind: "signed", trustLevel: "device-signed" })).toContain("Signed on your phone · device-signed");
    expect(render({ kind: "signed" })).toMatch(/Signed on your phone<\/span>/);
    expect(render({ kind: "not-signed", status: "denied" })).toContain("Not signed · denied");
  });

  it("shows a QR code only when it is an image data URL", () => {
    expect(renderWith(WAITING, "https://evil.example/qr.png")).not.toContain("<img");
    expect(renderWith(WAITING, undefined)).not.toContain("<img");
    expect(renderWith(WAITING, "data:text/html,<script>alert(1)</script>")).not.toContain("<img");
  });

  it("ends with the honesty line", () => {
    expect(render()).toMatch(/No real money moves\.<\/p><\/section>$/);
  });

  it("builds the honesty line from the card's own trust level", () => {
    const html = renderWith(WAITING, qr, { ...data, trustLevel: "issuer-verified" });
    expect(html).toContain("Trust level: issuer-verified.");
    expect(html).not.toContain("No real money moves");
  });
});

// The "Open link" button is a bare event handler: it never awaits the host's promise, so a failure must
// be caught and reported here or it vanishes. Bypass: remove the `.catch` and the rejection test goes red.
describe("openOrSay", () => {
  it("clears any old failure, then asks the host to open the approve link", () => {
    const open = vi.fn(async () => {});
    const failed = vi.fn();
    openOrSay(open, data.approveUrl, failed);
    expect(open).toHaveBeenCalledWith(data.approveUrl);
    expect(failed).toHaveBeenCalledWith(false);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected open", async () => {
    const failed = vi.fn();
    openOrSay(async () => { throw new Error("blocked"); }, data.approveUrl, failed);
    await vi.waitFor(() => expect(failed).toHaveBeenLastCalledWith(true));
  });

  it("says to scan the code only when a QR code is shown", () => {
    expect(openFailedMessage(true)).toBe("Couldn't open the link — scan the code instead.");
    expect(openFailedMessage(false)).toBe("Couldn't open the link.");
  });
});
