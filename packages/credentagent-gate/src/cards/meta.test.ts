// The card page reaches both chat apps (spec 015 FR-7), proven against the REAL MCP SDK: the kit
// registers through a structural port, so this test is what shows McpServer fits it.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { cardToolMeta, cardUris, MCP_APP_MIME, registerCardResources } from "./meta.js";

const uris = cardUris("0123456789ab");
// The page is served exactly as built: replacement-string patterns must survive untouched.
const html = "<!doctype html><p>$& $` $$ survive</p>";

async function connect(build: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "cards-test", version: "1.0.0" });
  build(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cards-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("the card page's two resources", () => {
  it("are one page, for Claude (MCP Apps) and ChatGPT (skybridge), under URIs that carry its hash", async () => {
    const client = await connect((server) => registerCardResources(server, html, uris));
    const listed = (await client.listResources()).resources.map((r) => ({ uri: r.uri, mimeType: r.mimeType }));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { uri: "ui://credentagent-cards/cards-0123456789ab.html", mimeType: "text/html;profile=mcp-app" },
        { uri: "ui://credentagent-cards/cards-0123456789ab.skybridge.html", mimeType: "text/html+skybridge" },
      ]),
    );
  });

  it("serve the page exactly as built, with no network origins and no bare scheme in the MCP Apps CSP (#372)", async () => {
    // Bypass guard: a bare `data:` back in either `_meta.ui.csp`, the skybridge copy losing its
    // `_meta.ui.csp`, or ChatGPT's own CSP losing `data:` (a blank QR there) each fails this test.
    const BARE = /^(\*|[a-z][a-z0-9+.-]*:)$/i;
    const client = await connect((server) => registerCardResources(server, html, uris));
    const [claude] = (await client.readResource({ uri: uris.resourceUri })).contents;
    const [chatgpt] = (await client.readResource({ uri: uris.skybridgeUri })).contents;
    const uiCsp = { ui: { csp: { resourceDomains: [], connectDomains: [] } } };
    expect(claude).toEqual({ uri: uris.resourceUri, mimeType: "text/html;profile=mcp-app", text: html, _meta: uiCsp });
    expect(chatgpt).toEqual({
      uri: uris.skybridgeUri,
      mimeType: "text/html+skybridge",
      text: html,
      _meta: { ...uiCsp, "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } },
    });
    for (const { _meta } of [claude, chatgpt]) {
      const csp = (_meta as typeof uiCsp).ui.csp;
      for (const entry of [...csp.resourceDomains, ...csp.connectDomains]) expect(entry).not.toMatch(BARE);
    }
  });

  it("Claude's MIME type is the one the MCP Apps SDK defines", () => {
    expect(MCP_APP_MIME).toBe(RESOURCE_MIME_TYPE);
  });
});

describe("cardToolMeta", () => {
  it("links a tool's result to the page on both hosts, and by default only the model calls the tool", async () => {
    const client = await connect((server) => {
      registerCardResources(server, html, uris);
      server.registerTool(
        "compare",
        { description: "shows a card", _meta: cardToolMeta(uris, { invoking: "Reading the stores…" }) },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });
    const [tool] = (await client.listTools()).tools;
    expect(tool._meta).toEqual({
      ui: { resourceUri: uris.resourceUri, visibility: ["model"] },
      "ui/resourceUri": uris.resourceUri,
      "openai/outputTemplate": uris.skybridgeUri,
      "openai/widgetAccessible": false,
      "openai/toolInvocation/invoking": "Reading the stores…",
      "openai/toolInvocation/invoked": "Done",
    });
  });

  it("the card's script can't call a tool unless it opts in (spec 015 FR-7)", () => {
    // Bypass guard: a default that lets the card call the tool — on either host — fails here. MCP
    // Apps' own default is ["model", "app"], so a missing visibility counts as callable too.
    for (const meta of [cardToolMeta(uris), cardToolMeta(uris, { callableFromCard: false }), cardToolMeta(uris, { invoking: "x" })]) {
      expect(meta.ui.visibility).toEqual(["model"]);
      expect(meta["openai/widgetAccessible"]).toBe(false);
    }
  });

  it("callableFromCard: true lets the card's button call it, on both hosts", () => {
    const meta = cardToolMeta(uris, { callableFromCard: true });
    expect(meta.ui.visibility).toEqual(["model", "app"]);
    expect(meta["openai/widgetAccessible"]).toBe(true);
  });

  it("defaults the status lines, under the flat keys ChatGPT reads", () => {
    const meta = cardToolMeta(uris);
    expect(meta["openai/toolInvocation/invoking"]).toBe("Working…");
    expect(meta["openai/toolInvocation/invoked"]).toBe("Done");
  });
});
