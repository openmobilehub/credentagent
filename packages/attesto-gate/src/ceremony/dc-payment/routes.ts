// The dc-payment rail (Digital Credentials API + OpenID4VP, amount-bound) — US3.
// Registers its routes onto the host app through the Foundational mount() seam:
//   GET  /attesto/dc-payment?order=<id>          → the payment gate page
//   GET  /attesto/dc-payment/request?order=<id>  → OpenID4VP request descriptor (scaffold)
//   POST /attesto/dc-payment/verify              → presence-only verify → SHARED completeOrder
//
// Dependency-free (no `express` import — invariant from mount.ts): handlers register
// against the structural CeremonyApp.get/post, and the verify body is read either
// from a host-installed body parser (`req.body`) or straight off the request stream.
//
// EVERY route resolves the order by id THROUGH `resolveOrder` (catalog re-pricing; a
// tampered/unknown id is refused — CT3, invariant 2). Completion goes through the
// injected `ctx.completion` seam — the SAME shared `completeOrder` the passkey rail
// uses (no second completion path — FR-008, CT8): it re-prices, enforces the age
// gate, settles (when configured), records idempotently, and clears the cart +
// per-order verification.
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import type { RequestLike } from "../origin.js";
import type { CompletionInput } from "../types.js";
import { buildDcPaymentRequest } from "./request.js";
import { buildDcMandate, runDcGates } from "./verify.js";
import { renderDcPaymentPage } from "./page.js";

// Minimal structural request/response shapes — the real Express req/res satisfy
// them, so the package never imports express.
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

// Read the JSON body from a host-installed parser, or straight off the stream when
// no parser ran (so the rail is self-contained — it doesn't require the host to
// mount express.json()).
async function readJsonBody(req: RailRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const registerDcPaymentGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only
  // attach when the host app can actually route (CeremonyApp.get/post are optional).
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;

  // GET the gate page — re-priced order, presence-only honesty banner.
  get("/attesto/dc-payment", async (req, res) => {
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined);
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    res.status(200).type("html").send(
      renderDcPaymentPage({
        order: order.id,
        total: order.total,
        currency: order.currency,
        lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })),
      }),
    );
  });

  // GET the (scaffold) OpenID4VP request descriptor for this order — carries the
  // REAL amount-bound transaction_data; the signed/encrypted shape is in-flight.
  get("/attesto/dc-payment/request", async (req, res) => {
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined);
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    res.json(buildDcPaymentRequest(order, originOf(ctx, req)));
  });

  // POST verify — presence-only. Resolve + re-price the order (CT3), build the
  // amount-bound mandate, run the four deterministic gates, and complete THROUGH
  // the shared completeOrder seam (FR-008, CT8). The OpenID4VP encrypted-presentation
  // path is scaffolded (501).
  post("/attesto/dc-payment/verify", async (req, res) => {
    const body = await readJsonBody(req);

    // OpenID4VP signed/encrypted wallet presentation path — scaffolded, PR-in-flight.
    if (body.presentation !== undefined || body.result !== undefined) {
      res.status(501).json({ completed: false, error: "openid4vp encrypted wallet presentation is scaffolded/in-flight; use the presence-only claims path", trust_level: "presence-only-demo" });
      return;
    }

    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined);
    if (!order) { res.status(400).json({ completed: false, error: "missing or invalid order" }); return; }

    const origin = originOf(ctx, req);
    const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
    const presentedAmount = typeof body.amount === "number" ? body.amount : order.total;
    const mandate = buildDcMandate({ order, origin, claims, presentedAmount });
    const gates = runDcGates(mandate, origin);

    // Complete through the SHARED seam (idempotent record + re-price + age gate +
    // optional settle + clear cart & per-order verification). No second path.
    const input: CompletionInput = {
      order,
      mandateId: mandate.id,
      amount: mandate.payment.amount,
      currency: mandate.payment.currency,
      method: "dc-payment",
      instrument: mandate.payment.instrument,
      gates,
    };
    const result = await ctx.completion(input);
    res.json({ mandate, gates, completed: result.completed, ...(result.reason ? { reason: result.reason } : {}), ...(result.settlement ? { settlement: result.settlement } : {}) });
  });
};
