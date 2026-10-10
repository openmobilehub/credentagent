// The redraw guard (spec 015 FR-5). ChatGPT re-delivers the tool output on every
// `openai:set_globals`; the AP2 demo's card re-rendered on each one, flickered back to "Waiting",
// and restarted its work. These tests go red if the store stops comparing the data it shows.
import { describe, it, expect, vi } from "vitest";
import { createCardStore, readCard } from "./card-store";

const grant = { kind: "credentagent.grant", id: "g1", remaining: 146 };

describe("readCard", () => {
  it("takes the card's data from structuredContent and its card-only extras from _meta", () => {
    expect(readCard({ structuredContent: grant, _meta: { qr: "data:image/svg+xml;base64,AA" } })).toMatchObject({
      data: grant,
      meta: { qr: "data:image/svg+xml;base64,AA" },
    });
  });

  it("is no card without a kind", () => {
    expect(readCard({ structuredContent: { id: "g1" } })).toBeNull();
    expect(readCard({ structuredContent: "plain text" })).toBeNull();
    expect(readCard(undefined)).toBeNull();
  });
});

describe("createCardStore", () => {
  it("re-delivering the same result changes nothing", () => {
    const store = createCardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.show({ structuredContent: grant })).toBe(true);
    expect(store.show({ structuredContent: { ...grant } })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a changed result replaces the card", () => {
    const store = createCardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show({ structuredContent: grant });
    expect(store.show({ structuredContent: { ...grant, remaining: 100 } })).toBe(true);
    expect(store.current()?.data.remaining).toBe(100);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a result that is not a card leaves the card on screen", () => {
    const store = createCardStore();
    store.show({ structuredContent: grant });
    expect(store.show({ structuredContent: { text: "hello" } })).toBe(false);
    expect(store.current()?.data).toEqual(grant);
  });

  it("an unsubscribed listener hears nothing more", () => {
    const store = createCardStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.show({ structuredContent: grant });
    expect(listener).not.toHaveBeenCalled();
  });
});
