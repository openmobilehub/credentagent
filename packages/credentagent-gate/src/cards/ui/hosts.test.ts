// Both chat apps may hand the card a result it already showed: ChatGPT re-delivers `toolOutput` on
// every `openai:set_globals` — a theme change, a resize — and an MCP Apps host such as Claude may
// re-send a `toolresult`. A card the user changed themselves (a Revoke) must stay changed. These tests
// go red if a host's delivery stops being compared with the one it last delivered and falls back to
// comparing it with the card on screen. They also pin that a bridge call the host can't make rejects,
// so the card says so instead of failing silently.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectHost } from "./hosts";
import { createCardStore } from "./card-store";

const active = { kind: "credentagent.grant", id: "g1", lifecycle: "active", remaining: 146 };
const revoked = { ...active, lifecycle: "revoked" };

// Claude's side of the page is the ext-apps client. The fake records its listeners and, like the real
// host, sends the result that opened the card during `connect()` — so a page that listened only after
// connecting would miss it.
const claude = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;
  class FakeApp {
    static current: FakeApp;
    static firstResult: unknown;
    static openLinkAnswer: { isError?: boolean } = {};
    listeners = new Map<string, Listener[]>();
    opened: string[] = [];
    constructor() {
      FakeApp.current = this;
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(type: string, payload: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(payload);
    }
    async connect() {
      this.send("toolresult", FakeApp.firstResult);
    }
    getHostContext() {
      return undefined;
    }
    async callServerTool() {
      return { content: [], structuredContent: revoked };
    }
    async openLink({ url }: { url: string }) {
      this.opened.push(url);
      return FakeApp.openLinkAnswer;
    }
  }
  return { FakeApp };
});
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: claude.FakeApp,
  applyDocumentTheme: () => {},
  applyHostFonts: () => {},
  applyHostStyleVariables: () => {},
}));

/** A frame with no `window.openai`: an MCP Apps host, such as Claude. */
const claudeWindow = { self: {}, top: {} } as unknown as Parameters<typeof connectHost>[1];

/** A window as ChatGPT presents it: `openai` globals, `set_globals` events, and no parent frame. */
function chatGptWindow(toolOutput: unknown) {
  const openai: Record<string, unknown> = {
    toolOutput,
    toolResponseMetadata: {},
    callTool: async () => ({ structuredContent: revoked }),
    openExternal: async () => {},
  };
  const win = Object.assign(new EventTarget(), { openai, self: {}, top: {} });
  return { win: win as unknown as Parameters<typeof connectHost>[1], openai, redeliver: () => win.dispatchEvent(new Event("openai:set_globals")) };
}

describe("connectHost in Claude (MCP Apps)", () => {
  beforeEach(() => {
    claude.FakeApp.firstResult = { content: [], structuredContent: active };
    claude.FakeApp.openLinkAnswer = {};
  });

  it("shows the result that opened the card, even when it arrives while connecting", async () => {
    const store = createCardStore();
    const bridge = await connectHost(store, claudeWindow);
    expect(bridge.host).toBe("mcp");
    expect(store.current()?.data).toEqual(active);
  });

  it("a re-delivery of the old result does not undo what the card changed", async () => {
    const store = createCardStore();
    const bridge = await connectHost(store, claudeWindow);

    // Revoke, as the card does it: call the server tool, then show the grant it returns.
    store.show({ structuredContent: await bridge.call("revoke-grant", { grantId: "g1" }) });
    expect(store.current()?.data).toEqual(revoked);

    claude.FakeApp.current.send("toolresult", { content: [], structuredContent: active }); // the host re-sends
    expect(store.current()?.data).toEqual(revoked);
  });

  it("a new result from the host still replaces the card", async () => {
    const store = createCardStore();
    await connectHost(store, claudeWindow);
    claude.FakeApp.current.send("toolresult", { content: [], structuredContent: { ...active, id: "g2", remaining: 20 } });
    expect(store.current()?.data).toMatchObject({ id: "g2", remaining: 20 });
  });

  it("opens a link through the host, and rejects when the host answers that it didn't", async () => {
    const bridge = await connectHost(createCardStore(), claudeWindow);
    await bridge.open("https://example.test/approve");
    expect(claude.FakeApp.current.opened).toEqual(["https://example.test/approve"]);

    claude.FakeApp.openLinkAnswer = { isError: true };
    await expect(bridge.open("https://example.test/approve")).rejects.toThrow("didn't open the link");
  });
});

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

  it("a re-delivery that changes only the metadata does not undo it either", async () => {
    const store = createCardStore();
    const { win, openai, redeliver } = chatGptWindow(active);
    const bridge = await connectHost(store, win);
    store.show({ structuredContent: await bridge.call("revoke-grant", { grantId: "g1" }) });

    openai.toolResponseMetadata = { "openai/widgetSessionId": "s2" };
    redeliver();
    expect(store.current()?.data).toEqual(revoked);
  });

  it("a new result from ChatGPT still replaces the card", async () => {
    const store = createCardStore();
    const { win, openai, redeliver } = chatGptWindow(active);
    await connectHost(store, win);

    openai.toolOutput = { ...active, id: "g2", remaining: 20 };
    redeliver();
    expect(store.current()?.data).toMatchObject({ id: "g2", remaining: 20 });
  });

  it("a ChatGPT that can't open links or call tools from a card rejects, so the card says so", async () => {
    const { win, openai } = chatGptWindow(active);
    delete openai.openExternal;
    delete openai.callTool;
    const bridge = await connectHost(createCardStore(), win);
    await expect(bridge.open("https://example.test/approve")).rejects.toThrow("can't open links");
    await expect(bridge.call("revoke-grant", { grantId: "g1" })).rejects.toThrow("can't call the server");
  });
});

describe("connectHost in a browser tab (the preview)", () => {
  it("has no server to call, and says so", async () => {
    const tab = {};
    const win = Object.assign(tab, { self: tab, top: tab, location: { search: "?view=grant-product" }, open: vi.fn() });
    const store = createCardStore();
    const bridge = await connectHost(store, win as unknown as Parameters<typeof connectHost>[1]);
    expect(bridge.host).toBe("preview");
    expect(store.current()?.data).toMatchObject({ kind: "credentagent.grant", lifecycle: "active" });
    await expect(bridge.call("revoke-grant", { grantId: "grant_preview" })).rejects.toThrow("no server to call");
  });
});
