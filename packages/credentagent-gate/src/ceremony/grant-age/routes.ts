// The grant-age rail (issue #172) — prove your age ON THE APPROVE PAGE, before you hand an
// agent a spending grant. Registered onto the host app through the Foundational mount() seam:
//   GET  /credentagent/grants/:id/age          → the age gate page (the human's phone)
//   GET  /credentagent/grants/:id/age/request  → REAL OpenID4VP + org-iso-mdoc requests
//   POST /credentagent/grants/:id/age/verify   → instant-demo claims OR a real presentation
//
// WHY IT EXISTS. A spending grant scoped to "Beverages" over a catalog whose Beverages are all
// 21+ could spend $0.00: every delegated purchase refused `step-up`, and the human had no way to
// unblock it. The approve page is the one moment they are holding their phone with their wallet
// in it — so the age ceremony belongs there, not at a checkout the human will never see.
//
// WHAT IS AND ISN'T DELEGATED. The proof is the HUMAN's, presented by THEIR wallet while they are
// present. It is sealed into the grant's intent at approve time (grants._recordAgeProof →
// _authorize → sealIntent) and covered by the content-addressed intentId. The agent never
// presents a credential and never carries one; it simply spends against bounds that now record
// what the human proved. "Delegate actions, not identity" still holds.
//
// SCOPED PER GRANT, NEVER PROCESS-GLOBAL (invariant 4): every route resolves the grant by the id
// in the URL and writes only that grant's record.
//
// THE THRESHOLD IS SERVER-DERIVED (invariant 5). The age this rail asks for — and records — is
// `grant.ageScope.minimumAge`, re-derived from the grant's sealed `allow` bounds against the
// catalog. A request body can neither choose it nor lower it, and a presentation proving a LOWER
// threshold does not verify: an 18+ proof never opens a 21+ item, here or at spend time.
//
// REUSE, NOT COPY: the request builder, the wallet page, and both verify paths are the credential
// rail's (`../credential-gate/`). Only the routing and what success WRITES differ — the credential
// rail writes a per-order `ageVerified` flag, this one records a per-grant sealed claim.
//
// HONESTY: the wire crypto is real (ES256-signed request, sealed nonce, JWE/ECDH-ES + HPKE
// decrypt, ISO-mdoc parse) but there is NO issuer trust anchor yet — trust_level stays
// "presence-only-demo" and a self-crafted mdoc would pass. This is disclosure + binding, never a
// real safety control, until issuer-verified trust lands (#14).
import type { CeremonyApp, CeremonyContext, RailRegistrar } from "../mount.js";
import type { RequestLike } from "../origin.js";
import { buildCredentialRequest } from "../credential-gate/request.js";
import { evaluateCredential, verifyCredentialPresentation, type CredGateResult } from "../credential-gate/verify.js";
import { verifyMdocPresentation } from "../credential-gate/mdoc-verify.js";
import { mdocDocSpec } from "../credential-gate/doc-spec.js";
import { buildMdocRequestParts, sealMdocContext } from "../mdoc/mdoc-iso.js";
import { renderCredentialPage } from "../credential-gate/page.js";
import type { Grant } from "../../grants.js";

