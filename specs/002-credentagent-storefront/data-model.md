# Phase 1 — Data Model: Attesto Storefront (002)

Entities the storefront package models. Most already exist (the pricing slice from 001 + the demo's tool
shapes); 002 is mostly **moving** them into the package and adding the `createStorefront` handle. The gate's
manifest shape (`requires`) is owned by `@openmobilehub/attesto-gate` (001) and only flows through here.

## Storefront (the `createStorefront` handle)

The one-line unit an adopter composes with `Attesto`.

| Field | Type | Notes |
|-------|------|-------|
| `app` | `Express` | The mount target — pass to `attesto.mount(app)`; the ceremony routes attach here. |
| `mcpServer()` | `() => McpServer` | Build a fresh MCP server (the HTTP `/mcp` route uses it per request; tests use the in-memory transport). |
| `gate(resolve)` | `(GateResolver) => void` | Inject the credential gate; `checkout` then surfaces its `requires`. |
| `listen(port?)` | `(number?) => Promise<{ url, port }>` | Start the HTTP server; returns the `/mcp` connector URL. |
| `catalog` | `Product[]` | The resolved catalog (injected or `SAMPLE_CATALOG`). |

### StorefrontOptions

| Field | Type | Notes |
|-------|------|-------|
| `catalog?` | `Product[]` | Products to sell; default `SAMPLE_CATALOG`. |
| `baseUrl?` | `string` | Origin checkout links resolve from; default `http://localhost:<port>`. |
| `reviews?` | `Record<string, Review[]>` | Optional per-product reviews backing `get-product-reviews`. |

## GateResolver (the seam Attesto mounts on)

`(order: Order) => VerificationManifestEntry[] | undefined` — given a priced order, return the gate's
`requires` manifest, or `undefined`/empty for an un-gated storefront. Functions never cross the wire; the
resolver runs server-side in the `checkout` handler. The manifest type is the gate's (001 contract).

## Product / Catalog (injected — own-the-code)

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Product id. |
| `name` | `string` | |
| `price` | `number` | Catalog price. |
| `currency` | `string` | ISO 4217. |
| `image` | `string` | Thumbnail URL (the widget renders it). |
| `category` | `string` | e.g. `"Beverages"`. |
| `description` | `string` | |
| `minimumAge?` | `number` | Age threshold (21 for alcohol); re-derived onto priced lines (the seam). |

### Review (backs `get-product-reviews`)

| Field | Type | Notes |
|-------|------|-------|
| `author` | `string` | |
| `rating` | `number` | 1–5. |
| `text` | `string` | |

## Cart / PricedCart / Order

Unchanged from the pricing slice (001), now owned + served by the package.

- **CartItemInput**: `{ productId, quantity }`.
- **PricedCartLine**: `{ id, name, unitPrice, currency, quantity, lineTotal, minimumAge?, category? }` —
  carries `minimumAge`/`category` so a priced `Order` feeds `attesto.requirements()` with **zero glue**.
- **PricedCart**: `{ lines, itemCount, subtotal, discount, total, currency, unknownIds, hasAgeRestricted,
  ageVerified, loyaltyApplied }`.
- **Order**: `{ id, lines, itemCount, subtotal, discount, total, currency, createdAt }` — stateless (encoded
  in the checkout token).

## State (owned by the storefront, per session/order)

| Store | Key | Notes |
|-------|-----|-------|
| `cartStore` | session | The working cart; in-memory default, pluggable. |
| `orderStore` | `order.id` | Completed-order records (for `get-order-status`). |
| *(verification)* | — | **NOT** the storefront's — read through the mounted Attesto store (`app.locals.attesto.store`); per order id; set by the gate's ceremony. |

**Security invariant 4**: every store keyed per session/order — never process-global.

## The nine MCP tools (Context 1)

| Tool | Input | Result (structuredContent) |
|------|-------|----------------------------|
| `browse-products` | — | `{ products }` (+ UI grid) |
| `get-product-details` | `{ productId }` | `{ product }` |
| `get-product-reviews` | `{ productId }` | `{ reviews }` |
| `add-to-cart` | `{ productId, quantity }` | `{ cart }` |
| `set-quantity` | `{ productId, quantity }` | `{ cart }` |
| `remove-from-cart` | `{ productId }` | `{ cart }` |
| `get-cart` | — | `{ cart }` |
| `checkout` | `{ items? }` | `{ orderId, checkoutUrl, requires? }` (Mode A; `requires` when gated) |
| `get-order-status` | `{ orderId }` | `{ orderId, status, order? }` |

**Six** are UI-linked (`registerAppTool` + the tool-meta → the widget: `browse-products`, `add-to-cart`,
`set-quantity`, `remove-from-cart`, `get-cart`, `checkout`); **three** are plain (`registerTool`, no widget:
`get-product-details`, `get-product-reviews`, `get-order-status`) — preserving the demo's split. All results
are serializable (Principle VI).

## Widget bundle (the `ui://` resource)

The single-file `mcp-app.html` the package builds (vite + single-file) and registers as the `ui://` UI
resource. Runtime host detection (`chatgpt` | `mcp` | `standalone`) preserved. Renders in MCP-Apps-capable
hosts; a no-GUI host falls back to the tool's text/structured result.

## Relationships

```
createStorefront(opts) ─▶ { app, mcpServer(), gate, listen, catalog }
   app ──attesto.mount──▶ app.locals.attesto.store (verification, the gate's)
   app ──demo registers──▶ /credential-gate, /passkey, /dc-payment (ceremony; 003 → mount())
   mcpServer() registers ─▶ 9 tools (UI-linked) + the ui:// widget resource
   checkout tool ──gate(order)──▶ requires manifest   (the seam; gate's data)
```
