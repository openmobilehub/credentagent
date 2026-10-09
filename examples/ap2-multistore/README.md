# AP2 multi-store — an agent compares three stores, you sign on your phone, it pays

The end-to-end delegated purchase, live in a Claude (or ChatGPT) chat, with a real phone wallet:

1. **You:** "I need a bag of house blend coffee. Compare the stores and buy the best one — up to $50."
2. **Claude** calls `compare-offers`. A card shows the three stores' prices and ratings side by side. Claude picks one and says why.
3. **Claude** calls `request-permission` for that store. A card shows exactly what you would allow (the store, the products, the limits), why the agent picked that store, and a **QR code**.
4. **You** scan the QR code with your phone and **sign** the permission with your wallet (Multipaz). The card turns to "Signed on your phone" by itself.
5. **Claude** is already waiting: it calls `check-permission` right after showing the QR code, and calls it again while it is pending. Each call waits up to 45 s for your signature. You never have to tell it you signed. If it ends its turn instead of waiting, the card posts *"I signed the permission…"* to the chat for you, once.
6. **Claude** calls `buy`. The store quotes and signs the cart. The agent signs the purchase with **its own key**. The store checks everything and answers.
7. **You** see the answer in a card: paid and verified, with the list of what the store checked, or refused, with the reason.

The agent (`agent.mjs`) and the stores (`stores.mjs`) are **separate processes**. The agent's private key never leaves the agent's process: the stores only ever see its public half.

## Run it

```bash
npm ci && npm run build
node examples/ap2-multistore/smoke.mjs   # the whole flow, phone simulated — check this first
node examples/ap2-multistore/up.mjs      # live: 4 tunnels + stores + agent (needs cloudflared)
```

`up.mjs` prints a connector URL. Add it in **claude.ai → Settings → Connectors → Add custom connector**, then have the conversation above. ChatGPT takes the same URL as a custom connector (it needs developer mode).

The cards come from the SDK's card kit (`@openmobilehub/credentagent-gate/cards`, spec 015): `createCards()` serves them to Claude as an MCP Apps resource and to ChatGPT as an Apps SDK resource. They take the chat's theme and fonts. To see them without a chat, open `http://localhost:4100/widget?view=offers` (or `only-one`, `over-limit`, `permission`, `permission-signed`, `receipt`, `refused`). That preview uses sample data.

## Scenarios, simplest first

Ask Claude (or ChatGPT) for each one in a new chat.

1. **Simple: one store has it.** *"Buy me a Cold Brew Concentrate, up to $20."* Only RoastWorks sells it, so the offers card says there is nothing to compare. The agent asks for a permission at RoastWorks; you sign on your phone; it buys.
2. **More stores, one choice.** The conversation at the top of this page: three stores sell House Blend, and the agent picks one and says why.

3. **Above your limit.** *"Buy a bag of Espresso Beans, but don't pay more than $15."* Every store sells it for more (the cheapest is $18 at RoastWorks). The agent doesn't ask you to sign anything and doesn't buy. It tells you the cheapest offer, and that a higher limit means signing a new permission on your phone. If it asked anyway, the store would refuse to open a permission nothing fits, and its back office would say why.

Coming next: waiting for the price to drop, offering your maximum to the store, and stores bidding against each other (tracked in #252).

## What the stores see

Each store has a live **back office** at its own root URL. `http://localhost:4104` shows all three side by side, so you can put it on the screen next to the chat. Each back office shows, as it happens:

- the agent reading the catalog;
- the permission being requested, opened on the phone, and signed;
- the cart the store quoted and signed;
- the verdict: **verified**, with the list of what the store checked, or **refused**, with the reason in plain words (for example, "This permission was signed for another store").

The person's receipt (the link Claude gives back) shows the same list of checks. Each store's page names its merchant id, which is its host, and carries the demo notice.

Two ports matter here. The live demo uses 4100–4104. `smoke.mjs` runs on 4200–4204, so it never collides with a demo that is running. Set `BASE_PORT` to move the live demo's ports.

**The phone:** Android + Chrome (Digital Credentials API) and a Multipaz wallet built from `TheBlackBit/multipaz @ feat/ap2-delegate-transaction-utopia`. Stock Multipaz rejects the AP2 `delegate` request.

Each store gets its own tunnel because **a store's merchant id is its host**. A permission signed for BeanBarn names BeanBarn's host, and Acme refuses it.

## What is real, and what is still demo

**Real:**
- The phone's signature over the exact limits (products, budget, per-purchase cap).
- The agent's own key, which never leaves its process.
- Each store's signed cart.
- The AP2 mandate chain.
- The store's verdict (`verifyDelegatedPurchase`): the right store, only the products you signed, within budget, and priced from the store's own catalog.

**Demo:**
- `trust_level: "presence-only-demo"`: the payment credential has no issuer trust anchor yet. Issuer verification is the v0.2 line, so a self-crafted credential would pass.
- **No real money moves.**
- Revoking a grant does not take back a permission the agent already holds (#239).
- The stores keep state in memory, and a permission covers **one** store. A permission across several stores is #156.

`smoke.mjs` checks the refusals as well as the purchase:
- the same permission at another store,
- a product you did not sign for,
- a purchase over the budget.

It also checks that each back office received every kind of event, and that Acme's back office gives the plain-words reason for its refusal.
