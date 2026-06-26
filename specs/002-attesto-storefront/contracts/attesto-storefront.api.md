# Contract: `@openmobilehub/attesto-storefront` public API (v0.1, 002)

The surface the implementation MUST satisfy and tests MUST exercise. TypeScript signatures are the contract.
The pricing model (`priceCart` / `createOrder` / `requiredAgeForLines` / `SAMPLE_CATALOG` / the types) from
the `.` entry is unchanged from 001 and is not restated here.

## Server entry — `@openmobilehub/attesto-storefront/server`

```ts
export interface StorefrontOptions {
  catalog?: Product[];                 // default SAMPLE_CATALOG
  baseUrl?: string;                    // default http://localhost:<port>
  reviews?: Record<string, Review[]>;  // optional, backs get-product-reviews
}

export type GateResolver = (order: Order) => VerificationManifestEntry[] | undefined;

export interface Storefront {
  app: ExpressApp;                     // attesto.mount(app) + ceremony routes attach here
  catalog: Product[];
  mcpServer(): McpServer;              // fresh server (HTTP /mcp per request; in-memory transport for tests)
  gate(resolve: GateResolver): void;   // inject the gate → checkout surfaces `requires`
  listen(port?: number): Promise<{ url: string; port: number }>;  // → http://host:port/mcp
}

export function createStorefront(opts?: StorefrontOptions): Storefront;
```

`VerificationManifestEntry` is re-exported from `@openmobilehub/attesto-gate` (001) — the storefront does
not redefine it.

## MCP tools (registered by `mcpServer()`)

Nine tools — **six UI-linked** (`registerAppTool` + the tool-meta → the `ui://` widget: `browse-products`,
`add-to-cart`, `set-quantity`, `remove-from-cart`, `get-cart`, `checkout`) and **three plain**
(`registerTool`, no widget: `get-product-details`, `get-product-reviews`, `get-order-status`) — preserving
the demo's split. Names and shapes:

| Tool | Input (zod) | structuredContent |
|------|-------------|-------------------|
| `browse-products` | `{}` | `{ products: Array<{ productId, name, price, currency, image, category, minimumAge? }> }` |
| `get-product-details` | `{ productId }` | `{ product }` |
| `get-product-reviews` | `{ productId }` | `{ reviews: Review[] }` |
| `add-to-cart` | `{ productId, quantity }` | `{ cart: PricedCart }` |
| `set-quantity` | `{ productId, quantity }` | `{ cart: PricedCart }` |
| `remove-from-cart` | `{ productId }` | `{ cart: PricedCart }` |
| `get-cart` | `{}` | `{ cart: PricedCart }` |
| `checkout` | `{ items?: CartItemInput[] }` | `{ orderId, checkoutUrl, requires? }` |
| `get-order-status` | `{ orderId }` | `{ orderId, status: "pending"\|"completed"\|"unknown", order? }` |

`checkout` is consolidated **Mode A** (001): it always returns `checkoutUrl`; it includes `requires` only
when a gate is injected and the gate returns a non-empty manifest.

## UI resource + ChatGPT widget contract (FR-014)

`mcpServer()` MUST register the single-file widget as a `ui://` resource (mime `text/html+skybridge`), and
every UI-linked tool MUST carry a `_meta` from one **canonical tool-meta builder** that emits **both**
surfaces:

```ts
// MCP-Apps (Claude):        ui: { resourceUri }
// ChatGPT (skybridge):      "openai/outputTemplate": <ui:// uri>,   // == the resource URI
//                           "openai/widgetAccessible": true,        // authorizes window.openai.callTool
//                           "openai/toolInvocation": { invoking, invoked }
```

Without `openai/widgetAccessible: true` the widget renders but in-widget callbacks (steppers, Checkout)
silently no-op in ChatGPT. Widget-rendering tool results MUST carry **cart-bearing `structuredContent`**
(e.g. `checkout` includes `products`/`cart`) so a fresh ChatGPT widget instance doesn't render an empty
cart. The widget CSP MUST allow `data:` (the image placeholder). Runtime host detection (`chatgpt`/`mcp`/
`standalone`) preserved.

## Contract tests (MUST exist)

1. **Tools registered:** `mcpServer()` exposes exactly the nine tools above (in-memory transport).
2. **Checkout — ungated:** no gate injected ⇒ `checkout` returns `{ orderId, checkoutUrl }`, no `requires`.
3. **Checkout — gated (composition):** with a gate injected, an age-restricted cart ⇒ `requires` carries the
   `age` gate (`minAge`), payment last; a non-restricted cart ⇒ no `age` entry. (Drives real `Attesto` —
   the `storefront-gate.test.ts` composition test, updated to the extracted storefront.)
4. **Zero glue:** the priced `Order` is accepted by `attesto.requirements(order, policy)` directly — no
   `toGateOrder` mapping (the line carries `minimumAge`).
5. **UI resource present:** the `ui://` resource is registered and the **six** UI-linked tools carry the
   tool-meta; the **three** plain tools (`get-product-details`/`get-product-reviews`/`get-order-status`) do not.
6. **State per order/session:** two carts / two orders do not bleed into each other (no process-global
   state); `get-order-status` reflects only the queried order.
7. **Demo parity:** the demo, refactored to consume the package, passes the existing suite unchanged
   (currently 242 / 1 skip) — the nine tools behave identically (regression gate).
8. **Build:** `npm run build` produces the package's TS output **and** the single-file widget bundle, in
   workspace order, and stays Vercel-safe (green = deploy-safe).
9. **ChatGPT widget meta (FR-014):** every UI-linked tool's `_meta` (via `tools/list`) carries
   `openai/outputTemplate` (== the `ui://` resource URI) **and** `openai/widgetAccessible: true` (+ the
   `openai/toolInvocation` status); the `checkout` result's `structuredContent` carries `products`/`cart`.
   (Live ChatGPT interactivity — steppers/Checkout actually invoke — is manual: tasks T031.)

## Publish-readiness (FR-013)

`package.json` MUST expose `exports` (`.` + `./server`), `files` (ships `dist` incl. the `ui/` bundle),
`types`, and `publishConfig: { access: public }`, so `npm install @openmobilehub/attesto-storefront` works
in a non-clone project. (`npm publish` + scope reservation is a release action, out of code scope.)
