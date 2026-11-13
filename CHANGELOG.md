# Changelog

What changed in each release of the two npm packages built from this repo:

- **`@openmobilehub/credentagent-gate`** — the Gate (`new CredentAgent()`, `credentagent.mount(app)`).
- **`@openmobilehub/credentagent-storefront`** — the reference storefront (`createStorefront()`).

Both packages version in lockstep, so one entry covers both. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a **minor**
bump (0.4 → 0.5) is the signal for a breaking change; a patch bump never breaks.

Entries marked **BREAKING** need a change in your code when you upgrade. They are called out
especially for the policy DSL (`age` / `membership` / `payment` / `defineCredential`), the
`requires` manifest, and `trust_level`.

**Honesty note, for every release below.** `trust_level: "presence-only-demo"` means the
OpenID4VP rails check that the wallet *disclosed* the right claim and that the answer is *bound*
to this order (nonce, ephemeral key) — but they do **not** check who issued the credential. A
self-crafted mdoc would pass. Issuer-verified trust built into the gate has **not shipped** in any
version here. From 0.4.0 on, the gate can relay the verdict of an external verifier you plug in
(the delegated verifier); before 0.4.0 nothing in the packages could produce `issuer-verified`.

**npm can lag `main`.** `[Unreleased]` lists what is merged but not yet in a release. Check what
npm actually serves with `npm view @openmobilehub/credentagent-gate version`.

## [Unreleased]

### Added

