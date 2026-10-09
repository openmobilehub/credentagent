// ChatGPT re-delivers `toolOutput` on every `openai:set_globals` — a theme change, a resize — and
// keeps holding the result that opened the card. A card the person changed themselves (a Revoke)
// must stay changed. These tests go red if `connectChatGpt` stops comparing the host's result with
// the one it last delivered and falls back to comparing it with the card on screen.
import { describe, it, expect, vi } from "vitest";
import { connectHost } from "./hosts";
import { createCardStore } from "./card-store";

const active = { kind: "credentagent.grant", id: "g1", lifecycle: "active", remaining: 146 };
const revoked = { ...active, lifecycle: "revoked" };

/** A window as ChatGPT presents it: `openai` globals, `set_globals` events, and no parent frame. */
function chatGptWindow(toolOutput: unknown) {
  const openai = {
    toolOutput,
    toolResponseMetadata: {},
    callTool: async () => ({ structuredContent: revoked }),
    sendFollowUpMessage: vi.fn(async () => {}),
  };
  const win = Object.assign(new EventTarget(), { openai, self: {}, top: {} });
  return { win: win as unknown as Parameters<typeof connectHost>[1], openai, redeliver: () => win.dispatchEvent(new Event("openai:set_globals")) };
}

describe("connectHost in ChatGPT", () => {
  it("shows the result that opened the card", async () => {
    const store = createCardStore();
    const { win } = chatGptWindow(active);
    await connectHost(store, win);
    expect(store.current()?.data).toEqual(active);
  });

  it("a re-delivery of the old result does not undo what the card changed", async () => {
    const store = createCardStore();
    const { win, redeliver } = chatGptWindow(active);
    const bridge = await connectHost(store, win);

    // Revoke, as the card does it: call the server tool, then show the grant it returns.
    store.show({ structuredContent: await bridge.call("revoke-grant", { grantId: "g1" }) });
    expect(store.current()?.data).toEqual(revoked);

    redeliver(); // the host still holds the active grant as `toolOutput`
    expect(store.current()?.data).toEqual(revoked);
  });

  it("in ChatGPT, tell posts the follow-up message (a fallback: it did not post in real ChatGPT)", async () => {
    const store = createCardStore();
    const { win, openai } = chatGptWindow(active);
    const bridge = await connectHost(store, win);
    await bridge.tell("I signed the permission");
    expect(openai.sendFollowUpMessage).toHaveBeenCalledWith({ prompt: "I signed the permission" });
  });

  it("a ChatGPT that cannot post the follow-up message leaves tell quiet, not thrown", async () => {
    const store = createCardStore();
    const { win, openai } = chatGptWindow(active);
    openai.sendFollowUpMessage.mockRejectedValueOnce(new Error("not allowed"));
    const bridge = await connectHost(store, win);
    await expect(bridge.tell("I signed the permission")).resolves.toBeUndefined();
  });

  it("a new result from ChatGPT still replaces the card", async () => {
    const store = createCardStore();
    const { win, openai, redeliver } = chatGptWindow(active);
    await connectHost(store, win);

    openai.toolOutput = { ...active, id: "g2", remaining: 20 };
    redeliver();
    expect(store.current()?.data).toMatchObject({ id: "g2", remaining: 20 });
  });
});
