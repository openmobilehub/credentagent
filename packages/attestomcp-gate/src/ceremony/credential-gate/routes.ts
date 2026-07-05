// The credential-gate rail (age + membership) — the GDC-hero MVP. Registers its
// routes onto the host app through the Foundational mount() seam:
//   GET  /attestomcp/credential?order=<id>&cred=<age|membership>  → the gate page
//   GET  /attestomcp/credential/request?order=<id>&cred=<…>       → REAL OpenID4VP + org-iso-mdoc requests
//   POST /attestomcp/credential/verify                            → instant-demo claims OR a real presentation
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
// Verification has TWO paths feeding ONE policy (evaluateCredential):
//   • instant-demo  — body carries `claims` directly (no wallet round-trip; the
//                     tested default for the e2e + bypass suite).
//   • real presentation — body carries `result` from navigator.credentials.get; the
//                     wallet's response is JWE/HPKE-decrypted, nonce/origin-bound,
//                     and the ISO-mdoc DeviceResponse parsed before the same policy
//                     runs. Dispatched by the wallet's `result.protocol`
//                     (openid4vp → verifyCredentialPresentation; org-iso-mdoc →
//                     verifyMdocPresentation). The wire crypto is REAL; the issuer
//                     trust anchor is not (trust_level presence-only-demo).
//
// Enforcement (CT9 / invariant 1): the verify handler grants age ONLY on the
// explicit positive claim at the order's threshold; the OTHER half — refusing an
// unverified age-restricted order — lives in the shared `completeOrder` seam
// (completion.ts), so every payment rail honors it.
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import { decodeCartMandateParam } from "../cartMandate.js";
import type { RequestLike } from "../origin.js";
import { buildCredentialRequest } from "./request.js";
import { evaluateCredential, requiredAgeForOrder, verifyCredentialPresentation, type CredentialKind, type CredGateResult } from "./verify.js";
import { verifyMdocPresentation } from "./mdoc-verify.js";
import { buildMdocRequestParts, sealMdocContext } from "../mdoc/mdoc-iso.js";
import { mdocDocSpec } from "./doc-spec.js";
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

// The membership discount percent the order applies, re-derived from the re-priced
// order (never the token) — used to surface the membership detail.
function percentFor(order: { discount: number; subtotal: number }): number | undefined {
  return order.discount > 0 && order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : undefined;
}

export const registerCredentialGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only
  // attach when the host app can actually route (CeremonyApp.get/post are optional).
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;

  // GET the gate page — re-priced order, presence-only honesty banner.
  get("/attestomcp/credential", async (req, res) => {
    const kind = parseKind(req.query.cred);
    if (!kind) { res.status(404).type("html").send("<!doctype html><h1>Unknown credential</h1>"); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    res.status(200).type("html").send(
      renderCredentialPage({
        kind,
        order: order.id,
        minimumAge: requiredAgeForOrder(order) ?? undefined,
        total: order.total,
        currency: order.currency,
        percent: percentFor(order),
        cart: typeof req.query.cart === "string" ? req.query.cart : undefined,
      }),
    );
  });

  // GET the REAL request. Offer BOTH protocols; the platform's DC API self-selects
  // the one it supports (Android Chrome → openid4vp, iOS WebKit → org-iso-mdoc).
  get("/attestomcp/credential/request", async (req, res) => {
    const kind = parseKind(req.query.cred);
    if (!kind) { res.status(404).json({ error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    try {
      const minimumAge = kind === "age" ? requiredAgeForOrder(order) ?? 21 : undefined;
      const reqOrigin = originOf(ctx, req);
      const oid = await buildCredentialRequest(kind, reqOrigin, ctx.signingKey, { minimumAge });
      // Signed (reader-authenticated) by default — required by iOS. ?signed=0 forces
      // the unsigned path for diagnostics.
      const signed = req.query.signed !== "0";
      const mdoc = await buildMdocRequestParts(mdocDocSpec(kind, minimumAge ?? 21), reqOrigin.origin, signed);
      const mdocContextToken = await sealMdocContext(
        { readerPrivateJwk: mdoc.readerPrivateJwk, base64EncryptionInfo: mdoc.base64EncryptionInfo },
        ctx.signingKey,
      );
      res.json({
        requests: [
          { protocol: "openid4vp-v1-signed", data: { request: oid.request } },
          { protocol: "org-iso-mdoc", data: mdoc.data },
        ],
        dcql_query: oid.dcql_query,
        readerContextToken: oid.readerContextToken,
        mdocContextToken,
        trust_level: oid.trust_level,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST verify — instant-demo claims OR a real wallet presentation. Resolve +
  // re-price the order (CT3), evaluate the disclosed claims (explicit positive claim
  // — CT4/CT5), write the per-order record on success.
  post("/attestomcp/credential/verify", async (req, res) => {
    const body = await readJsonBody(req);
    const kind = parseKind(body.cred);
    if (!kind) { res.status(404).json({ verified: false, error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined, { cartMandate: (body as { cartMandate?: unknown }).cartMandate ?? decodeCartMandateParam((body as { cart?: unknown }).cart) });
    if (!order) { res.status(400).json({ verified: false, error: "missing or invalid order" }); return; }

    const minimumAge = kind === "age" ? requiredAgeForOrder(order) ?? 21 : undefined;
    const percent = kind === "membership" ? percentFor(order) : undefined;

    try {
      let out: CredGateResult;
      const result = body.result as { protocol?: string; data?: unknown } | undefined;
      if (result && typeof result === "object") {
        // REAL wallet presentation — dispatch by the protocol the wallet used.
        if (result.protocol === "org-iso-mdoc") {
          if (typeof body.mdocContextToken !== "string") {
            res.status(400).json({ verified: false, error: "missing mdocContextToken for org-iso-mdoc" });
            return;
          }
          out = await verifyMdocPresentation({ kind, result, mdocContextToken: body.mdocContextToken, origin: originOf(ctx, req), secret: ctx.signingKey, minimumAge, percent });
        } else {
          if (typeof body.readerContextToken !== "string") {
            res.status(400).json({ verified: false, error: "missing readerContextToken for openid4vp presentation" });
            return;
          }
          out = await verifyCredentialPresentation({ kind, result, readerContextToken: body.readerContextToken, secret: ctx.signingKey, minimumAge, percent });
        }
      } else {
        // Instant-demo claims path (the tested default).
        const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
        out = evaluateCredential(kind, claims, { minimumAge, percent });
      }
      if (out.verified) await recordVerified(ctx, order.id, kind, out.membershipNumber);
      res.json(out);
    } catch (err) {
      res.status(400).json({ verified: false, error: (err as Error).message, trust_level: "presence-only-demo" });
    }
  });
};
