# Contract — Quickstart Public Surface (007)

The externally observable surface of `examples/quickstart`. The smoke (FR-006) is the executable
form of this contract; a change that breaks a row is a breaking change to the demo.

## Endpoints

| Route | Protocol | Contract |
| :-- | :-- | :-- |
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC) | `initialize` succeeds; tools include `browse-products`, `checkout`, `get-order-status`. `checkout` returns `structuredContent` carrying the order + `requires` manifest + checkout link. No auth (hosted rung must stay ChatGPT/Goose-compatible). |
| `GET /checkout?...` (link minted by the tool) | HTML | The ceremony page wired by `credentagent.mount()`; completes age → membership → payment in one session (Constitution III). |
| `/credentagent/*` | mount() rails | Passkey / credential / dc-payment ceremony routes + completion poll — unchanged from the published gate. |
| `POST` completion path (`place-order` equivalent) | JSON | **403 / refusal when the order's required verifications are absent** (smoke d). Tampered cart mandate → refusal (smoke e). |

## Smoke assertions (FR-006 → executable)

| # | Assertion | Fails when |
| :-- | :-- | :-- |
| a | MCP `initialize` handshake completes | endpoint down / transport broken |
| b | whiskey checkout → `requires` contains `age` (`required: true`, `minAge: 21`) | policy or `.when()` predicate broken |
| c | headphones checkout → no `age` entry | predicate stuck-on (over-gating) |
| d | unverified completion POST → 403/refused | server-side enforcement removed (Security Req. 1) |
| e | tampered cart mandate → refused | signature check removed (Security Req. 2 / spec 004) |

Runs three ways with the same script: CI (`npm run smoke`), local dev, and `SMOKE_URL=<prod>` for
the FR-009.2 cutover gate.

## Deploy Button URL (rung 3)

```
https://vercel.com/new/clone
  ?repository-url=https://github.com/openmobilehub/credentagent
  &root-directory=examples/quickstart
  &project-name=credentagent-demo
  &repository-name=credentagent-demo
  &env=GATE_SECRET
  &envDescription=Signing%20key%20shared%20by%20all%20instances%20—%20generate%20with%3A%20openssl%20rand%20-hex%2032
  &envLink=https://github.com/openmobilehub/credentagent/tree/main/examples/quickstart#own-it
```

(Members joined without whitespace in the README; `root-directory` per
vercel.com/docs/deploy-button/build-settings.)

## README copy constraints (FR-007 + Constitution VII)

- Three rungs with time budgets; connect instructions for Claude (custom connector), Claude Code
  (`claude mcp add --transport http shop <url>`), ChatGPT, Goose (Streamable HTTP extension).
- The whiskey-vs-headphones script verbatim, so SC-004 is observable in-conversation.
- **Honesty fencing (binding)**: state that ceremonies are `trust_level: "presence-only-demo"` —
  real wire crypto, no issuer/device trust anchor yet; the age gate is a flow demonstration, not
  a safety control.
- "Going further" links: `custom-credential.mjs`, `storefront-redis.mjs` (+ tunnel = phone tier),
  `with-x402-settlement.mjs`.
