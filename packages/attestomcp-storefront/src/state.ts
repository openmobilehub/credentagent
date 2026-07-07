// Storefront state — cart + completed orders. In-memory by default (zero deps);
// inject a custom store for a persistent / multi-session backend (e.g. Redis on a
// serverless deployment). Keys are per session / per order — never process-global
// beyond this in-process default (Security invariant 4).

/** The working cart, keyed per session (productId → quantity). Each MCP session gets its
 *  own cart, so concurrent buyers never share one (Security invariant 4). */
export interface CartStore {
  read(sessionId: string): Promise<Map<string, number>>;
  write(sessionId: string, cart: Map<string, number>): Promise<void>;
}

export class MemoryCartStore implements CartStore {
  private carts = new Map<string, Map<string, number>>();
  async read(sessionId: string): Promise<Map<string, number>> {
    return new Map(this.carts.get(sessionId) ?? []);
  }
  async write(sessionId: string, cart: Map<string, number>): Promise<void> {
    this.carts.set(sessionId, new Map(cart));
  }
}

/** Completed-order records, keyed by order id (what `get-order-status` reads). The
 *  payload is opaque to the storefront — the demo's ceremony writes its rich
 *  completed-order shape (with settlement); a standalone storefront leaves it empty. */
export interface OrderStore<T = unknown> {
  read(orderId: string): Promise<T | null>;
  write(orderId: string, order: T): Promise<void>;
  clear(orderId: string): Promise<void>;
}

export class MemoryOrderStore<T = unknown> implements OrderStore<T> {
  private orders = new Map<string, T>();
  async read(orderId: string): Promise<T | null> {
    return this.orders.get(orderId) ?? null;
  }
  async write(orderId: string, order: T): Promise<void> {
    this.orders.set(orderId, order);
  }
  async clear(orderId: string): Promise<void> {
    this.orders.delete(orderId);
  }
}
