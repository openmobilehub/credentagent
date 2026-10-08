// The card kit end to end (spec 015 — the surface): configure once, register on a real MCP server,
// link a tool to the page, and return a grant as a card result.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCards, GRANT_VIEW_KIND, type GrantViewData } from "./index.js";

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
    expect(tool._meta?.ui).toEqual({ resourceUri: page.uri });
    expect((await client.readResource({ uri: page.uri })).contents[0]).toMatchObject({ text: cards.html });
    expect((await client.callTool({ name: "get-grant", arguments: {} })).structuredContent).toEqual(grant);
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
    expect(block.text.startsWith("The person sees this grant in a card.")).toBe(true);
    expect(block.text).toContain(JSON.stringify(grant, null, 2));
  });

  it("a note replaces the default", () => {
    const [block] = createCards().grant(grant, { note: "AUTHORIZED — you can spend now." }).content;
    expect(block.text.startsWith("AUTHORIZED — you can spend now.\n\n")).toBe(true);
  });
});
