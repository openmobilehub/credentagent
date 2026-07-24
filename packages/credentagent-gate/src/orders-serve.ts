// orders.serve(app) — wire the human-present checkout onto an Express app in ONE call.
//
// This is the graduation of the orders prototype into the library: everything the
// `stateless-orders` example wired by hand (a catalog re-pricer, a completion context,
// the completion seam, the checkout page route) now lives here, bound to the created-order
// store `orders.create()` writes. The caller writes:
//
//   const ca = new CredentAgent({ walletOrigin });
//   ca.orders.serve(app);                                   // rails + page + completion → order.settled
//   ca.on("order.settled", ({ id }) => fulfill(id));
//   const { approveUrl } = await ca.orders.create({ order, policy });
//
// It reuses the SAME proven pieces every other path uses — `mountCeremony` (the rails),
// `completeOrder` (the shared, fail-closed completion), and `renderRequirements` (the one
// checkout page) — so there is no second, weaker enforcement surface. The created order is
// the server-side price authority (invariant 2): the catalog re-derives amount + age
// threshold from the STORED lines, never from the token.

import { mountCeremony, type CeremonyApp } from "./ceremony/mount.js";
import { completeOrder, type CompletedRecord, type CompletedOrderStore } from "./ceremony/completion.js";
import { renderRequirements, type RenderOrder } from "./ceremony/checkout-page.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder, CeremonyOrderStore, RepriceOpts } from "./ceremony/types.js";
import type {
  Credential,
  GateOrder,
  ReaderIdentity,
  Step,
  VerificationManifestEntry,
  VerificationRecord,
  VerificationStore,
} from "./types.js";
import type { CompletedOrder, CreatedOrder, OrderStore } from "./orders.js";

/** What `orders.serve(app)` needs from the client to wire the checkout. */
export interface ServeOrdersDeps {
  walletOrigin: string;
  /** The created-order store `orders.create()` writes (the price authority). */
  created: OrderStore<CreatedOrder>;
  /** The completed-order store `orders.retrieve()` reads. */
  completed: OrderStore<CompletedOrder>;
  /** `orders._complete` — records the completion AND fires `order.settled`. */
  complete: (record: CompletedOrder) => void | Promise<void>;
  /** `credentagent.requirements` — the policy → manifest resolver (re-homed approve links). */
  requirements: (order: GateOrder, policy: Step[]) => VerificationManifestEntry[];
  /** The per-order verification store (invariant 4). */
  verificationStore: VerificationStore;
  /** The in-process credential registry, so `completeOrder` enforces every custom gate (007). */
  credentialRegistry: ReadonlyMap<string, Credential>;
  /** Stable reader identity the rails present (omit ⇒ per-request self-signed). */
  readerIdentity?: ReaderIdentity;
  /** Stable HMAC key for the challenge (survives an instance split). Omit ⇒ ephemeral dev key. */
  signingKey?: string;
}