- Agent-signed purchases, opt-in: `new CredentAgent({ agents: { trust: "presence-only-demo" } })` makes
  `grants.serve(app)` also serve the store's side of a purchase by an agent that holds its own key — the
  permission, a quote, and a proof route (`/credentagent/grants/:id/delegation`, `/purchases`,
  `/purchases/:nonce/proof`). The gate prices from your catalog, keeps the budget on the grant, consumes the
  one-time code, and finishes the order through the shared completion path (`order.settled`, webhooks,
  `orders.retrieve`). A retry of the same proof gets the same receipt back (`replayed: true`). Without
  `agents`, nothing changes. The signatures are real; nothing proves who issued the credential (#14) (#263).
- Each order's requirements are now saved with its proofs, in the order's verification record
  (`record.requirements`), so a server that never ran `requirements()` can read what the order
  needs. `requirements()` seals them into every mounted approve link (a new `requirements=` query
  parameter, signed with the rails' signing key and bound to the order id, which makes each link
  about 150–250 characters longer). The first credential, dc-payment or delegated page opened from
  such a link saves them, once. Links a host builds by hand, such as the Pay buttons on the
  `orders.serve()` checkout page and the storefront's, carry no seal yet, so those orders save
  nothing (#446). An age requirement holds one number: the stricter of the policy's
  `age.over(n)` and the order's highest `minimumAge` tag. An age proof now also saves the age it
  was made at (`provenOver`). Nothing reads either yet, so no order completes or is refused
  differently (#444, the first step of #442).
- `VerificationStore` has an optional `writePart(orderId, slot, part)`, which saves one proof
  without rewriting the rest of the record, so two proofs saved for one order at the same moment
  no longer overwrite each other. The exception is a custom requirement's proof that the order's
  saved requirements don't name (an order opened from a link without a seal has none saved): the
  gate still merges that one into the record, as before, so two of those saved at once can still
  collide, and the buyer proves again. The in-memory store and `redisStorage()` implement it;
  Redis keeps each part under a key of its own. A store without `writePart` works as before, and `doctor()` warns about it on a
  deployment (`verification-store-merges-parts`). `mergeVerificationRecord` and
  `verificationSlots` are exported for stores that add it.
- `REVOKE_TOOL_META` (`"credentagent/revokeTool"`) from `@openmobilehub/credentagent-gate/cards`: the
  `_meta` key under which a grant tool result names the server's Revoke tool. The card kit's page
  draws a Revoke button only when the result names one, so a server that builds the result by hand
  imports this rather than typing the string. The page ships in the package, but nothing serves it
  yet (#434).

### Changed

- The spending-grant card's trust line no longer says "not wallet-signed" for every grant. A grant still
  waiting for approval (or declined) says "not approved"; a grant the store reports as signed on the
  person's phone says so, attributed to the store ("as the store reports it"), and that the card did not
  check the signature or the credential's issuer. An unknown or missing level says "not recognised". A list
  of grants shows one line per distinct sentence. The grant's own page, after the wallet signs or the
  grant is declined, no longer says approving there "stands in for the wallet ceremony". The agent note on a pending spending grant
  now asks for a short reply only when the human already sees the card (#429).
- The storefront widget's pending spending-grant card shows Approve and Decline only when the
  approval link is an `https:` address, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. Otherwise
  it says "The merchant's link isn't a safe web address, so this card doesn't show it." The link is
  built from the gate's `walletOrigin`, so a wallet origin on plain `http:` anywhere else (a LAN
  address, a `.local` name, a `*.localhost` subdomain) no longer gets the buttons: serve it over
  `https:` or use `localhost` (#434).

### Fixed

- Creating a spending grant from claude.ai no longer hangs with a product grid where the grant card
  should be. Three causes, fixed together:
  - On a client that can ask the person questions itself (MCP 2026-07-28 with `elicitation`, which
    claude.ai's connectors now are), `create-spending-grant` asked for the approval in a form. The
    call stayed open behind it, so the host got no result to draw the card from, the approve link
    was text inside the form, and the client retried the form up to 10 times, each one holding
    `approvalHoldMs` (45 s). The pending grant is now the tool's result on every client; only the
    product questions (size, colour) still use `input_required`.
  - The storefront widget fell back to the product picker whenever a grant tool's answer carried no
    grant (questions, a refusal) or had not arrived within two seconds. A widget a grant tool opened
    now shows a one-line notice instead, with "Show products" as the way to the picker.
  - A client re-sends the last request-level `requestState` by itself. One left over from an
    unfinished flow, past its 15 minutes, got the next call refused as `expired` although the agent
    had sent none. It is now dropped and the call starts over, believing nothing from it. Still
    refused: a forged or edited state, a fresh one minted for another call or session, and a lapsed
    one passed as the tool's own argument.
- The storefront widget no longer flashes the product grid before a spending-grant card. It now
  shows nothing until the tool result that opened it arrives, then the card for that result; a host
  that never sends one still gets the product picker after two seconds, or the notice above when a
  grant tool opened the widget (#428).
- Paying with a current Multipaz wallet no longer fails with "this wallet signed no
  transaction_data_hash … (update the wallet app)". Multipaz renamed the signed amount fields to
  `transactionDataHash` / `transactionDataHashAlg` in August 2026, and the gate only read the old
  names. It now reads both, and still refuses a missing or mismatched hash.

## [0.6.0] - 2026-10-19

### Added

- AP2 delegation end to end: an agent spends a phone-signed spending permission with its own
  key, and a merchant can verify it (#195, #235). The phone now signs the Agent Payments
  Protocol's own Mandate Content rather than a format this project invented, and the optional
  `grant.mandate.mandates` holds what it signed (#189).
- `@openmobilehub/credentagent-gate/cards` — the grant card's data contract (`GRANT_VIEW_KIND`,
  `GrantViewData`, `GrantViewProduct`), the first slice of the card kit. The card components
  themselves are not exported yet (#258).
- `inspectPresentations` — links each wallet answer to Multipaz Tools so you can inspect it (#223),
  and an order proof receipt that keeps each proof with its order (#224, #225).
- The store's checkout and consent pages can be served under a path prefix (#228).
- `/version` and the real MCP server version, so you can see which version a store runs (#210).
- An identity-only delegated gate: the external verifier checks age and nobody pays (#160).
- A `CHANGELOG.md` (this file), checked before every publish (#376).

### Changed

- **BREAKING:** a grant's `mandate.credentialDoctype` is now **`mandate.credentialType`**. It holds
  an SD-JWT VC type (`vct`), not an ISO-mdoc doctype. Rename the field wherever you read it (#189).
- **BREAKING:** `buildIntentSignRequest` and `verifyIntentPresentation` (the phone-signing
  functions) now **require** `merchantUrl`: the store's public address with its path
  (`https://shop.example/coffee`), as an absolute http(s) URL. A missing or invalid one makes the
  request throw and the verify refuse. With it, a spending permission for one store no longer works
  at another store on the same host (#334).
  **Migration:** a store served under a path now reports a merchant id (`ap2.merchant.id`) that
  includes the path, so grants whose key the agent holds (`grants.create({ agentKey })`) signed
  before this change are refused there. Create a new grant and have the person sign it (an
  authorized grant can't be re-signed). A store at the root of the same host keeps accepting the old
  ones until they expire. Each deployment needs its own `walletOrigin`.
- **BREAKING:** `buildIntentSignRequest` and `verifyIntentPresentation` also require `delegate`,
  `mandateExp` and `allowedSkus` (#189, #195).
- **BREAKING:** a custom `IntentVerifyBackend` receives `{ sdjwt, audience, nonce }` instead of
  `{ deviceResponseB64url, sessionTranscript }`, and must return `delegatePayload` (the key-binding
  JWT's `delegate_payload`, verbatim). The type marks it optional, but without it every verify fails
  with "mandate mismatch". In its result, `IntentVerifyResult.credentialDoctype` and
  `IntentTrustVerdict.docType` are now `credentialType`, and `SimulateOptions.overrideDocType` is
  now `overrideVct` (#189, #195).
- **BREAKING:** phone signing (`signing: "device"`, the default for grants) now asks the wallet for
  an **SD-JWT** payment credential (`vct` `urn:emvco:dpc:card:1` or `com.emvco.dpc`) instead of the
  mdoc `org.multipaz.payment.sca.1`. A wallet set up for 0.5.0 can't sign a grant until it holds one
  (`tools/demo-pki/mint/mint-dpc-sdjwt.mjs --mpzpass` mints a demo one). No released wallet supports
  AP2's `delegate` request yet; test with `devSimulateWalletSignature` (#189, #195).
- **BREAKING (boot check):** on a deployment, `doctor()` reports a missing `mandateSigningKey` as an
  **error** (`ephemeral-mandate-key`), so a host that exits when `doctor()` isn't ok won't start until
  it passes one, even if it never mints a mandate. Whether this should be a warning is open (#361).
  A missing `checkoutSigningKey` is a warning (#195, #235).
- The package READMEs were brought in line with what the next release ships (#329, #310).

### Removed

- **BREAKING (storefront):** the `@openmobilehub/credentagent-storefront/firestore` entry point.
  It was declared in every published version (0.2.0–0.5.0) but never built, so importing it always
  failed with "Cannot find module". The `CatalogSource` option stays; the README shows how to write
  one over your own database (#314).

### Fixed

- A store served under a path publishes its signing key where clients look for it (#347).
- The product-picker widget's MCP Apps policy (`_meta.ui.csp`) no longer lists the bare `data:`
  scheme, and the ChatGPT copy now declares that policy too, so MCP Apps hosts get the same one.
  ChatGPT's own `openai/widgetCSP` still lists `data:`, so product images keep rendering there (#385).
- The storefront empties the cart when the order completes on another instance (#227), keeps the
  picker on one cart (#211), and refuses MCP listen streams that only burn serverless time (#215).

### Security

- An agent can no longer lower an order total by adding a line with a negative quantity (#346).
  The same fix refuses a fractional quantity (half a coffee at half price) in `grant.spend`, which
  0.3.0 to 0.5.0 accept if your code passes the agent's quantity through unchecked.
- Consent pages no longer run script taken from a crafted checkout link (#332). **This affects
  every published version from 0.2.0 to 0.5.0 (storefront 0.2.1 too): upgrade.** It came in with
  stateless carts (#32). Below 1.0 a caret range (`^0.5.0`) never moves you to the next minor
  version on its own.
- A completed order's status no longer returns the shopper's raw wallet answer (#327). The
  option that kept it (`inspectPresentations`) is new since 0.5.0, so no published version has this.

### Known issues

- Two deployments that share one `walletOrigin` and one checkout signing key accept each other's
  price quotes. Give each store its own `checkoutSigningKey` (#335).
- A store's price quote never expires, so an agent can keep an old quote and spend it later; a
  changed price is still refused (#249).
- The gate's built-in pages accept a typed-in claim such as "over 21" with no wallet, and there's no
  switch to turn this off, even on a server that uses an outside verifier (#352). Also in 0.5.0.
- The full list of open bugs that ship in 0.6.0 is in the
  [v0.6.0 release notes](https://github.com/openmobilehub/credentagent/releases/tag/v0.6.0).

## [0.5.0] - 2026-09-26

### Added

- Device-signed spending grants: the wallet signs the grant's exact bounds before anything can be
  spent, and such grants carry the new `trust_level: "device-signed"` (#148). The signature is
  verified; the trust **anchor** is still a self-minted demo credential, so this is not
  `issuer-verified`.
- Grant widgets: a visual card for a grant, and grants that survive a restart (#151). The human
  can name the exact product before a spending-grant link is created (#175), and is told what a
  grant can't buy before authorizing it (#173).
- `list-products` and batch product lookups in the storefront (#190).
- `redisStorage.fromEnv()` — storefront storage from standard deployment environment variables
  (#128).

### Changed

- **BREAKING:** `grants.create()` now defaults to `signing: "device"`. A caller that relied on the
  old click-to-approve default must pass `signing: "page"` (#148).
- The storefront works on the July 2026 MCP protocol version that claude.ai now uses (#201).

### Fixed

- A refused order tells the buyer why it was refused (#193); a failed amount-binding hash check
  says why it failed (#181).
- The dc-payment rail honors the hash algorithm the wallet uses for `transaction_data` (#147).
- The hosted gate pages are presentable, and their docs match what they do (#179).

### Security

- A place-order for an order the server never found is refused instead of falling through (#185).

## [0.4.0] - 2026-07-29

### Added

- `credentagent.doctor()` — a one-call configuration preflight (#134).
- `defineHost()` — the typed contract for bringing your own host (#136).
- `CredentAgent({ branding })` — brand the ceremony pages with one option (#132).
- Real delegated payments: an external checker verifies and settles, while the gate re-derives the
  amount and payee and re-runs your policy first (#103).
- On the iOS / ISO-mdoc path, the stable reader identity is presented too (#133).

### Changed

- **BREAKING:** the `DelegatedVerifier` contract published in 0.3.x. `consume()` no longer settles;
  settlement moves to a new `settle()` that the gate calls only after its own checks pass.
  `DelegatedVerdict.settlement` is removed, and `binding.payee` is now required (#103; issue #161).

### Fixed

- Custom credential effects no longer fail open, deadlock, or do nothing (#131).
- Every `dcql()` credential gets a unique id (#127).
- Concurrent spends against the same grant are serialized, and grants price in integer cents (#135).
- The checkout receipt says truthfully how payment settled (#130).
- The storefront fails fast when the widget bundle is missing (#129), and the widget's Checkout
  button is reachable on a phone (#109).

## [0.3.1] - 2026-07-26

### Added

- Storefront: `createStorefront({ grants, merchant })` puts the spending-grant tools on the MCP
  server, so an agent can use a grant from any MCP client (#118).

### Fixed

- `browse-products` includes product ids in its text, so an agent with no widget can add items to
  the cart instead of getting stuck (#121).

## [0.3.0] - 2026-07-25

### Added

- `credentagent.orders.*` and `orders.serve(app)` — the human-present checkout, wired in one call
  (#98).
- `credentagent.webhooks` — a signed HTTP `order.settled` event, plus `constructEvent` to verify it
  (#102).
- `credentagent.grants.*` and `grants.serve(app)` — approve once, and the agent spends within the
  bounds while you are away (#112). These grants are labelled `delegated-demo` /
  `server-issued-demo`: the server takes the human's word for the approval.
- The `DelegatedVerifier` seam and the delegated-payment request rail (#91).
- A stable reader identity in the OpenID4VP request, so a wallet that trusts it doesn't warn about
  an unknown verifier (#84). This is the wallet trusting the verifier; it does not verify the
  credential, so `trust_level` stays `presence-only-demo`.
- A demo PKI toolkit for trust roots and test credentials (#100).
- The checkout page reflects intermediate ceremony steps from another device (#76) and polls the
  order status, so an open tab shows completion (#66).
- Storefront `statelessMcp` option for multi-instance serverless hosts (first shipped as
  storefront 0.2.1, published to npm on 2026-07-13 with no tag) (#56).

### Changed

- **BREAKING:** a policy the checkout can't enforce now throws when you build it.
  `optional(gate())` and `optional(payment)` throw, because an optional gate would be shown but
  never enforced. `required(discount())` throws, because a discount can't block completion. Every
  other combination (required gates, optional discounts) is unchanged (#42).
- `OrderDoor.code` is typed as a union of known codes, not a plain string (#111).

### Fixed

- The age request accepts an mDL **or** an EU PID, not both (#77).
- The checkout stepper shows only the ceremony steps the order actually needs (#62, #74).

## [0.2.0] - 2026-07-08

The first release under the name `@openmobilehub/credentagent-*`, and the first on npm under it
(tag `v0.2.0-credentagent`). The storefront also published 0.2.1 on 2026-07-13 (untagged) with the
`statelessMcp` option listed under 0.3.0.

### Changed

- **BREAKING:** the packages were renamed from `@openmobilehub/attestomcp-*` to
  `@openmobilehub/credentagent-*`, the class `AttestoMCP` to `CredentAgent`, and the ceremony
  routes from `/attestomcp/*` to `/credentagent/*` (#38).

### Added

- Storefront: Redis persistence (`createStorefront({ storage })`, #33), a dynamic catalog
  (`createStorefront({ catalog })`, #36), per-session carts (#35), and stateless orders carried in
  a signed Cart Mandate (#32).

## Before the rename: `@openmobilehub/attestomcp-*`

These versions were published under the earlier package names, which are no longer updated.

### attestomcp 0.2.0 — 2026-07-01 (tag `v0.2.0`)

- **BREAKING:** the exported class `AttestoMcp` is now `AttestoMCP`, and `AttestoMcpOptions` is
  now `AttestoMCPOptions`. Package names, routes and instance variables are unchanged (#30).

### attestomcp 0.1.0 — 2026-06-28 (tags `v0.1.0`, `v0.1.0-attestomcp`)

First release, under the name `@openmobilehub/attesto-*` (renamed to `attestomcp-*` the next day,
#8). It included:

- The Gate: the client, `requirements()` — which runs `.when()` server-side and emits the
  JSON-safe `requires` manifest — and the `age` / `membership` / `payment` / `defineCredential`
  policy builders.
- `mount(app)` and its ceremony rails: passkey (WebAuthn, same-device and cross-device), credential
  (age and membership over OpenID4VP), and dc-payment (Digital Credentials API, amount-bound).
  The OpenID4VP rails are `presence-only-demo`.
- A signed Cart Mandate (`ap2.CartMandate`), reconciled with the payment mandate so the amount
  agrees across every payment path (#1, #6).
- The storefront: `createStorefront()`, a runnable catalog-injected MCP shopping server, and the
  pure pricing / order model.

[Unreleased]: https://github.com/openmobilehub/credentagent/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/openmobilehub/credentagent/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/openmobilehub/credentagent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/openmobilehub/credentagent/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/openmobilehub/credentagent/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/openmobilehub/credentagent/compare/v0.2.0-credentagent...v0.3.0
[0.2.0]: https://github.com/openmobilehub/credentagent/compare/v0.2.0...v0.2.0-credentagent
