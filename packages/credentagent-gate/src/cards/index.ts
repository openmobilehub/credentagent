// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT. This first slice is the grant card's data contract, moved here from
// the storefront so the kit, the storefront and an agent server all speak the same one.
export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