/** A structural Express request/response — the package stays dependency-free (mirrors the rails). */
interface OrdersRequest {
  params: Record<string, string>;
}
interface OrdersResponse {
  status(code: number): OrdersResponse;
  type(t: string): OrdersResponse;
  send(body: string): unknown;
  json(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
}
type OrdersHandler = (req: OrdersRequest, res: OrdersResponse) => void | Promise<void>;

// ── Order shape mapping (the stored GateOrder is the authority) ────────────────

/** The discount percent a policy grants (a `discount` step), if any. */
function discountPctOf(policy: Step[]): number | undefined {
  for (const s of policy) {
    if (s.credential.effect.kind === "discount") {
      return s.credential.effect.percent ?? s.credential.params?.percent;
    }
  }
  return undefined;
}

/** GateOrder line → CeremonyOrder line (compute lineTotal; carry the fields the gates read). */
function toCeremonyLine(l: GateOrder["lines"][number], currency: string) {
  return {
    id: l.id,
    name: typeof l.name === "string" ? l.name : l.id,
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    lineTotal: l.unitPrice * l.quantity,
    currency,
    ...(typeof l.minimumAge === "number" ? { minimumAge: l.minimumAge } : {}),
    ...(typeof l.category === "string" ? { category: l.category } : {}),
    ...(typeof l.requiresRx === "boolean" ? { requiresRx: l.requiresRx } : {}),
  };
}

/** Re-price a stored order's lines, applying the policy discount only when loyalty is proven. */
function repriceStored(created: CreatedOrder, items: CartItemRef[], opts?: RepriceOpts): CeremonyOrder {
  const priceOf = new Map(created.order.lines.map((l) => [l.id, l]));
  const currency = created.order.currency;
  const lines = items.map((it) => {
    const src = priceOf.get(it.productId);
    if (!src) throw new Error(`[credentagent] orders catalog: unknown line "${it.productId}" for order ${created.order.id}`);
    return toCeremonyLine({ ...src, quantity: it.quantity }, currency);
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const pct = discountPctOf(created.policy);
  const discount = opts?.loyaltyApplied && pct ? Math.round(subtotal * pct) / 100 : 0;
  return {
    id: created.order.id,
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    discount,
    total: subtotal - discount,
    currency,
  };
}

function toRenderOrder(o: CeremonyOrder): RenderOrder {
  return {
    id: o.id,
    lines: o.lines.map((l) => ({ name: l.name, id: l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })),
    itemCount: o.itemCount ?? o.lines.reduce((s, l) => s + l.quantity, 0),
    discount: o.discount,
    total: o.total,
    currency: o.currency,
  };
}

/** An order is "gated" when its policy needs a ceremony — any blocking gate or payment
 *  authorize. Gated orders complete ONLY through the fail-closed rails; the instant-demo
 *  place path is refused for them (invariant 1 — enforced server-side, not by hiding a button).
 *  Shared with grants-serve: a policy-gated GRANT is likewise never approvable by a button. */
export function isGated(manifest: VerificationManifestEntry[]): boolean {
  return manifest.some((e) => e.effect === "gate" || e.effect === "authorize");
}

// ── Wire it all ───────────────────────────────────────────────────────────────

const html = (body: string) =>
  `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:3rem auto">${body}</body>`;

/**
 * Register the checkout onto `app`: the ceremony rails (via `mountCeremony`), the checkout
 * page at `/credentagent/orders/:id`, the instant-demo place path (ungated only), and the
 * status poll. Idempotent per app is the caller's concern (the client guards double-serve).
 */
export function serveOrders(app: CeremonyApp, deps: ServeOrdersDeps): void {
  // A synchronous mirror of the stored order, warmed by every `orderStore.read` (which the
  // rails call before the synchronous catalog re-price). Keyed by order id; prices only.
  const warm = new Map<string, CreatedOrder>();

  const orderStore: CeremonyOrderStore = {
    read: async (orderId: string): Promise<CeremonyOrder | null> => {
      const created = await deps.created.read(orderId);
      if (!created) return null;
      warm.set(orderId, created);
      return repriceStored(created, created.order.lines.map((l) => ({ productId: l.id, quantity: l.quantity })));
    },
  };

  const catalog: CeremonyCatalog = {
    createOrder: (items: CartItemRef[], orderId: string, opts?: RepriceOpts): CeremonyOrder => {
      const created = warm.get(orderId);
      if (!created) throw new Error(`[credentagent] orders catalog: order ${orderId} not resolved before re-price`);
      return repriceStored(created, items, opts);
    },
  };

  // The completion seam = the shared `completeOrder`, bound so its idempotent record write
  // flows into `orders._complete` (which writes the completed store AND fires order.settled).
  const records: CompletedOrderStore = {
    read: async (orderId: string): Promise<CompletedRecord | undefined> => {
      const done = await deps.completed.read(orderId);
      if (!done) return undefined;
      // Enough for `completeOrder`'s idempotency echo (it checks truthiness + settlement).
      return { orderId, mandateId: done.txId ?? "", amount: done.amount ?? 0, currency: done.currency ?? "", method: done.method ?? "", gates: [], completedAt: done.completedAt ?? "" };
    },
    write: async (record: CompletedRecord): Promise<void> => {
      await deps.complete({
        orderId: record.orderId,
        amount: record.amount,
        currency: record.currency,
        method: record.method,
        ...(record.settlement?.txId ? { txId: record.settlement.txId } : {}),
        ...(record.settlement?.network ? { network: record.settlement.network } : {}),
        completedAt: record.completedAt,
      });
    },
  };

  mountCeremony(app, {
    orderStore,
    catalog,
    completion: (input) => completeOrder(input, { catalog, verificationStore: deps.verificationStore, records, credentialRegistry: deps.credentialRegistry }),
    verificationStore: deps.verificationStore,
    credentialRegistry: deps.credentialRegistry,
    // After a rail proves / pays, return the buyer to THIS order's checkout page — not the
    // storefront's `/checkout` default (which the orders interface doesn't serve).
    returnUrl: (id) => `${deps.walletOrigin}/credentagent/orders/${encodeURIComponent(id)}`,
    ...(deps.readerIdentity ? { readerIdentity: deps.readerIdentity } : {}),
    ...(deps.signingKey ? { signingKey: deps.signingKey } : { allowEphemeralKey: true }),
  });

  const get = app.get?.bind(app);
  const post = app.post?.bind(app);
  if (!get || !post) {
    throw new Error("[credentagent] orders.serve(app): the app must expose Express-style get()/post() route methods.");
  }

  // The checkout page — the ONE shared three-gate page. It LINKS to the rails mountCeremony
  // registered; it does not run the ceremony (the rails do, fail-closed).
  const page: OrdersHandler = async (req, res) => {
    const id = req.params.id;
    const created = await deps.created.read(id);
    if (!created) { res.status(404).type("html").send(html("<h1>Unknown order</h1>")); return; }
    warm.set(id, created);

    const v = ((await deps.verificationStore.read(id)) ?? {}) as VerificationRecord;
    const ageVerified = v.ageVerified === true;
    const loyaltyApplied = v.loyalty?.applied === true;
    const order = repriceStored(created, created.order.lines.map((l) => ({ productId: l.id, quantity: l.quantity })), { ageVerified, loyaltyApplied });

    const manifest = deps.requirements(created.order, created.policy); // re-homed approve links (mounted)
    const done = await deps.completed.read(id);
    const gated = isGated(manifest);
    const verification = { ageVerified, loyaltyApplied, ...(v.verifiedGates ? { verifiedGates: v.verifiedGates } : {}) };
    const paid = done ? { amount: done.amount ?? order.total, currency: done.currency ?? order.currency, ...(done.method ? { method: done.method } : {}) } : null;

    const orderQ = encodeURIComponent(id);
    const payment = gated
      ? {
          methods: [
            { value: "passkey", name: "Pay with a passkey (this device)", desc: "Authorize with this device's passkey.", href: `${deps.walletOrigin}/credentagent/passkey?order=${orderQ}`, checked: true },
            { value: "dc-payment", name: "Cross-device wallet", desc: "Scan a QR and approve with your phone's wallet.", href: `${deps.walletOrigin}/credentagent/dc-payment?order=${orderQ}` },
          ],
        }
      : {
          methods: [
            { value: "demo", name: `Complete purchase (demo) — ${order.total} ${order.currency}`, desc: "No real charge — records the order.", placeOrder: true },
          ],
          placeOrderPath: `/credentagent/orders/${orderQ}/place`,
          orderToken: id,
        };
    const statusUrl = `/credentagent/orders/${orderQ}/status`;
    res.type("html").send(renderRequirements(toRenderOrder(order), manifest, verification, { payment, paid, statusUrl }));
  };

  // Instant-demo completion — UNGATED orders only. A gated order (age / payment) is refused
  // here (invariant 1): it must complete through the fail-closed rails, never a direct POST.
  const place: OrdersHandler = async (req, res) => {
    const id = req.params.id;
    const created = await deps.created.read(id);
    if (created) {
      warm.set(id, created);
      const manifest = deps.requirements(created.order, created.policy);
      if (isGated(manifest)) {
        res.status(403).type("html").send(html("<h1>Verification required</h1><p>This order has age / payment requirements — complete it on the checkout page. It can't be placed from the instant-demo path.</p>"));
        return;
      }
      // Idempotent, like the rails' completeOrder: a retried / double-clicked POST must not
      // re-record the order or fire order.settled again (the listener triggers fulfillment).
      const done = await deps.completed.read(id);
      if (!done) {
        const order = repriceStored(created, created.order.lines.map((l) => ({ productId: l.id, quantity: l.quantity })));
        await deps.complete({ orderId: id, amount: order.total, currency: order.currency, method: "demo", completedAt: new Date().toISOString() });
      }
    }
    res.type("html").send(html("<h1>✓ Order placed (demo)</h1><p>You can close this tab.</p>"));
  };

  // The status poll — a standing checkout tab reloads when the order completes on another
  // tab / device / rail (MCP / the browser have no server→client push).
  const status: OrdersHandler = async (req, res) => {
    res.setHeader?.("Access-Control-Allow-Origin", "*");
    const done = await deps.completed.read(req.params.id);
    res.json({ completed: !!done, order: done ?? null });
  };

  get("/credentagent/orders/:id", page);
  post("/credentagent/orders/:id/place", place);
  get("/credentagent/orders/:id/status", status);
}
