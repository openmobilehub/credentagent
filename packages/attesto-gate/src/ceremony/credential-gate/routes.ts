// The credential-gate rail (age + membership) — the GDC-hero MVP. Registers its
// routes onto the host app through the Foundational mount() seam:
//   GET  /attesto/credential?order=<id>&cred=<age|membership>  → the gate page
//   GET  /attesto/credential/request?order=<id>&cred=<…>       → OpenID4VP request (scaffold)
//   POST /attesto/credential/verify                            → presence-only verify
//
// Dependency-free (no `express` import — invariant from mount.ts): the handlers are
// registered against the structural CeremonyApp.get/post, and the verify body is
// read either from a host-installed body parser (`req.body`) or straight off the
// request stream — so the rail works whether or not the host mounts express.json().
//
// EVERY route resolves the order by id THROUGH `resolveOrder` (catalog re-pricing;
// a tampered/unknown id is refused — CT3, invariant 2), and the age threshold is
// re-derived from the catalog-priced lines, never the token (T013, invariant 5).
//
// Enforcement (CT9 / invariant 1): the verify handler grants age ONLY on the
// explicit positive claim at the order's threshold; the OTHER half — refusing an
// unverified age-restricted order — lives in the shared `completeOrder` seam
// (completion.ts), so every payment rail honors it. The demo's POST
// /checkout/place-order and the MCP order-completion tool are the remaining two
// completion paths; wiring the demo to consume this rail is **T014 (deferred)**.
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import type { RequestLike } from "../origin.js";
import { buildCredentialRequest } from "./request.js";
import { evaluateCredential, requiredAgeForOrder, type CredentialKind } from "./verify.js";
import { renderCredentialPage } from "./page.js";

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

function parseKind(raw: unknown): CredentialKind | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "age" || value === "membership" ? value : null;
}

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

// Persist a successful verification, scoped to THIS order (never process-global —
// invariant 4). Age writes the positive over-threshold claim; membership marks the
// loyalty discount, which resolveOrder/completeOrder then re-derive exactly once.
async function recordVerified(ctx: CeremonyContext, orderId: string, kind: CredentialKind, membershipNumber: string | null): Promise<void> {
  const prev = (await ctx.verificationStore.read(orderId)) ?? {};
  if (kind === "age") {
    await ctx.verificationStore.write(orderId, { ...prev, ageVerified: true });
  } else {
    await ctx.verificationStore.write(orderId, { ...prev, loyalty: { applied: true, membershipNumber } });
  }
}

export const registerCredentialGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only
  // attach when the host app can actually route (CeremonyApp.get/post are optional).
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;

  // GET the gate page — re-priced order, presence-only honesty banner.
  get("/attesto/credential", async (req, res) => {
    const kind = parseKind(req.query.cred);
    if (!kind) { res.status(404).type("html").send("<!doctype html><h1>Unknown credential</h1>"); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined);
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    res.status(200).type("html").send(
      renderCredentialPage({
        kind,
        order: order.id,
        minimumAge: requiredAgeForOrder(order) ?? undefined,
        total: order.total,
        currency: order.currency,
        percent: order.discount > 0 && order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : undefined,
      }),
    );
  });

  // GET the (scaffold) OpenID4VP request descriptor for this kind.
  get("/attesto/credential/request", async (req, res) => {
    const kind = parseKind(req.query.cred);
    if (!kind) { res.status(404).json({ error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined);
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    res.json(buildCredentialRequest(kind, originOf(ctx, req), { minimumAge: requiredAgeForOrder(order) ?? undefined }));
  });

  // POST verify — presence-only. Resolve + re-price the order (CT3), evaluate the
  // disclosed claims (explicit positive claim — CT4/CT5), write the per-order
  // record. The OpenID4VP encrypted-presentation path is scaffolded (501).
  post("/attesto/credential/verify", async (req, res) => {
    const body = await readJsonBody(req);
    const kind = parseKind(body.cred);
    if (!kind) { res.status(404).json({ verified: false, error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined);
    if (!order) { res.status(400).json({ verified: false, error: "missing or invalid order" }); return; }

    // OpenID4VP signed/encrypted presentation path — scaffolded, PR-in-flight.
    if (body.presentation !== undefined && body.claims === undefined) {
      res.status(501).json({ verified: false, error: "openid4vp credential presentation is scaffolded/in-flight; use the presence-only claims path", trust_level: "presence-only-demo" });
      return;
    }

    const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
    const minimumAge = kind === "age" ? requiredAgeForOrder(order) ?? 21 : undefined;
    const out = evaluateCredential(kind, claims, { minimumAge });
    if (out.verified) await recordVerified(ctx, order.id, kind, out.membershipNumber);
    res.json(out);
  });
};
