// The card page reaches both chat apps (spec 015 FR-2, FR-3), proven against the REAL MCP SDK: the
// kit registers through a structural port, so this test is what shows McpServer fits it.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { cardToolMeta, cardUris, MCP_APP_MIME, registerCardResources, registerPermissionStatusTool } from "./meta.js";
import { PERMISSION_STATUS_TOOL } from "./contract.js";

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

  it("serve the page exactly as built, with a CSP that allows data: images and no network", async () => {
    const client = await connect((server) => registerCardResources(server, html, uris));
    const [claude] = (await client.readResource({ uri: uris.resourceUri })).contents;
    const [chatgpt] = (await client.readResource({ uri: uris.skybridgeUri })).contents;
    expect(claude).toMatchObject({
      uri: uris.resourceUri,
      mimeType: "text/html;profile=mcp-app",
      text: html,
      _meta: { ui: { csp: { resourceDomains: ["data:"], connectDomains: [] } } },
    });
    expect(chatgpt).toMatchObject({
      uri: uris.skybridgeUri,
      mimeType: "text/html+skybridge",
      text: html,
      _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } },
    });
  });

  it("Claude's MIME type is the one the MCP Apps SDK defines", () => {
    expect(MCP_APP_MIME).toBe(RESOURCE_MIME_TYPE);
  });
});

describe("cardToolMeta", () => {
  it("links a tool's result to the page on both hosts, with every key a card's buttons need in ChatGPT", async () => {
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
      ui: { resourceUri: uris.resourceUri },
      "ui/resourceUri": uris.resourceUri,
      "openai/outputTemplate": uris.skybridgeUri,
      "openai/widgetAccessible": true,
      "openai/toolInvocation": { invoking: "Reading the stores…", invoked: "Done" },
    });
  });

  it("defaults the status lines", () => {
    expect(cardToolMeta(uris)["openai/toolInvocation"]).toEqual({ invoking: "Working…", invoked: "Done" });
  });
});

describe("the permission card's status tool", () => {
  const status = { status: "authorized", trustLevel: "device-signed", announce: true, final: true };

  it("is hidden from the model, callable from the card, and takes only a grant id", async () => {
    const client = await connect((server) => registerPermissionStatusTool(server, async () => status));
    const [tool] = (await client.listTools()).tools;
    expect(tool.name).toBe(PERMISSION_STATUS_TOOL);
    expect(tool._meta).toEqual({ ui: { visibility: ["app"] }, "openai/widgetAccessible": true });
    expect(tool.inputSchema).toEqual({ type: "object", properties: { grantId: { type: "string" } }, required: ["grantId"], additionalProperties: false });
  });

  it("answers what the server decided, and never hands a URL from the card to the server", async () => {
    const asked: string[] = [];
    const client = await connect((server) => registerPermissionStatusTool(server, async (grantId) => { asked.push(grantId); return status; }));
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: "g1", store: "https://evil.example" } });
    expect(result.structuredContent).toEqual(status);
    expect(asked).toEqual(["g1"]);
  });

  it("refuses a call without a string grant id", async () => {
    const client = await connect((server) => registerPermissionStatusTool(server, async () => status));
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: 5 } });
    expect(result.isError).toBe(true);
  });
});
