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

### Changed

- An `age.over(n)` in the policy now sets the age the order must prove, together with any
  `minimumAge` on its items; the stricter wins (#354). What this changes for you:
  - With the documented quickstart policy (`age.over(21)` when any line has a `minimumAge`), an
    item tagged 18+ now asks for 21+.
  - A policy stricter than the tags (25+ on wine tagged 21) now asks for 25+.
  - An 18+ policy on untagged items asks for 18+, not the old default of 21.
- **BREAKING:** `age.over()` throws unless the age is a whole number above 0. In 0.6.0 and earlier
  a policy's age decided nothing at completion, so a bad value went unnoticed. Now that it is
  enforced, a value it can't check would switch the check off, so it is refused when the policy is
  built: at startup for a policy built once, at the first checkout for one built per order (as in
  the quickstart). What breaks on upgrade: a string, such as `age.over(process.env.MIN_AGE)` with
  `MIN_AGE=21` (it worked in 0.6.0; wrap it in `Number()`), and a fraction, 0, a negative number or
  NaN (#354).
- `VerificationRecord` gains `ageVerifiedOver`, the age a proof was made at. Completion refuses a
  proof made below the order's age, so a 21+ proof can't complete a 25+ order. A record written
  before this counts as proven at the item's age, or 21 (#354).

### Fixed

- An age gate asks the wallet for the order's own age (`age_over_25` for 25+, `age_over_16` for
  16+). Before, the iPhone request (ISO mdoc) asked only for 18 or 21, and every request asked an
  age under 18 for 18 alone, so those ages could never be proven. A wallet now proves them when
  its credential holds that claim (#354).
- The payment, passkey, credential and outside-verifier pages' progress bar shows the Age step
  for an age that only the policy asks for (an item with no `minimumAge`), and ticks it only when
  the proof on record is old enough for the order. Before, such an order's progress bar showed
  only Pay (#414).

### Security

- An age check written only in the policy is enforced. Before, `age.over(21)` on an item with no
  `minimumAge` (a health record, an access grant) completed with no age proof at all (#354).

### Known issues

- A server keeps one registered `age`, the last one resolved:
  - An order the server no longer remembers (after 10,000 newer orders, a restart, or on another
    instance) is held to that age. Where the server's age rules differ in age or in `.when()`,
    that can be lower than the order's own policy, or no age check at all; with no `age`
    registered, none at all. Tag age-restricted items with `minimumAge` at the policy's age (a
    tag always holds, but only at its own age), or use `orders.serve` with a shared store (#411).
  - The outside verifier's page asks the wallet for that age. For an order the server remembers,
    completion still refuses a proof below the order's own age, so a person can be stuck, not let
    through (#359).

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
