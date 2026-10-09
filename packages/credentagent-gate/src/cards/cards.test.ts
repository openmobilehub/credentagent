// The card kit end to end (spec 015 — the surface): configure once, register on a real MCP server,
// link a tool to the page, and return a grant as a card result.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { qrDataUrl } from "./qr.js";
import { createCards, GRANT_VIEW_KIND, OFFERS_KIND, PERMISSION_KIND, PERMISSION_STATUS_TOOL, QR_META_KEY, type GrantViewData, type PermissionInput } from "./index.js";

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
});

const permission: PermissionInput = {
  grantId: "g1",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/g1",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend",
  trustLevel: "presence-only-demo",
};

describe("cards.permission", () => {
  const signed = async () => ({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });

  it("shows the permission; its QR code reaches the card in _meta and costs the model no context", () => {
    const result = createCards({ readPermission: signed }).permission(permission);
    expect(result.structuredContent).toEqual({ kind: PERMISSION_KIND, ...permission });
    expect(String(result._meta?.[QR_META_KEY])).toMatch(/^data:image\/svg\+xml;/);
    expect(result._meta?.[QR_META_KEY]).toBe(qrDataUrl(permission.approveUrl)); // what the person scans is the signing link
    expect(result.content[0].text).toContain(JSON.stringify({ kind: PERMISSION_KIND, ...permission }, null, 2));
    expect(result.content[0].text).not.toContain("data:image");
  });

  it("needs readPermission — without it the card could never learn the permission was signed", async () => {
    const cards = createCards();
    expect(() => cards.permission(permission)).toThrow(/readPermission/);
    await expect(cards.waitForSignature("g1")).rejects.toThrow(/readPermission/);
  });

  it("needs a trust level, said out loud — missing or empty", () => {
    const cards = createCards({ readPermission: signed });
    for (const trustLevel of [undefined, ""]) {
      const withoutTrust = { ...permission, trustLevel } as unknown as PermissionInput;
      expect(() => cards.permission(withoutTrust)).toThrow(/trustLevel is required/);
    }
  });

  it("a signing link too long for a QR code throws, and no permission is remembered for it", async () => {
    const cards = createCards({ readPermission: signed });
    expect(() => cards.permission({ ...permission, approveUrl: `https://beanbarn.example/${"x".repeat(10_000)}` })).toThrow();
    expect(await cards.waitForSignature("g1")).toEqual({ status: "unknown" });
  });

  it("the model's wait answers what readPermission answered, extra fields included", async () => {
    const cards = createCards({ readPermission: signed });
    cards.permission(permission);
    expect(await cards.waitForSignature("g1")).toEqual({ status: "authorized", trustLevel: "device-signed", intent: "signed-intent" });
  });

  it("register adds the card-only status tool when readPermission is set, and only then", async () => {
    // One ordinary tool on both servers, so tools/list exists either way.
    const names = async (cards: ReturnType<typeof createCards>) =>
      (await (await connect((s) => { cards.register(s); s.registerTool("other", { description: "another tool" }, async () => ({ content: [] })); })).listTools()).tools.map((t) => t.name).sort();
    expect(await names(createCards({ readPermission: signed }))).toEqual([PERMISSION_STATUS_TOOL, "other"].sort());
    expect(await names(createCards())).toEqual(["other"]);
  });

  it("over MCP, the card learns it was signed — from the permission the kit issued, not from the card", async () => {
    const read: PermissionInput[] = [];
    const cards = createCards({ readPermission: async (p) => { read.push(p); return { status: "authorized", trustLevel: "device-signed" }; }, modelGraceMs: 0 });
    const client = await connect((server) => cards.register(server));
    cards.permission(permission);
    const result = await client.callTool({ name: PERMISSION_STATUS_TOOL, arguments: { grantId: "g1", store: "https://evil.example" } });
    expect(result.structuredContent).toEqual({ status: "authorized", trustLevel: "device-signed", announce: true, final: true });
    expect(read[0].store.url).toBe("https://beanbarn.example");
  });
});

describe("cards.offers", () => {
  it("is a card result with the derived note, which a note of your own replaces", () => {
    const stores = [{ store: "RoastWorks", url: "https://roastworks.example", products: [{ id: "cold-brew", name: "Cold Brew", price: 14 }] }];
    const result = createCards().offers({ stores, product: "cold brew" });
    expect(result.structuredContent).toMatchObject({ kind: OFFERS_KIND, summary: { sellers: ["RoastWorks"] } });
    expect(result.content[0].text.startsWith("Only RoastWorks sells it")).toBe(true);
    expect(createCards().offers({ stores }, { note: "Mine." }).content[0].text.startsWith("Mine.\n\n")).toBe(true);
  });
});
