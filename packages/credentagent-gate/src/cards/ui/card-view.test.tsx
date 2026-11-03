// The card page's dispatch (spec 015 FR-9): a result's `kind` picks the card, an unknown kind shows
// nothing, and every preview sample renders inside the gallery's frame — the trust line included.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardBody, CardView, CardBoundary, grantActions } from "./CardView";
import { REVOKE_TOOL_META } from "../grant-view";
import { readCard } from "./card-store";
import { previewResult, previewViews } from "./preview";
import type { Bridge } from "./bridge";

const bridge: Bridge = { host: "preview", call: async () => null, open: async () => {} };
const render = (result: { structuredContent: unknown; _meta?: unknown } | null): string =>
  renderToStaticMarkup(<CardView card={readCard(result)} bridge={bridge} show={() => false} />);

describe("CardView", () => {
  it("renders a grant result as the gallery's card", () => {
    const html = render(previewResult("grant-product"));
    expect(html).toContain("Oak Reserve Whiskey");
    expect(html).toContain("limits enforced server-side");
  });

  it("shows nothing for a kind it does not know", () => {
    expect(render({ structuredContent: { kind: "someone.else" } })).toBe("");
  });

  it("every preview sample is a card that carries the trust line", () => {
    expect(previewViews().length).toBe(8);
    for (const view of previewViews()) {
      const html = render(previewResult(view));
      expect(html, view).toContain("limits enforced server-side");
      expect(html, view).toContain("delegated-demo");
    }
  });

  it("draws Revoke only when the result names the server's Revoke tool", () => {
    const sample = previewResult("grant-product")!;
    expect(render(sample)).toContain(">Revoke<");
    expect(render({ structuredContent: sample.structuredContent })).not.toContain(">Revoke<");
  });

  it("an unknown or missing preview name is no card", () => {
    expect(previewResult("constructor")).toBeNull();
    expect(previewResult(null)).toBeNull();
  });
});

describe("CardBody: a failed button press shows on the card", () => {
  const card = readCard(previewResult("grant-product"))!;

  it("says what went wrong under the card", () => {
    const html = renderToStaticMarkup(<CardBody card={card} actions={{}} trouble={{ error: new Error("boom") }} />);
    expect(html).toContain("Oak Reserve Whiskey");
    expect(html).toContain("complete that action: boom");
  });

  it("says nothing when no button failed", () => {
    expect(renderToStaticMarkup(<CardBody card={card} actions={{}} trouble={null} />)).not.toContain("couldn");
  });
});

// The Revoke and Open buttons are bare event handlers in the frame: a promise they return is never
// awaited. So a failure must be routed to `fail` here, or it vanishes (spec 015 FR-9: no silent failure).
describe("grantActions: a failed button says so instead of failing silently", () => {
  const grant = previewResult("grant-revoked")?.structuredContent;
  const boom = new Error("boom");
  const named = { [REVOKE_TOOL_META]: "my-revoke" };

  function harness(answer: () => Promise<unknown>, open: () => Promise<void> = async () => {}, meta: Record<string, unknown> = named) {
    const call = vi.fn(answer);
    const openLink = vi.fn(open);
    const shown = vi.fn(() => true);
    const fail = vi.fn();
    const actions = grantActions({ host: "preview", call, open: openLink }, meta, shown, fail);
    return { call, openLink, shown, fail, actions };
  }

  it("revoke calls the tool the result names and shows the grant it returns", async () => {
    const h = harness(async () => grant);
    await h.actions.revoke?.("g1");
    expect(h.call).toHaveBeenCalledWith("my-revoke", { grantId: "g1" });
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

  it("no Revoke tool named: no revoke action, so no server tool is guessed", () => {
    expect(harness(async () => grant, undefined, {}).actions.revoke).toBeUndefined();
    expect(harness(async () => grant, undefined, { [REVOKE_TOOL_META]: "" }).actions.revoke).toBeUndefined();
  });

  it.each(["http://localhost:3005/approve", "http://127.0.0.1/approve", "http://[::1]:8080/approve"])(
    "a local http link (%s) is opened, for development",
    async (url) => {
      const h = harness(async () => grant);
      await h.actions.openLink?.(url);
      expect(h.openLink).toHaveBeenCalledWith(url);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "/credentagent/grants/g1",
    "http://example.test/approve",
    "http://localhost.evil.test/approve", // the host is localhost.evil.test
    "http://localhost@evil.test/approve", // the host is evil.test; localhost is only a user name
    "not a url",
  ])(
    "a link that isn't a safe web address (%s) never reaches the host, and the card says so",
    async (url) => {
      const h = harness(async () => grant);
      await h.actions.openLink?.(url);
      expect(h.openLink).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledWith(new Error("the merchant's link isn't a safe web address"));
    },
  );

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
