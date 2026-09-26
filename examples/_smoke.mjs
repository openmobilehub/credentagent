import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const c = new Client({ name: "smoke", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL("https://mcp-apps-1q2ox9mnt-dfzuluagas-projects.vercel.app/mcp")));
const b = await c.callTool({ name: "browse-products", arguments: {} });
const prods = b.structuredContent?.products ?? [];
console.log("products:", prods.length, "| images are generated data URIs:", prods.every(p=>p.image.startsWith("data:image/svg")));
await c.close(); process.exit(0);