// Minimal structural request/response shapes — the package never imports express (mirrors
// credential-gate/routes.ts).
interface RailRequest {
  params: Record<string, string>;
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

// Read the JSON body from a host-installed parser, or straight off the stream when no parser ran
// (so the rail works whether or not the host mounts express.json()).
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

/**
 * Resolve the grant this route is scoped to AND the age it must prove — both server-side.
 *
 * Fail-closed on three counts, each of which would otherwise be a way to get a proof recorded
 * that the human never meant to give:
 *   • an unknown grant                       → no record to write
 *   • a grant past `pending`                 → consent already happened; it cannot gain powers now
 *   • a scope with nothing age-restricted    → there is no threshold to prove, so there is no
 *                                              ceremony to run (and no claim worth recording)
 */
async function resolveGrantAge(ctx: CeremonyContext, id: string): Promise<{ grant: Grant; minimumAge: number } | null> {
  const grant = await ctx.grants?.retrieve(id);
  if (!grant || grant.status !== "pending") return null;
  const minimumAge = grant.ageScope.minimumAge;
  if (minimumAge == null) return null;
  return { grant, minimumAge };
}

export const registerGrantAgeGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // Self-skip on a route-less app shape (mount()'s fail-fast tests pass a `{ locals }`-only app),
  // and when no grants resource is wired — a host that never uses grants gets no new routes, the
  // same way the delegated payment rail self-skips without a `verifier`.
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post || !ctx.grants) return;

  // Tell the approve page the ceremony is actually reachable, so it renders a live button rather
  // than a link to a 404 for a host that called grants.serve(app) without mount(app).
  ctx.grants._ageRailMounted = true;

  // GET the gate page — the credential rail's page, pointed at this rail's endpoints and back to
  // the approve page, so the human lands where they left off with the proof in hand.
  get("/credentagent/grants/:id/age", async (req, res) => {
    const resolved = await resolveGrantAge(ctx, req.params.id);
    if (!resolved) { res.status(404).type("html").send("<!doctype html><h1>No age check needed for this grant</h1>"); return; }
    const base = `/credentagent/grants/${encodeURIComponent(resolved.grant.id)}/age`;
    res.status(200).type("html").send(
      renderCredentialPage({
        kind: "age",
        // The page echoes this as its `order` field; for this rail it is the GRANT id, and the
        // verify route reads the id from the URL regardless — the body is never trusted.
        order: resolved.grant.id,
        minimumAge: resolved.minimumAge,
        // There is no cart here — the human is deciding what an agent may buy for them later.
        lede: `The spending grant you're about to approve covers age-restricted items. Present a digital ID so we can confirm you are ${resolved.minimumAge} or older — then your agent can buy them while you're away. Nothing is stored, only an over-${resolved.minimumAge} check.`,
        returnUrl: `/credentagent/grants/${encodeURIComponent(resolved.grant.id)}`,
        endpoints: { request: `${base}/request`, verify: `${base}/verify` },
        branding: ctx.branding,
      }),
    );
  });

  // GET the REAL request. Offer BOTH protocols; the platform's DC API self-selects the one it
  // supports (Android Chrome → openid4vp, iOS WebKit → org-iso-mdoc).
  get("/credentagent/grants/:id/age/request", async (req, res) => {
    const resolved = await resolveGrantAge(ctx, req.params.id);
    if (!resolved) { res.status(404).json({ error: "no age check needed for this grant" }); return; }
    try {
      const reqOrigin = originOf(ctx, req);
      // Signed (reader-authenticated) by default — required by iOS. ?signed=0 forces the
      // unsigned path for diagnostics.
      const signed = req.query.signed !== "0";
      const oid = await buildCredentialRequest("age", reqOrigin, ctx.signingKey, { minimumAge: resolved.minimumAge }, ctx.readerIdentity);
      const mdoc = await buildMdocRequestParts(mdocDocSpec("age", resolved.minimumAge), reqOrigin.origin, signed, ctx.readerIdentity);
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

  // POST verify — instant-demo claims OR a real wallet presentation, through the SAME policy the
  // checkout age gate runs. On success the claim is recorded against THIS pending grant; it is
  // sealed into the intent when the human then taps Approve.
  post("/credentagent/grants/:id/age/verify", async (req, res) => {
    const resolved = await resolveGrantAge(ctx, req.params.id);
    if (!resolved) { res.status(404).json({ verified: false, error: "no age check needed for this grant" }); return; }
    const body = await readJsonBody(req);
    // The threshold is the CATALOG-derived one, never the body's (invariant 5). A presentation
    // that only proves a lower bar fails `age.over(N).verify` and records nothing.
    const minimumAge = resolved.minimumAge;

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
          out = await verifyMdocPresentation({ kind: "age", result, mdocContextToken: body.mdocContextToken, origin: originOf(ctx, req), secret: ctx.signingKey, minimumAge });
        } else {
          if (typeof body.readerContextToken !== "string") {
            res.status(400).json({ verified: false, error: "missing readerContextToken for openid4vp presentation" });
            return;
          }
          out = await verifyCredentialPresentation({ kind: "age", result, readerContextToken: body.readerContextToken, secret: ctx.signingKey, minimumAge });
        }
      } else {
        // Instant-demo claims path (the tested default).
        const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
        out = evaluateCredential("age", claims, { minimumAge });
      }
      // Record ONLY the threshold the server demanded and the policy actually confirmed — never a
      // number that arrived with the request.
      if (out.verified && !(await ctx.grants!._recordAgeProof(resolved.grant.id, { provenAge: minimumAge }))) {
        // The grant left `pending` between the resolve above and here (a concurrent approve/deny).
        res.status(409).json({ verified: false, error: "grant is no longer pending", trust_level: "presence-only-demo" });
        return;
      }
      res.json(out);
    } catch (err) {
      res.status(400).json({ verified: false, error: (err as Error).message, trust_level: "presence-only-demo" });
    }
  });
};
