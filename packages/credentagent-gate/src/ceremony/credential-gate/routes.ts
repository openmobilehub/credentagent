// The credential-gate rail (age + membership) — the GDC-hero MVP. Registers its
// routes onto the host app through the Foundational mount() seam:
//   GET  /credentagent/credential?order=<id>&cred=<age|membership>  → the gate page
//   GET  /credentagent/credential/request?order=<id>&cred=<…>       → REAL OpenID4VP + org-iso-mdoc requests
//   POST /credentagent/credential/verify                            → instant-demo claims OR a real presentation
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
import { RESERVED_CREDENTIAL_IDS, claimLeaf } from "../../credentials.js";
import type { Credential } from "../../types.js";
import type { RequestLike } from "../origin.js";
import { buildCredentialRequest, buildSignedRequestForDcql } from "./request.js";
import { evaluateCredential, evaluateCustom, requiredAgeForOrder, verifyCredentialPresentation, type CredentialKind, type CredGateResult } from "./verify.js";
import { verifyMdocPresentation } from "./mdoc-verify.js";
import { buildMdocRequestParts, sealMdocContext } from "../mdoc/mdoc-iso.js";
import { mdocDocSpec, mdocDocSpecsFromDcql } from "./doc-spec.js";
import { renderCredentialPage } from "./page.js";
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

// Resolve the `cred` param to a built-in kind OR a registered custom credential (007).
// A built-in id (age/membership) takes the existing order-parameterized path; any other
// id is served ONLY if it's a non-reserved credential the registry holds (a custom
// credential resolved by requirements()); an unknown id resolves to null (→ 404), never
// silently served (FR-013).
type ResolvedCred = { kind: CredentialKind; credential?: undefined } | { kind?: undefined; credential: Credential };
function resolveCred(ctx: CeremonyContext, raw: unknown): ResolvedCred | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "age" || value === "membership") return { kind: value };
  if (typeof value === "string" && !RESERVED_CREDENTIAL_IDS.has(value)) {
    const credential = ctx.credentialRegistry?.get(value);
    if (credential) return { credential };
  }
  return null;
}

// The canonical positive claim a custom credential's instant-demo button presents,
// derived from the credential's OWN requested claim leaves → true. It goes through the
// SAME server-side `verify` as a real wallet presentation, so a boolean positive claim
// (e.g. `license_active === true`) passes and the control still holds (invariant 5).
function demoClaimsFor(credential: Credential): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const c of credential.request.credentials) {
    for (const cl of c.claims) {
      const leaf = claimLeaf(cl.path);
      if (typeof leaf === "string") claims[leaf] = true;
    }
  }
  return claims;
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

