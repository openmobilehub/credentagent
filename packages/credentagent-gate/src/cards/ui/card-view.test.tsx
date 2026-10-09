// The card page's dispatch (spec 015 FR-5): a result's `kind` picks the card, an unknown kind shows
// nothing, and every preview sample renders inside the gallery's frame — the trust line included.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView, CardBoundary, grantActions } from "./CardView";
import { readCard } from "./card-store";
import { GRANT_VIEW_KIND } from "./grants";
import { previewCall, previewResult, previewViews } from "./preview";
import { createSignatureWatch, type SignatureWatch } from "./signature-watch";
import { OFFERS_KIND, PERMISSION_KIND, PERMISSION_STATUS_TOOL, RECEIPT_KIND } from "../contract";
import type { Bridge } from "./bridge";

const bridge: Bridge = { host: "preview", call: async () => null, open: async () => {}, tell: async () => {} };
const render = (result: { structuredContent: unknown; _meta?: Record<string, unknown> } | null): string =>
  renderToStaticMarkup(<CardView card={readCard(result)} bridge={bridge} watch={createSignatureWatch(bridge)} show={() => false} />);

describe("CardView", () => {
  it("renders a grant result as the gallery's card", () => {
    const html = render(previewResult("grant-product"));
    expect(html).toContain("Oak Reserve Whiskey");
    expect(html).toContain("limits enforced server-side");
  });

  it("shows nothing for a kind it does not know", () => {
    expect(render({ structuredContent: { kind: "someone.else" } })).toBe("");
  });

  it("every preview sample renders its card, with the honesty its kind requires", () => {
    for (const view of previewViews()) {
      const result = previewResult(view)!;
      const html = render(result);
      const kind = readCard(result)!.data.kind;
      if (kind === GRANT_VIEW_KIND) expect(html, view).toContain("limits enforced server-side");
      else if (kind === PERMISSION_KIND) expect(html, view).toContain("No real money moves");
      else if (kind === OFFERS_KIND) expect(html, view).toContain("Offers, read live from each store"); // no trust claim to make
      else if (kind === RECEIPT_KIND) expect(html, view).toContain("No real money moves");
      else throw new Error(`no honesty expectation for ${kind} (${view})`);
    }
  });

  it("renders a permission result as the permission card, with its QR code", () => {
    const html = render(previewResult("permission"));
    expect(html).toContain("Sign on your phone to let the agent buy at BeanBarn");
    expect(html).toContain('src="data:image/svg+xml');
  });

  it("the permission card draws the watch's state for its own grant", () => {
    const watch: SignatureWatch = {
      follow: () => {}, // renderToStaticMarkup runs no effects; the follow itself is covered by signature-watch.test.ts
      state: (grantId) => (grantId === "grant_preview" ? { kind: "signed", trustLevel: "device-signed" } : { kind: "waiting" }),
      subscribe: () => () => {},
    };
    const html = renderToStaticMarkup(<CardView card={readCard(previewResult("permission"))} bridge={bridge} watch={watch} show={() => false} />);
    expect(html).toContain("Signed on your phone · device-signed");
    expect(html).not.toContain("Waiting for your signature");
  });

  it("an unknown or missing preview name is no card", () => {
    expect(previewResult("constructor")).toBeNull();
    expect(previewResult(null)).toBeNull();
  });

  it("the preview's signed permission answers its own status tool", () => {
    expect(previewCall("permission-signed", PERMISSION_STATUS_TOOL)).toEqual({ status: "authorized", trustLevel: "device-signed", announce: false, final: true });
    expect(previewCall("permission", PERMISSION_STATUS_TOOL)).toBeNull();
  });
});

// The Revoke and Open buttons are bare event handlers in the frame: a promise they return is never
// awaited. So a failure must be routed to `fail` here, or it vanishes (spec 015 FR-5: no silent failure).
describe("grantActions: a failed button says so instead of failing silently", () => {
  const grant = previewResult("grant-revoked")?.structuredContent;
  const boom = new Error("boom");

  function harness(answer: () => Promise<unknown>, open: () => Promise<void> = async () => {}) {
    const call = vi.fn(answer);
    const openLink = vi.fn(open);
    const shown = vi.fn(() => true);
    const fail = vi.fn();
    const actions = grantActions({ host: "preview", call, open: openLink, tell: async () => {} }, shown, fail);
    return { call, openLink, shown, fail, actions };
  }

  it("revoke calls the server's revoke-grant tool and shows the grant it returns", async () => {
    const h = harness(async () => grant);
    await h.actions.revoke?.("g1");
    expect(h.call).toHaveBeenCalledWith("revoke-grant", { grantId: "g1" });
    expect(h.shown).toHaveBeenCalledWith({ structuredContent: grant });
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("a rejected revoke call reaches fail and shows nothing", async () => {
    const h = harness(async () => {
      throw boom;
    });
    await h.actions.revoke?.("g1");
    expect(h.fail).toHaveBeenCalledWith(boom);
    expect(h.shown).not.toHaveBeenCalled();
  });

  it("a non-card answer (the server's unknown-grant refusal) reaches fail and shows nothing", async () => {
    const h = harness(async () => ({ error: "unknown grant" }));
    await h.actions.revoke?.("g1");
    expect(h.fail).toHaveBeenCalledWith(new Error("the server did not answer with the grant"));
    expect(h.shown).not.toHaveBeenCalled();
  });

  it("an answer that is another card kind is not the grant either, and shows nothing", async () => {
    const h = harness(async () => ({ kind: "someone.else" }));
    await h.actions.revoke?.("g1");
    expect(h.fail).toHaveBeenCalledTimes(1);
    expect(h.shown).not.toHaveBeenCalled();
  });

  it("open hands the approval link to the bridge", async () => {
    const h = harness(async () => grant);
    await h.actions.openLink?.("https://example.test/approve");
    expect(h.openLink).toHaveBeenCalledWith("https://example.test/approve");
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("a rejected open reaches fail", async () => {
    const h = harness(async () => grant, async () => {
      throw boom;
    });
    await h.actions.openLink?.("https://example.test/approve");
    expect(h.fail).toHaveBeenCalledWith(boom);
  });
});

describe("CardBoundary", () => {
  // A thrown null or undefined is still a failure: the card must say so, not render blank.
  it.each([null, undefined])("a throw of %s still shows the failure sentence", (thrown) => {
    const boundary = new CardBoundary({ children: "the card" });
    boundary.state = CardBoundary.getDerivedStateFromError(thrown);
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain("This card couldn");
    expect(html).not.toContain("the card");
  });
});
