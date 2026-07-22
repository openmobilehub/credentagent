// The delegated-payment rail (008, #60) — verification + settlement delegated to an
// EXTERNAL verifier/processor, without leaving the mounted ceremony:
//   GET /credentagent/delegated?order=<id>          → the approve page
//   GET /credentagent/delegated/request?order=<id>  → the verifier handoff + sealed reference
//
// Dependency-free (no `express` import — invariant from mount.ts): handlers register
// against the structural CeremonyApp.get.
//
// OPT-IN: the rail registers NOTHING unless the host configured a `verifier` seam, so
// a deployment that never opted in has byte-identical routing (FR-001).
//
// POST /verify is DELIBERATELY ABSENT until #87, not stubbed. That route is where the
// non-delegable re-checks live (amount/payee binding re-derived from the catalog, the
// gate's own policy re-run over the disclosed claims, order-keyed recording through the
// shared completeOrder). A route that accepted a verdict WITHOUT them would be a
// fail-open completion path — exactly the bug class invariant 1 exists to prevent — so
// until the checks exist, 404 is the correct and safe behavior.
//
// Every route resolves the order THROUGH `resolveOrder` (catalog re-pricing; a tampered
// or unknown id is refused — invariant 2), and threads the `?cart=` mandate passthrough
// so a store-less (statelessOrders) checkout survives every hop.
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import { decodeCartMandateParam } from "../cartMandate.js";
import type { RequestLike } from "../origin.js";
import { buildDelegatedRequest } from "./request.js";
import { renderDelegatedPage } from "./page.js";

// Minimal structural request/response shapes — the real Express req/res satisfy them,
// so the package never imports express.
interface RailRequest {
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  body?: unknown;
}
interface RailResponse {
  status(code: number): RailResponse;
  type(t: string): RailResponse;
  send(body: string): unknown;
  json(body: unknown): unknown;
}
type RailHandler = (req: RailRequest, res: RailResponse) => void | Promise<void>;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function originOf(ctx: CeremonyContext, req: RailRequest) {
  const reqLike: RequestLike = { headers: req.headers, host: firstHeader(req.headers.host) ?? "localhost", protocol: req.protocol };
  return ctx.origin(reqLike);
}

const queryString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const registerDelegatedPaymentGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only attach
  // when the host app can actually route (CeremonyApp.get is optional).
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get) return;
  // Opt-in: with no external verifier there is no delegated ceremony to serve.
  if (!ctx.verifier) return;

  // GET the approve page — re-priced order, no trust claim (trust is the verifier's to report).
  get("/credentagent/delegated", async (req, res) => {
    const order = await resolveOrder(ctx, queryString(req.query.order), { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    res.status(200).type("html").send(
      renderDelegatedPage({
        order: order.id,
        total: order.total,
        currency: order.currency,
        lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })),
        cart: queryString(req.query.cart),
      }),
    );
  });

  // GET the verifier handoff for this order + the sealed, order-bound reference.
  get("/credentagent/delegated/request", async (req, res) => {
    const order = await resolveOrder(ctx, queryString(req.query.order), { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    try {
      res.json(await buildDelegatedRequest(ctx, order, originOf(ctx, req)));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
};
