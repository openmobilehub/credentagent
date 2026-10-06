# AP2 multi-store — an agent compares three stores, you sign on your phone, it pays

The end-to-end delegated purchase, live in a Claude chat, with a real phone wallet:

1. **You:** "I need a bag of house blend coffee. Compare the stores and buy the best one — up to $50."
2. **Claude** calls `compare-offers`, reads three stores' prices and ratings, picks one and says why.
3. **Claude** calls `request-permission` for that store and gives you a link.
4. **You** open the link on your phone and **sign** the permission with your wallet (Multipaz).
5. **Claude** calls `check-permission`. It now holds the permission you signed.
6. **Claude** calls `buy`. The store quotes and signs the cart. The agent signs the purchase with **its own key**. The store checks everything and answers.
7. **You** open the receipt link Claude gives you.

The agent (`agent.mjs`) and the stores (`stores.mjs`) are **separate processes**. The agent's private key never leaves the agent's process: the stores only ever see its public half.

## Run it

```bash
npm ci && npm run build
node examples/ap2-multistore/smoke.mjs   # the whole flow, phone simulated — check this first
node examples/ap2-multistore/up.mjs      # live: 4 tunnels + stores + agent (needs cloudflared)
```

`up.mjs` prints a connector URL. Add it in **claude.ai → Settings → Connectors → Add custom connector**, then have the conversation above.

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
