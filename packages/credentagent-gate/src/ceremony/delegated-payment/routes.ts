// The delegated-payment rail (008, #60) — verification + settlement delegated to an
// EXTERNAL verifier/processor, without leaving the mounted ceremony:
//   GET  /credentagent/delegated?order=<id>          → the approve page
//   GET  /credentagent/delegated/request?order=<id>  → the verifier handoff + sealed reference
//   POST /credentagent/delegated/verify              → the non-delegable re-checks → shared completeOrder
//
// Dependency-free (no `express` import — invariant from mount.ts): handlers register
// against the structural CeremonyApp.get/post; the verify body is read from a host body
// parser (`req.body`) or straight off the stream.
//
// OPT-IN: the rail registers NOTHING unless the host configured a `verifier` seam, so
// a deployment that never opted in has byte-identical routing (FR-001).
//
// The verify handler NEVER trusts the verifier's `approved` alone: it re-derives the
// amount binding from the catalog, re-runs the merchant's OWN policy over the disclosed
// claims, and only THEN authorizes settlement — all through the shared `completeOrder`
// seam (one completion path — invariant 1). The browser carries only the sealed reference,
// never the verdict, so it cannot forge an approval.
//
// Every route resolves the order THROUGH `resolveOrder` (catalog re-pricing; a tampered
// or unknown id is refused — invariant 2), and threads the `?cart=` mandate passthrough
// so a store-less (statelessOrders) checkout survives every hop.
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import { decodeCartMandateParam } from "../cartMandate.js";
import { checkoutRail } from "../theme.js";
import { buildBindingFields } from "../mandate.js";
import type { RequestLike } from "../origin.js";
import type { CompletionInput } from "../types.js";
import { buildDelegatedRequest } from "./request.js";
import { renderDelegatedPage } from "./page.js";
import { openReference } from "./referenceToken.js";
import { applyDelegatedPolicy, instrumentFromVerdict, policyHasPayment, runDelegatedGates } from "./verify.js";

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

// Read the JSON body from a host-installed parser, or straight off the stream when no
// parser ran (so the rail is self-contained — same as the sibling rails).
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

function originOf(ctx: CeremonyContext, req: RailRequest) {
  const reqLike: RequestLike = { headers: req.headers, host: firstHeader(req.headers.host) ?? "localhost", protocol: req.protocol };
  return ctx.origin(reqLike);
}

const queryString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const registerDelegatedPaymentGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only attach
  // when the host app can actually route (CeremonyApp.get is optional).
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;
  // Opt-in: with no external verifier there is no delegated ceremony to serve.
  if (!ctx.verifier) return;

  // GET the approve page — re-priced order, no trust claim (trust is the verifier's to report).
  get("/credentagent/delegated", async (req, res) => {
    const order = await resolveOrder(ctx, queryString(req.query.order), { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    // Order-derived stepper with Pay current: reflects only the gates THIS order has, and
    // shows Age ✓ only when it was ACTUALLY verified (read from the store) — never hardcoded.
    const verified = (await ctx.verificationStore.read(order.id)) ?? {};
    const rail = checkoutRail(order, "pay", { ageVerified: verified.ageVerified === true });
    res.status(200).type("html").send(
      renderDelegatedPage({
        order: order.id,
        total: order.total,
        currency: order.currency,
        lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })),
        cart: queryString(req.query.cart),
        rail,
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

  // POST verify — the completion leg. The body carries ONLY the sealed reference (never the
  // verdict or disclosed claims). Open it, re-fetch the verified presentment server-to-server,
  // run the non-delegable re-checks, and complete THROUGH the shared seam.
  post("/credentagent/delegated/verify", async (req, res) => {
    const body = await readJsonBody(req);
    const orderId = queryString(body.order);
    const referenceToken = queryString(body.referenceToken);
    if (!orderId || !referenceToken) { res.status(400).json({ completed: false, error: "missing order or referenceToken" }); return; }

    // 1. Open the sealed reference — refuses a tampered / wrong-order / expired token
    //    (invariant 4). This is the ONLY input accepted from the client: the disclosed
    //    claims and the approval are fetched server-to-server below, never taken from here.
    let reference: string;
    try {
      reference = openReference(referenceToken, orderId, ctx.signingKey).reference;
    } catch (err) {
      res.status(400).json({ completed: false, error: (err as Error).message });
      return;
    }

    // 2. Re-resolve + re-price the order server-side (invariant 2).
    const cartMandate = (body as { cartMandate?: unknown }).cartMandate ?? decodeCartMandateParam((body as { cart?: unknown }).cart);
    const order = await resolveOrder(ctx, orderId, { cartMandate });
    if (!order) { res.status(400).json({ completed: false, error: "missing or invalid order" }); return; }

    const origin = originOf(ctx, req);
    try {
      // 3. Fetch the verified presentment BY REFERENCE — verify + trust only, NO settlement.
      const verdict = await ctx.verifier!.consume({ reference, order });

      // 4. The non-delegable re-checks. `gates` carries approved + amount-binding (refused at
      //    the shared seam before settlement); `applyDelegatedPolicy` re-runs THIS merchant's
      //    age/custom policy over the disclosed claims and writes the verification state the
      //    shared sweep enforces (never trusting the verifier's own, possibly-laxer, check).
      const gates = runDelegatedGates(order, origin, verdict);
      // ONLY a presentment the verifier VOUCHED for may write that state. An adapter parses the
      // disclosure BEFORE its trust check, so a refused verdict can still carry
      // `age_over_21: true`. The store is read by EVERY completion path, so writing it on a
      // refusal would leave the order age-verified and let this refused attempt unlock the
      // passkey / place-order path for the SAME order (invariant 5 — cross-path bleed).
      // Binding failures deliberately do NOT gate this: the claim still came from a trusted
      // presentment, so the identity proof is earned even when the amount is wrong.
      if (verdict.approved === true) await applyDelegatedPolicy(ctx, order, verdict);

      // 5. Settlement is gate-authorized: the thunk runs INSIDE completeOrder, after its gates
      //    + re-price + age/custom enforcement pass — so a refused order never settles. Only a
      //    policy that authorizes payment settles; an identity-only delegated gate does not.
      const expected = buildBindingFields(order, origin);
      const settle = policyHasPayment(ctx, order)
        ? async () => {
            const rec = await ctx.verifier!.settle?.({ reference, order, amount: expected.amount, currency: expected.currency });
            if (!rec) throw new Error("delegated policy authorizes payment but the verifier has no settle()");
            return rec;
          }
        : undefined;

      // 6. Complete through the SHARED seam (one path — FR-007): order-keyed idempotency,
      //    re-price, age + custom-gate enforcement, gate-authorized settlement, record + clear.
      const result = await ctx.completion({
        order,
        mandateId: verdict.binding.transactionId ?? reference,
        amount: expected.amount,
        currency: expected.currency,
        method: "delegated",
        instrument: instrumentFromVerdict(verdict),
        gates,
        trustLevel: verdict.trust_level,
        ...(settle ? { settle } : {}),
        ...(cartMandate !== undefined ? { cartMandate: cartMandate as CompletionInput["cartMandate"] } : {}),
      });

      res.json({
        completed: result.completed,
        trust_level: verdict.trust_level,
        gates,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.settlement ? { settlement: result.settlement } : {}),
        ...(result.settlementError ? { settlementError: result.settlementError } : {}),
      });
    } catch (err) {
      res.status(400).json({ completed: false, error: (err as Error).message });
    }
  });
};
