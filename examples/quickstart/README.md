# CredentAgent quickstart — try it, run it, own it

A credential-gated agentic storefront: an AI agent can browse and cart, but a **consequential
checkout only completes after the buyer proves a credential** — age for the whiskey, a passkey
ceremony for payment. The whole storefront + policy is [35 lines](./server.mjs):

```js
store.gate((order) => credentagent.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
```

Three ways in, from zero setup to your own deployment — stop at whichever fits.

## See it in action

[▶︎ **Full flow — multi-credential checkout + x402 on-chain settlement**](https://www.youtube.com/watch?v=biTqHo2dL7M) (3 min) — an agent completes a gated checkout: age proof, loyalty credential, and passkey payment settling on-chain (Hedera testnet). Same-surface shorts: [Claude native app](https://youtube.com/shorts/JA91c2d2DhQ) · [ChatGPT](https://youtube.com/shorts/8rMx5P1AOgI) · [Goose + passkey checkout](https://youtu.be/qAXgxuihbA8).

## Try it (~1 min)

Paste the hosted demo into your agent host — nothing to install:

```
https://credentagent-demo.vercel.app/mcp
```

- **Claude** (web/desktop): Settings → Connectors → *Add custom connector* → paste the URL.
- **Claude Code**: `claude mcp add --transport http shop https://credentagent-demo.vercel.app/mcp`
- **ChatGPT**: Settings → Connectors → *Add connector* (developer mode) → paste the URL.
- **Goose**: `goose configure` → *Add Extension* → *Remote Extension (Streamable HTTP)* → paste the URL.

Then say:

1. *"What do you sell?"* — the catalog renders (whiskey is 21+, headphones aren't).
2. *"Add the Oak Reserve whiskey and check out."* — the agent surfaces the **age 21+**
   requirement (plus optional loyalty discount and payment) and a checkout link; open it,
   prove age, authorize with your passkey — order confirmed.
3. *"Add the Aurora headphones instead and check out."* — **no age gate**; just payment.

The gate is enforced **server-side on every completion path** — the agent can't skip it, and
neither can a hand-crafted request (that's [asserted in CI](#the-smoke), not just promised).

## Run it (~5 min)

```bash
git clone --depth 1 https://github.com/openmobilehub/credentagent
cd credentagent/examples/quickstart
npm i && npm start        # → http://localhost:3005/mcp
```

That's it — no monorepo build: this example installs the **published**
`@openmobilehub/credentagent-*` packages, exactly what you'd ship with. Connect
`http://localhost:3005/mcp` using any host above (for ChatGPT you'll need a public tunnel) and
run the same script.

## Own it (~3 min) <a name="own-it"></a>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fopenmobilehub%2Fcredentagent&root-directory=examples%2Fquickstart&project-name=credentagent-demo&repository-name=credentagent-demo&env=GATE_SECRET&envDescription=Signing%20key%20shared%20by%20all%20instances%20%E2%80%94%20generate%20with%3A%20openssl%20rand%20-hex%2032&envLink=https%3A%2F%2Fgithub.com%2Fopenmobilehub%2Fcredentagent%2Ftree%2Fmain%2Fexamples%2Fquickstart%23own-it)

One prompt: `GATE_SECRET` (`openssl rand -hex 32`) — deployed instances share no memory, so
they must share a signing key; the server **refuses to boot without one**. Orders travel
between serverless instances as **signed cart mandates** (`statelessOrders`) — tamper with a
line and completion is refused. Verify your deployment end-to-end:

```bash
SMOKE_URL=https://<your-deployment>.vercel.app npm run smoke
```

Optional persistence: attach Upstash/Vercel KV and set `KV_REST_API_URL` + `KV_REST_API_TOKEN`
— nothing else changes.

## The smoke

`npm run smoke` asserts the contract that makes this a *gate*, not a suggestion:

| | Assertion |
| :-- | :-- |
| a | MCP initialize handshake |
| b | whiskey checkout → `requires` contains `age` (21+, required; payment always last) |
| c | headphones checkout → no `age` entry |
| d | direct POST of a gated order (no ceremony) → **403** |
| e | tampered cart mandate → refused; the untampered one completes |
| f | paying an age-gated order without age proof → refused (`reason: "age"`) |

## Honest status

The ceremonies are `trust_level: "presence-only-demo"`: the wire crypto is real (WebAuthn,
OpenID4VP decrypt + nonce binding, signed cart mandates), but there is **no issuer / device
trust anchor yet** — a self-crafted credential would pass. This quickstart demonstrates the
*flow*; do not present the age gate as a real safety control until issuer-verified trust
lands ([roadmap](../../ROADMAP.md)).

## Going further

- Gate **any** action with **any** credential — [`custom-credential.mjs`](../custom-credential.mjs)
- Phone wallet + public tunnel (cross-device) — [`storefront-redis.mjs`](../storefront-redis.mjs)
- On-chain x402 settlement — [`with-x402-settlement.mjs`](../with-x402-settlement.mjs)
