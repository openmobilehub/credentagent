// The card kit end to end (spec 015 — the surface): configure once, register on a real MCP server,
// link a tool to the page, and return a grant as a card result.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCards, GRANT_VIEW_KIND, REVOKE_TOOL_META, type GrantViewData } from "./index.js";
import { UNSAFE_LINKS } from "./ui/__fixtures__/links.js";

const grant: GrantViewData = {
  kind: GRANT_VIEW_KIND,
  id: "grant_test",
  merchant: "Utopia",
  status: "authorized",
  lifecycle: "active",
  budget: 200,
  spent: 54,
  remaining: 146,
  perSpend: 130,
  allow: { skus: [], categories: [] },
  approveUrl: "https://utopia.example/credentagent/grants/grant_test",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
  credentials: { ageVerified: null, loyaltyDiscountPct: null },
};

async function connect(build: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "cards-test", version: "1.0.0" });
  build(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cards-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("createCards", () => {
  it("serves the built page and links a tool to it; the tool's result is the grant card's data", async () => {
    const cards = createCards();
    const client = await connect((server) => {
      cards.register(server);
      server.registerTool("get-grant", { description: "the grant", _meta: cards.toolMeta() }, async () => cards.grant(grant));
    });
    const page = (await client.listResources()).resources.find((r) => r.mimeType === "text/html;profile=mcp-app")!;
    const [tool] = (await client.listTools()).tools;
    expect(tool._meta?.ui).toEqual({ resourceUri: page.uri, visibility: ["model"] });
    expect((await client.readResource({ uri: page.uri })).contents[0]).toMatchObject({ text: cards.html });
    expect((await client.callTool({ name: "get-grant", arguments: {} })).structuredContent).toEqual(grant);
  });

  it("names the page by a hash of its content, so a changed page is a new URI the hosts fetch afresh", async () => {
    const cards = createCards();
    const hash = createHash("sha256").update(cards.html).digest("hex").slice(0, 12);
    const client = await connect((server) => {
      cards.register(server);
      server.registerTool("get-grant", { description: "the grant", _meta: cards.toolMeta() }, async () => cards.grant(grant));
    });
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toHaveLength(2);
    expect(uris).toEqual(
      expect.arrayContaining([`ui://credentagent-cards/cards-${hash}.html`, `ui://credentagent-cards/cards-${hash}.skybridge.html`]),
    );
    const [tool] = (await client.listTools()).tools;
    expect(tool._meta?.["openai/outputTemplate"]).toBe(`ui://credentagent-cards/cards-${hash}.skybridge.html`);
  });

  it("a stateless server registers the same page on every per-request server", async () => {
    const cards = createCards();
    const first = await connect((server) => cards.register(server));
    const second = await connect((server) => cards.register(server));
    expect((await first.listResources()).resources).toEqual((await second.listResources()).resources);
  });
});

describe("cards.grant", () => {
  it("tells the model what to do next, then gives it the same data the card shows", () => {
    const [block] = createCards().grant(grant).content;
    expect(block.text.startsWith("If the person can see this grant in a card,")).toBe(true);
    expect(block.text).toContain(JSON.stringify(grant, null, 2));
  });

  it("a note replaces the default", () => {
    const [block] = createCards().grant(grant, { note: "AUTHORIZED — you can spend now." }).content;
    expect(block.text.startsWith("AUTHORIZED — you can spend now.\n\n")).toBe(true);
    expect(block.text).not.toContain("this grant in a card");
  });

  it("toolMeta passes callableFromCard through, for the tool a card's button calls", () => {
    const cards = createCards();
    expect(cards.toolMeta().ui.visibility).toEqual(["model"]);
    expect(cards.toolMeta({ callableFromCard: true }).ui.visibility).toEqual(["model", "app"]);
  });
});

describe("cards.grant checks the merchant's link (spec 015 FR-11)", () => {
  const WARNING = "The merchant's approveUrl isn't a safe web address: don't show it to the person or pass it on.";
  const cards = createCards();
  const noteOf = (approveUrl: string, note?: string) => {
    const [block] = cards.grant({ ...grant, approveUrl }, note ? { note } : undefined).content;
    return block.text.slice(0, block.text.indexOf("\n\n"));
  };

  it.each(UNSAFE_LINKS)("tells the model not to pass on %s, and doesn't throw", (link) => {
    expect(noteOf(link)).toContain(WARNING);
  });

  it("keeps the warning when the developer passes their own note", () => {
    expect(noteOf("javascript:alert(1)", "AUTHORIZED — you can spend now.")).toBe(`AUTHORIZED — you can spend now. ${WARNING}`);
  });

  it.each(["https://utopia.example/approve", "http://localhost:3005/approve", "http://127.0.0.1:3005/approve", "http://[::1]:3005/approve"])(
    "adds nothing for a safe link: %s",
    (link) => {
      expect(noteOf(link)).not.toContain(WARNING);
    },
  );
});

describe("cards.grant results share no state (security invariant 4)", () => {
  it("one result's _meta, changed by its caller, never reaches the next result", () => {
    const cards = createCards({ tools: { revoke: "revoke-grant" } });
    const first = cards.grant(grant);
    first._meta![REVOKE_TOOL_META] = "someone-elses-tool";
    first._meta!.perUser = "secret";
    const second = cards.grant(grant);
    expect(second._meta).toEqual({ [REVOKE_TOOL_META]: "revoke-grant" });
  });
});

describe("cards.grant names the Revoke tool (spec 015 FR-6)", () => {
  it("with tools.revoke, the result names that tool in _meta, so the card draws Revoke and calls it", async () => {
    const cards = createCards({ tools: { revoke: "my-revoke" } });
    const client = await connect((server) => {
      cards.register(server);
      server.registerTool("get-grant", { description: "the grant", _meta: cards.toolMeta() }, async () => cards.grant(grant));
    });
    const result = await client.callTool({ name: "get-grant", arguments: {} });
    expect(result._meta?.[REVOKE_TOOL_META]).toBe("my-revoke");
  });

  it("without it, the result names no tool, so the card draws no Revoke rather than guess one", () => {
    expect(createCards().grant(grant)._meta?.[REVOKE_TOOL_META]).toBeUndefined();
  });
});
