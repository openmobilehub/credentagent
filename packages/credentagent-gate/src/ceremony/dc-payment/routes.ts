// The dc-payment rail (Digital Credentials API + OpenID4VP, amount-bound) — US3.
// Registers its routes onto the host app through the Foundational mount() seam:
//   GET  /credentagent/dc-payment?order=<id>          → the payment gate page
//   GET  /credentagent/dc-payment/request?order=<id>  → REAL signed OpenID4VP request (+ amount-bound transaction_data)
//   POST /credentagent/dc-payment/verify              → instant-demo claims OR a real presentation → SHARED completeOrder
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
//
// Verify has TWO paths feeding ONE set of gates + the SAME completion seam:
//   • instant-demo — body carries `claims` directly (the tested default; CT6–CT8).
//   • real presentation — body carries `result` from navigator.credentials.get; the
//     wallet's JWE response is decrypted, the device-signed transaction_data_hash is
//     re-checked against what we sealed, and the parsed mdoc drives the gates. The
//     wire crypto is REAL; the issuer trust anchor is not (presence-only-demo).
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import { decodeCartMandateParam } from "../cartMandate.js";
import type { RequestLike } from "../origin.js";
import type { CompletionInput } from "../types.js";
import { buildDcPaymentRequest } from "./request.js";
import { buildDcMandate, runDcGates, verifyDcPresentation, type DcMandate, type GateResult } from "./verify.js";
import { renderDcPaymentPage } from "./page.js";
import { checkoutRail } from "../theme.js";

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
  get("/credentagent/dc-payment", async (req, res) => {
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    // Order-derived stepper with Pay current: reflects only the gates THIS order has, and
    // shows Age ✓ only when it was ACTUALLY verified (read from the store) — never hardcoded.
    const verified = (await ctx.verificationStore.read(order.id)) ?? {};
    const rail = checkoutRail(order, "pay", { ageVerified: verified.ageVerified === true });
    res.status(200).type("html").send(
      renderDcPaymentPage({
        order: order.id,
        total: order.total,
        currency: order.currency,
        lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })),
        cart: typeof req.query.cart === "string" ? req.query.cart : undefined,
        rail,
      }),
    );
  });

  // GET the REAL signed OpenID4VP request for this order — ES256-signed, carrying the
  // amount-bound transaction_data, with the reader context (ECDH key + bound
  // transaction_data) sealed for /verify.
  get("/credentagent/dc-payment/request", async (req, res) => {
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    try {
      res.json(await buildDcPaymentRequest(order, originOf(ctx, req), ctx.signingKey));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST verify — instant-demo claims OR a real wallet presentation. Resolve +
  // re-price the order (CT3), build the amount-bound mandate, run the four
  // deterministic gates, and complete THROUGH the shared completeOrder seam
  // (FR-008, CT8).
  post("/credentagent/dc-payment/verify", async (req, res) => {
    const body = await readJsonBody(req);
    // statelessOrders: the mandate rides in the body — as a `cartMandate` object or a
    // base64url `cart` string (what the page JS forwards from its URL). resolveOrder
    // verifies it, and it's handed to completion so the shared seam re-verifies +
    // reconciles it (invariant 3).
    const cartMandate = (body as { cartMandate?: unknown }).cartMandate ?? decodeCartMandateParam((body as { cart?: unknown }).cart);
    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined, { cartMandate });
    if (!order) { res.status(400).json({ completed: false, error: "missing or invalid order" }); return; }

    const origin = originOf(ctx, req);
    let mandate: DcMandate;
    let gates: GateResult[];
    try {
      const result = body.result as { protocol?: string; data?: unknown } | undefined;
      if (result && typeof result === "object") {
        // REAL OpenID4VP presentation — decrypt the wallet's response, re-check the
        // device-signed transaction_data_hash, and run the gates.
        if (typeof body.readerContextToken !== "string") {
          res.status(400).json({ completed: false, error: "missing readerContextToken for openid4vp presentation" });
          return;
        }
        const out = await verifyDcPresentation({ order, origin, result, readerContextToken: body.readerContextToken, secret: ctx.signingKey });
        mandate = out.mandate;
        gates = out.gates;
      } else {
        // Instant-demo claims path (the tested default).
        const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
        const presentedAmount = typeof body.amount === "number" ? body.amount : order.total;
        mandate = buildDcMandate({ order, origin, claims, presentedAmount });
        gates = runDcGates(mandate, origin);
      }
    } catch (err) {
      res.status(400).json({ completed: false, error: (err as Error).message, trust_level: "presence-only-demo" });
      return;
    }

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
      ...(cartMandate !== undefined ? { cartMandate: cartMandate as CompletionInput["cartMandate"] } : {}),
    };
    const result = await ctx.completion(input);
    // Forward the on-chain settlement (when configured + succeeded) AND the
    // settlementError (a configured-but-failed settle → authorized-but-not-settled,
    // FR-013) so the page can render the x402 receipt or the calm refusal line.
    res.json({ mandate, gates, completed: result.completed, ...(result.reason ? { reason: result.reason } : {}), ...(result.settlement ? { settlement: result.settlement } : {}), ...(result.settlementError ? { settlementError: result.settlementError } : {}) });
  });
};