// Persist a successful CUSTOM gate verification, scoped to THIS order (invariant 4).
// `completeOrder` reads `verifiedGates[credId]` to enforce the gate on every completion
// path (007). Merges into any existing map so multiple custom gates on one order each
// record independently.
async function recordVerifiedGate(ctx: CeremonyContext, orderId: string, credId: string): Promise<void> {
  const prev = (await ctx.verificationStore.read(orderId)) ?? {};
  const verifiedGates = { ...(prev as { verifiedGates?: Record<string, true> }).verifiedGates, [credId]: true as const };
  await ctx.verificationStore.write(orderId, { ...prev, verifiedGates });
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
  get("/credentagent/credential", async (req, res) => {
    const resolved = resolveCred(ctx, req.query.cred);
    if (!resolved) { res.status(404).type("html").send("<!doctype html><h1>Unknown credential</h1>"); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    const cart = typeof req.query.cart === "string" ? req.query.cart : undefined;
    // Order-derived stepper with THIS gate current — only the gates the order actually has,
    // Age ✓ only when truly verified (from the store), never a hardcoded Age · Membership · Pay.
    const verified = (await ctx.verificationStore.read(order.id)) ?? {};
    const ageVerified = verified.ageVerified === true;
    if (resolved.credential) {
      // Custom credential (007): render from its own ui + a demo claim derived from its request.
      res.status(200).type("html").send(
        renderCredentialPage({
          kind: resolved.credential.id,
          order: order.id,
          total: order.total,
          currency: order.currency,
          label: resolved.credential.ui.label,
          action: resolved.credential.ui.action,
          demoClaims: demoClaimsFor(resolved.credential),
          cart,
          rail: checkoutRail(order, resolved.credential.id, { ageVerified, currentLabel: resolved.credential.ui.label }),
        }),
      );
      return;
    }
    res.status(200).type("html").send(
      renderCredentialPage({
        kind: resolved.kind,
        order: order.id,
        minimumAge: requiredAgeForOrder(order) ?? undefined,
        total: order.total,
        currency: order.currency,
        percent: percentFor(order),
        cart,
        rail: checkoutRail(order, resolved.kind, { ageVerified }),
      }),
    );
  });

  // GET the REAL request. Offer BOTH protocols; the platform's DC API self-selects
  // the one it supports (Android Chrome → openid4vp, iOS WebKit → org-iso-mdoc).
  get("/credentagent/credential/request", async (req, res) => {
    const resolved = resolveCred(ctx, req.query.cred);
    if (!resolved) { res.status(404).json({ error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    try {
      const reqOrigin = originOf(ctx, req);
      // Signed (reader-authenticated) by default — required by iOS. ?signed=0 forces
      // the unsigned path for diagnostics.
      const signed = req.query.signed !== "0";
      // A custom credential embeds its OWN request DCQL + doctype (007); a built-in uses
      // the age/membership order-parameterized builders. Same signer + crypto either way.
      const oid = resolved.credential
        ? await buildSignedRequestForDcql(resolved.credential.request, reqOrigin, ctx.signingKey, ctx.readerIdentity)
        : await buildCredentialRequest(resolved.kind, reqOrigin, ctx.signingKey, { minimumAge: resolved.kind === "age" ? requiredAgeForOrder(order) ?? 21 : undefined }, ctx.readerIdentity);
      const docSpec = resolved.credential
        ? mdocDocSpecsFromDcql(resolved.credential.request) // every credential → one iOS doc spec (item 6)
        : mdocDocSpec(resolved.kind, resolved.kind === "age" ? requiredAgeForOrder(order) ?? 21 : 21);
      const mdoc = await buildMdocRequestParts(docSpec, reqOrigin.origin, signed);
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
  post("/credentagent/credential/verify", async (req, res) => {
    const body = await readJsonBody(req);
    const resolved = resolveCred(ctx, body.cred);
    if (!resolved) { res.status(404).json({ verified: false, error: "unknown credential" }); return; }
    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined, { cartMandate: (body as { cartMandate?: unknown }).cartMandate ?? decodeCartMandateParam((body as { cart?: unknown }).cart) });
    if (!order) { res.status(400).json({ verified: false, error: "missing or invalid order" }); return; }

    const credential = resolved.credential;
    // `kind` only shapes the built-in path; when a custom credential is resolved it is a
    // harmless placeholder (the credential path runs its own verify below).
    const kind: CredentialKind = resolved.kind ?? "age";
    const minimumAge = resolved.kind === "age" ? requiredAgeForOrder(order) ?? 21 : undefined;
    const percent = resolved.kind === "membership" ? percentFor(order) : undefined;

    try {
      let out: CredGateResult;
      const result = body.result as { protocol?: string; data?: unknown } | undefined;
      if (result && typeof result === "object") {
        // REAL wallet presentation — dispatch by the protocol the wallet used. A custom
        // credential runs its OWN verify on the disclosed claims (007); built-ins keep
        // the age/membership policy.
        if (result.protocol === "org-iso-mdoc") {
          if (typeof body.mdocContextToken !== "string") {
            res.status(400).json({ verified: false, error: "missing mdocContextToken for org-iso-mdoc" });
            return;
          }
          out = await verifyMdocPresentation({ kind, result, mdocContextToken: body.mdocContextToken, origin: originOf(ctx, req), secret: ctx.signingKey, minimumAge, percent, credential });
        } else {
          if (typeof body.readerContextToken !== "string") {
            res.status(400).json({ verified: false, error: "missing readerContextToken for openid4vp presentation" });
            return;
          }
          out = await verifyCredentialPresentation({ kind, result, readerContextToken: body.readerContextToken, secret: ctx.signingKey, minimumAge, percent, credential });
        }
      } else {
        // Instant-demo claims path (the tested default).
        const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
        out = credential ? evaluateCustom(credential, claims) : evaluateCredential(kind, claims, { minimumAge, percent });
      }
      if (out.verified) {
        if (credential) await recordVerifiedGate(ctx, order.id, credential.id);
        else await recordVerified(ctx, order.id, kind, out.membershipNumber);
      }
      res.json(out);
    } catch (err) {
      res.status(400).json({ verified: false, error: (err as Error).message, trust_level: "presence-only-demo" });
    }
  });
};
