// widget/serve.mjs — the agent's chat widget. One HTML page (widget.html), served to Claude as an MCP
// Apps resource and to ChatGPT as an Apps SDK ("skybridge") resource, the same two-resource pattern the
// storefront package uses. Example glue, not library API.
//
// The page is a single file with no build step, so the MCP Apps client (`app-with-deps`, a self-contained
// ES module) is inlined into it, and its export list becomes `globalThis.ExtApps` for the page script.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import QRCode from "qrcode";

const SKYBRIDGE_MIME = "text/html+skybridge";

function inlineExtApps() {
  const code = readFileSync(new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")), "utf8");
  const tail = code.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!tail) throw new Error("@modelcontextprotocol/ext-apps/app-with-deps no longer ends in one export list — update widget/serve.mjs");
  const names = tail[1].split(",").map((s) => s.trim().split(/\s+as\s+/)).map(([local, name]) => `${JSON.stringify(name ?? local)}:${local}`);
  const body = `${code.slice(0, tail.index)}globalThis.ExtApps={${names.join(",")}};`;
  return `<script type="module">${body.replace(/<\/script/gi, "<\\/script")}</script>`; // no raw </script inside an inline script
}

export function createWidget() {
  // A replacer FUNCTION, not a string: in a replacement string "$&", "$`" and "$$" are patterns, and the
  // minified client is full of them — a string replace() corrupts it into a syntax error.
  const page = readFileSync(new URL("./widget.html", import.meta.url), "utf8").replace("<!--EXT_APPS-->", () => inlineExtApps());
  // Hosts cache a resource by URI, so the URI carries the page's hash: a changed page is a new URI.
  const version = createHash("sha256").update(page).digest("hex").slice(0, 12);
  const uri = `ui://credentagent-ap2-agent/widget-${version}.html`;
  const skybridgeUri = `ui://credentagent-ap2-agent/widget-${version}.skybridge.html`;

  return {
    page,
    /** `_meta` for a tool whose result the widget renders. */
    meta: (invoking, invoked) => ({
      ui: { resourceUri: uri },
      "openai/outputTemplate": skybridgeUri,
      "openai/widgetAccessible": true,
      "openai/toolInvocation": { invoking, invoked },
    }),
    register(server) {
      // `data:` so the QR code (an SVG data URL) renders under the host's CSP.
      registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: page, _meta: { ui: { csp: { resourceDomains: ["data:"] } } } }],
      }));
      server.registerResource("ap2-agent-widget-skybridge", skybridgeUri, { mimeType: SKYBRIDGE_MIME }, async () => ({
        contents: [{ uri: skybridgeUri, mimeType: SKYBRIDGE_MIME, text: page, _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: ["data:"] } } }],
      }));
    },
  };
}

/** The signing link as a QR code the person scans with their phone — an SVG data URL. */
export async function qrDataUrl(url) {
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Sample results for the local preview (`/widget?view=offers|only-one|permission|receipt|refused`), shaped exactly like the tools' results. */
export async function previewResult(view) {
  const products = (h, e, t) => [
    { id: "house-blend", name: "House Blend, 1 lb bag", price: h[0], rating: h[1] },
    { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: e[0], rating: e[1] },
    { id: "green-tea", name: "Green Tea, 50 bags", price: t[0], rating: t[1] },
  ];
  const approveUrl = "https://beanbarn.example/credentagent/grants/grant_preview";
  const checks = [
    "The permission's wallet signature verifies",
    "The agent signed with the key that permission names",
    "The cart is the one we quoted and signed",
    "The permission allows this store",
    "Within the signed limits: $21.00 of $50.00, max $25.00 a purchase",
    "Our catalog prices it at $21.00",
    "Fresh purchase code, addressed to us (no replay)",
  ];
  const results = {
    offers: { view: "offers", stores: [
      { store: "Acme Coffee Co", url: "https://acme.example", products: products([24, 4.1], [19, 4.0], [9, 3.8]) },
      { store: "BeanBarn", url: "https://beanbarn.example", products: products([21, 4.4], [22, 4.2], [8, 4.5]) },
      { store: "RoastWorks", url: "https://roastworks.example", products: products([26, 4.6], [18, 4.7], [11, 4.0]) },
    ] },
    permission: {
      structuredContent: {
        view: "permission", store: "BeanBarn", storeUrl: "https://beanbarn.example", merchantId: "beanbarn.example", grantId: "grant_preview",
        approveUrl, products: ["House Blend, 1 lb bag"], budget: 50, perSpend: 25,
        why: "lowest price for House Blend ($21), and a 4.4 rating — only RoastWorks rates higher, at $5 more.", status: "pending",
      },
      _meta: { "ap2/qr": await qrDataUrl(approveUrl) },
    },
    receipt: { view: "receipt", ok: true, receiptUrl: "https://beanbarn.example/agent/orders/ord_preview", order: {
      id: "ord_preview", store: "BeanBarn", amount: 2100, items: ["1 × House Blend, 1 lb bag"], trust_level: "presence-only-demo", checks,
    } },
    refused: { view: "receipt", ok: false, store: "Acme Coffee Co", code: "constraint", reason: "This permission was signed for another store" },
    // Scenario 1: the person named a product only one store sells.
    "only-one": { view: "offers", summary: { product: "cold brew", sellers: ["RoastWorks"] }, stores: [
      { store: "Acme Coffee Co", url: "https://acme.example", products: [] },
      { store: "BeanBarn", url: "https://beanbarn.example", products: [] },
      { store: "RoastWorks", url: "https://roastworks.example", products: [{ id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
    ] },
  };
  return results[view] ?? results.offers;
}
