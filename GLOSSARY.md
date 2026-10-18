# CredentAgent

The consent layer for AI agents: before an agent completes a consequential action, the
user proves a verifiable credential from their phone wallet. Identity leads; payment is
one credential among others.

This file is domain language only: what each word means and which word to use. How things
are built lives in [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/reference/](docs/reference/).
An entry ending in _(proposed)_ is a draft choice awaiting the maintainer: the marker
covers the whole entry, its _Avoid_ list included. See
[Flagged ambiguities](#flagged-ambiguities).

_Avoid_ lists govern prose, docs and UI copy. Exported API names (`VerificationStore`,
`DelegatedGate`, the `gate()` effect, a `verified` wire field) keep their names until a
deliberate API change renames them.

## Language

### Parties

**Agent**:
The AI that acts on the user's behalf. It asks for a checkout, hands the user a link, and
learns the result; it never performs a ceremony.
_Avoid_: bot, assistant, client

**User**:
The human whose consent is being proven. Use **buyer** only inside a purchase flow.
_Avoid_: person, principal, subject (except in the protocol term "subject binding"),
cardholder, customer _(proposed)_

**Holder**:
The protocol role of whoever controls a credential's key and presents it. Usually the
user's wallet; in a human-not-present spend, the agent's key can be the holder of the
closed mandate.
_Avoid_: using it as a synonym for **User**

**Wallet**:
The app on the user's phone that holds credentials and answers presentation requests.

**Issuer**:
The party that issued a credential and vouches for its claims. The gate does not yet
check issuers itself.
_Avoid_: using it for the gate minting mandates (say "the gate signs")

**Merchant**:
The seller whose action is being gated, and the payee a payment is bound to.
_Avoid_: store (except in **Storefront** and **Store DID document**), vendor

**Host**:
The server application a developer mounts the gate on. The **Storefront** is one host.
_Avoid_: "MCP host" for Claude/ChatGPT; call those the **MCP client** _(proposed)_

**MCP client**:
The chat application (Claude, ChatGPT, Goose) the agent runs in and that renders tool
results and widgets.
_Avoid_: MCP host, harness

### The product

**Gate**:
The CredentAgent library itself: the policy language plus the ceremony rails it serves.
_Avoid_: using bare "gate" for one check (say **Requirement**) or a mandate step (say
**Mandate check**) _(proposed)_

**Storefront**:
The ready-made reference host: a runnable agentic shopping server with a catalog, a cart,
and a checkout page.

**Catalog**:
The merchant's products and prices, and the sole source of truth for every amount.

**Seam**:
A dependency the host supplies to the gate (where to store state, how to complete an
order, which keys to sign with) so the gate holds no policy of its own about them.
_Avoid_: hook, plugin

### Policy

**Credential**:
A kind of thing the user can prove (an age over N, a membership, a payment method), along
with how to ask for it, how to check it, and what proving it does.

**Policy**:
The ordered list of requirements a host attaches to an action.
_Avoid_: rules, config

**Requirement**:
One entry in a policy: a credential, whether it is required or optional, and when it
applies.
_Avoid_: step (code name), gate, check _(proposed)_

**Effect**:
What satisfying a credential does: **block** the action until proven, **discount** the
price, or **authorize** payment. Payment always settles last.

**Explicit positive claim**:
A disclosed claim that affirmatively meets the requirement (`age_over_21 === true` at
the order's own threshold), as opposed to a token merely being present.
_Avoid_: valid token, verified presence

**Requires manifest**:
The flat, serializable list of requirements the checkout page will demand, handed to the
agent before any proof happens. Awareness, not enforcement.
_Avoid_: requirements list, verification manifest

### Flow

**Execution contexts**:
The three places a gated flow runs, which must never be conflated: the **tool** (mint the
link, report the manifest), the **page** (run every ceremony), and the **poll** (the agent
learns the outcome). "Mint in 1, prove in 2, report in 3."

**Ceremony**:
One live, phone-in-the-loop proof run on the page: a passkey assertion or a wallet
presentation.
_Avoid_: verification flow, handshake

**Rail**:
A self-contained kind of ceremony the gate serves. At checkout: **passkey**, **credential**
(age, membership, custom), **dc-payment** (amount-bound wallet payment), and the opt-in
**delegated verifier** rail. For a **Spending grant**, the wallet signing ceremonies
(**intent-sign**, **grant-credential**).
_Avoid_: "credential-gate" for the credential rail _(proposed)_

**Presentation**:
What a wallet sends back in answer to a request: the disclosed claims plus their binding.

**Proof**:
A presentation the gate accepted for a given order, recorded with the rail, the checks it
passed, and its trust level.
_Avoid_: verification (as a noun), approval

**Instant demo**:
A tap-to-continue path for demos and CI that stands in for a ceremony. It proves nothing.

### Orders and money

**Cart**:
The agent's working selection of products and quantities before checkout. Mutable.

**Order**:
A priced, id-stable unit of purchase created from a cart at checkout. Its amounts are
re-derived from the catalog every time they matter.
_Avoid_: purchase, transaction

**Order token**:
The order as carried in a link. Unsigned and hand-editable, so never trusted for amounts
or flags.

**Checkout**:
The act of turning a cart into a completed order: the checkout link, the checkout page,
and every ceremony on it.

**Completion path**:
Any route by which an order can become completed. Every requirement is enforced on every
completion path, server-side.
_Avoid_: submit, place-order button

**Amount binding**:
The guarantee that the line sum, the order total, and the amount the user signed for are
the same number, paid to the same payee.

**Settlement**:
The optional step that actually moves money once every requirement has passed. A failed
settlement fails the order.

### Trust and honesty

**Trust level**:
How far the checks behind a proof justify trusting it, carried on each **Proof** and each
**Requires manifest** entry (`trust_level`). From weakest to strongest: **presence-only
demo**, **device-signed**, **issuer-verified**. A click-approved **Spending grant** carries
a weaker label, **server-issued demo**, outside this type.

**Disclosure**:
The wallet revealed the explicit positive claim asked for.

**Binding**:
The response belongs to this request, this origin and this moment (nonce, ephemeral key,
RP-ID), so it cannot be replayed elsewhere.

**Trust** (property):
The claim chains back to a genuine issuer and device. The one property the built-in rails
do not yet have.

**Server-issued demo**:
The server takes the user's click as consent. No credential is involved. Today a label on
click-approved spending grants only, not a **Trust level** value _(proposed)_.

**Presence-only demo**:
On a real ceremony, disclosure and binding are enforced; trust is not. A self-crafted
credential would pass. Never a real safety control. The **Instant demo** path is recorded
with this level too, though it enforces neither.
_Avoid_: verified, secure, trusted (as a claim about trust)

**Device-signed**:
The holder's signature over the exact terms is verified, but the credential behind it has
no issuer trust anchor. Stronger than presence-only; still not a real safety control.

**Issuer-verified**:
The claim's issuer and device signatures have been checked against a real anchor. The
gate never asserts this itself; only a delegated verifier can bring it.

**Delegated verifier**:
An external service the host plugs in to check presentations against a real trust anchor.
Trust is delegable; binding is not.
_Avoid_: bare "delegated", checker, attestor _(proposed)_

**Enforcement point**:
Where a requirement is enforced: at **checkout** (the normal, consolidated flow) or inside
the **tool** (the page-less blocking form).
_Avoid_: Mode A / Mode B in prose _(proposed)_

**Honesty fencing**:
The rule that the trust level, not prose, carries what the gate does and does not prove,
and that no copy may claim more.

### Signing and identity

**Gate origin**:
The public origin the gate serves its pages from, configured as `walletOrigin` despite
the name; it builds the links and page URLs the gate hands out. Each ceremony binds to
the origin of the request it runs on, so the two must agree in a deployment.
_Avoid_: wallet origin (in prose) _(proposed)_

**Mandate**:
An AP2-shaped record of an order or an authorization. How it is sealed depends on its
kind, and only some kinds show that the user authorized anything. A **cart mandate**
carries the order on the link, sealed with the server's HMAC: the server issued it, not
the user. A **payment mandate** records a checkout, with a dev integrity hash (passkey) or
no seal (dc-payment). An **open mandate** is the user's standing authorization, which the
agent closes per purchase; it carries the wallet's signature only when the grant was
approved on the phone, not when it was click-approved.

**Dev-signed mandate**:
A mandate sealed with an integrity hash instead of a real key. Integrity, not
authenticity.

**Mandate check**:
One of the deterministic checks re-run over a mandate's own fields after a ceremony
(amount integrity, user verification, subject binding).
_Avoid_: "Gate 1/Gate 2", gate _(proposed)_

**Store DID document**:
The public document at the gate origin that publishes the gate's mandate key and the
merchant's checkout key, so anyone can check what the gate signed.

### Human not present

**Human-present / human-not-present**:
Whether the user is in the loop at the moment of the action. Human-not-present means the
agent acts later, within bounds the user approved earlier.
_Avoid_: HP / HNP in user-facing copy

**Spending grant**:
A bounded, revocable pre-approval the user gives so the agent can buy while they are away:
which merchant, a total budget, a per-spend cap, and optionally which items. It lapses
after a fixed validity window; a grant does not yet take its own expiry.
_Avoid_: permission, spending limit, allowance, delegation; reserve "intent mandate" for the
AP2 artifact that records a grant _(proposed)_

**Spend**:
One order the agent places against a spending grant.
_Avoid_: draw, redeem, charge _(proposed)_

**Step-up**:
A spend the user must approve live: one inside a grant's limits but above its presence
threshold, or an age-restricted item the grant's own age proof doesn't cover (the user can
prove their age when approving the grant, and then the agent may buy such items later). A
spend over the limits is refused, not stepped up.

**Revoke**:
The user withdrawing a spending grant. Any later spend through the gate is refused. A
grant whose signed permission the agent holds (an agent-held key) is not recalled: it stays
spendable within its limits until its validity window ends.
_Avoid_: kill-switch, cancel

## Relationships

- A **Host** mounts the **Gate** and supplies its **Seams**; the **Storefront** is one **Host**.
- A **Policy** is an ordered list of **Requirements**; each **Requirement** names one **Credential** and its **Effect**.
- The **tool** context turns an **Order** and a **Policy** into a **Requires manifest**; the **page** context runs one **Ceremony** per **Requirement** on some **Rail**.
- A **Ceremony** yields a **Presentation**; an accepted **Presentation** becomes a **Proof** with a **Trust level**.
- An **Order** is created from a **Cart**, completes only through a **Completion path**, and pays only after **Amount binding** holds.
- A **Spending grant** is approved once while the **User** is present; each **Spend** against it happens human-not-present, and a **Step-up** brings the **User** back.
- **Issuer-verified** is reachable only through a **Delegated verifier**.

## Flagged ambiguities

Open items, tracked for decision in
[#402](https://github.com/openmobilehub/credentagent/issues/402). Resolve each, then update
the entry above and drop _(proposed)_.

- **"gate"** means seven things: the library, one check ("age gate"), the blocking effect, the host's policy resolver, the post-ceremony mandate checks ("Gate 1/2"), the human-not-present spender class, and a label on a proof. Proposed: **Gate** is the library only; one check is a **Requirement**; mandate steps are **Mandate checks**; the effect is **block**. "Age gate" stays acceptable as marketing shorthand for an age **Requirement**.
- **"delegated"** means five things: the external-verifier rail, the AP2 delegation chain, human-not-present spending, a presence value, and an authorization value. Proposed: never use it bare. Say **Delegated verifier** or **human-not-present**.
- **The user** goes by eight names (user, buyer, human, person, holder, principal, subject, cardholder). Proposed: **User**, with **Buyer** only in commerce and **Holder** only as the protocol role.
- **Grant vocabulary** (grant / permission / spending limit / intent mandate / delegation) and **spend vocabulary** (spend / draw / redeem). Proposed: **Spending grant** and **Spend**.
- **Mandate kinds** blur together. CLAUDE.md says "the AP2 mandate is dev-signed" generically, but mandates are now dev-signed, HMAC-sealed, or wallet-signed depending on kind. Spec 013 says the cart and intent mandates "no longer exist" in AP2, yet both still ship.
- **Rail count and names**: docs variously say "three rails" and "four rails", and "credential" vs "credential-gate". Proposed: four rails, named **passkey / credential / dc-payment / delegated verifier**.
- **Server-issued demo** is described both as outside the trust-level type and as one of its values. The field also appears as both `trust_level` and `trustLevel`. Proposed: keep it outside the type, as a grant label only.
- **Instant demo's trust level**: the tap-to-continue path records `presence-only-demo`, though it enforces no disclosure or binding. Proposed: give it its own label, or say so wherever the level is shown.
- **"Issuer-verified is the v0.2 line"** (CLAUDE.md, ARCHITECTURE.md, execution-contexts.md) reads as stale against the 0.5.0 package, and conflicts with "reachable today through the delegated verifier".
- **Passkey trust**: some tables call it "real WebAuthn crypto" in the trust column, but its trust level is **presence-only demo** because its mandate is dev-signed.
- **"approve"** names three different links: a per-requirement link, the grant signing page, and the order page.
- **"Host"** means both the developer's server and the MCP client (Claude, ChatGPT).
- **"verifier"** means both the gate acting as mdoc reader and an external **Delegated verifier**.
