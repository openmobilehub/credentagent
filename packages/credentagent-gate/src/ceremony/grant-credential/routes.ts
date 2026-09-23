// The grant-credential rail (issue #172) — present your credentials ON THE APPROVE PAGE, before
// you hand an agent a spending grant. Registered onto the host app through the mount() seam, one
// set of routes per credential this grant can use:
//   GET  /credentagent/grants/:id/<cred>          → the gate page (the human's phone)
//   GET  /credentagent/grants/:id/<cred>/request  → REAL OpenID4VP + org-iso-mdoc requests
//   POST /credentagent/grants/:id/<cred>/verify   → instant-demo claims OR a real presentation
// where <cred> is `age` or `membership`.
//
// WHY IT EXISTS. A spending grant scoped to "Beverages" over a catalog whose Beverages are all
// 21+ could spend $0.00: every delegated purchase refused `step-up`, and the human had no way to
// unblock it. The approve page is the one moment they are holding their phone with their wallet
// in it — so the ceremony belongs there, not at a checkout the human will never see. The same
// argument carries the loyalty credential: if you are going to prove who you are anyway, that is
// also the moment to claim the discount that follows every purchase the grant makes.
//
// WHAT EACH CREDENTIAL DOES. Age UNLOCKS items the agent would otherwise be refused on;
// membership LOWERS the price of every purchase. Both are OPTIONAL — declining either still
// approves the grant, on the terms the page states.
//
// WHAT IS AND ISN'T DELEGATED. The credential is the HUMAN's, presented by THEIR wallet while
// they are present. It is sealed into the grant's intent at approve time (grants._record*Proof →
// _authorize → sealIntent) and covered by the content-addressed intentId. The agent never
// presents a credential and never carries one; it simply spends against bounds that now record
// what the human proved. "Delegate actions, not identity" still holds.
//
// SCOPED PER GRANT, NEVER PROCESS-GLOBAL (invariant 4): every route resolves the grant by the id
// in the URL and writes only that grant's record.
//
// THE TERMS ARE SERVER-DERIVED (invariant 5). The age threshold is `grant.ageScope.minimumAge`,
// re-derived from the grant's sealed `allow` bounds against the catalog; the discount rate is the
// host's configured `loyaltyDiscountPct`. A request body can choose neither, and a presentation
// proving less than the server demands does not verify: an 18+ proof never opens a 21+ item, and
// a bare token with no membership id never earns the discount.
//
// REUSE, NOT COPY: the request builder, the wallet page, and both verify paths are the credential
// rail's (`../credential-gate/`). Only the routing and what success WRITES differ — the credential
// rail writes per-ORDER verification state, this one records a per-GRANT sealed claim.
//
// HONESTY: the wire crypto is real (ES256-signed request, sealed nonce, JWE/ECDH-ES + HPKE
// decrypt, ISO-mdoc parse) but there is NO issuer trust anchor yet — trust_level stays
// "presence-only-demo" and a self-crafted credential would pass. This is disclosure + binding,
// never a real safety control, until issuer-verified trust lands (#14).
import { deriveOrigin, type RequestLike } from "../origin.js";
import { buildCredentialRequest } from "../credential-gate/request.js";
import { evaluateCredential, verifyCredentialPresentation, type CredGateResult } from "../credential-gate/verify.js";
import { verifyMdocPresentation } from "../credential-gate/mdoc-verify.js";
import { mdocDocSpec } from "../credential-gate/doc-spec.js";
import type { CredentialKind } from "../credential-gate/dcql.js";
import { buildMdocRequestParts, sealMdocContext } from "../mdoc/mdoc-iso.js";
import { renderCredentialPage } from "../credential-gate/page.js";
import type { Grant, Grants } from "../../grants.js";

/** The credentials a grant can carry. Both optional; each has its own routes. */
const GRANT_CREDENTIALS = ["age", "membership"] as const;

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

function originOf(req: RailRequest) {
  const reqLike: RequestLike = { headers: req.headers, host: firstHeader(req.headers.host) ?? "localhost", protocol: req.protocol };
  return deriveOrigin(reqLike);
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

/** What one credential's ceremony needs, all of it resolved SERVER-SIDE. */
interface Resolved {
  grant: Grant;
  /** The age threshold this grant's scope demands (age only). */
  minimumAge?: number;
  /** The discount rate the host's programme offers (membership only). */
  percent?: number;
}

/**
 * Resolve the grant this route is scoped to AND the terms it must prove — both server-side.
 *
 * Fail-closed on three counts, each of which would otherwise be a way to get a claim recorded
 * that the human never meant to give:
 *   • an unknown grant                       → no record to write
 *   • a grant past `pending`                 → consent already happened; it cannot gain terms now
 *   • a credential this grant has no use for → an age step for a scope with nothing restricted,
 *                                              or a membership step with no programme configured,
 *                                              is a ceremony with nothing to prove
 */
async function resolveGrantCred(grants: Grants, id: string, cred: CredentialKind): Promise<Resolved | null> {
  const grant = await grants.retrieve(id);
  if (!grant || grant.status !== "pending") return null;
  if (cred === "age") {
    const minimumAge = grant.ageScope.minimumAge;
    return minimumAge == null ? null : { grant, minimumAge };
  }
  const percent = grants._loyaltyDiscountPct;
  return percent === undefined ? null : { grant, percent };
}

/** The sentence under the title. The built-in copy talks about a CART; there is no cart here —
 *  the human is deciding what an agent may buy for them later, and at what price. */
function ledeFor(cred: CredentialKind, r: Resolved): string {
  return cred === "age"
    ? `The spending grant you're about to approve covers age-restricted items. Present a digital ID so we can confirm you are ${r.minimumAge} or older — then your agent can buy them while you're away. Nothing is stored, only an over-${r.minimumAge} check.`
    : `Present your membership credential to take ${r.percent}% off every purchase your agent makes under this grant. Optional — the grant works without it.`;
}

/** The structural app shape this rail registers on (mirrors the intent-sign rail). */
export interface CredentialRailApp {
  get?(path: string, ...handlers: unknown[]): unknown;
  post?(path: string, ...handlers: unknown[]): unknown;
}

export function registerGrantCredentialGate(app: CredentialRailApp, grants: Grants): void {
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;
  const cfg = grants.railConfig;

  for (const cred of GRANT_CREDENTIALS) {
    const base = `/credentagent/grants/:id/${cred}`;

    // GET the gate page — the credential rail's page, pointed at this rail's endpoints and back to
    // the approve page, so the human lands where they left off with the claim in hand.
    get(base, async (req, res) => {
      const r = await resolveGrantCred(grants, req.params.id, cred);
      if (!r) { res.status(404).type("html").send(`<!doctype html><h1>This grant has no ${cred} step</h1>`); return; }
      const urls = `/credentagent/grants/${encodeURIComponent(r.grant.id)}/${cred}`;
      res.status(200).type("html").send(
        renderCredentialPage({
          kind: cred,
          // The page echoes this as its `order` field; for this rail it is the GRANT id, and the
          // verify route reads the id from the URL regardless — the body is never trusted.
          order: r.grant.id,
          ...(r.minimumAge != null ? { minimumAge: r.minimumAge } : {}),
          ...(r.percent != null ? { percent: r.percent } : {}),
          lede: ledeFor(cred, r),
          returnUrl: `/credentagent/grants/${encodeURIComponent(r.grant.id)}`,
          endpoints: { request: `${urls}/request`, verify: `${urls}/verify` },
          ...(cfg.branding ? { branding: cfg.branding } : {}),
        }),
      );
    });

    // GET the REAL request. Offer BOTH protocols; the platform's DC API self-selects the one it
    // supports (Android Chrome → openid4vp, iOS WebKit → org-iso-mdoc).
    get(`${base}/request`, async (req, res) => {
      const r = await resolveGrantCred(grants, req.params.id, cred);
      if (!r) { res.status(404).json({ error: `this grant has no ${cred} step` }); return; }
      try {
        const reqOrigin = originOf(req);
        // Signed (reader-authenticated) by default — required by iOS. ?signed=0 forces the
        // unsigned path for diagnostics.
        const signed = req.query.signed !== "0";
        const oid = await buildCredentialRequest(cred, reqOrigin, cfg.secret, { minimumAge: r.minimumAge, percent: r.percent }, cfg.readerIdentity);
        const mdoc = await buildMdocRequestParts(mdocDocSpec(cred, r.minimumAge ?? 21), reqOrigin.origin, signed, cfg.readerIdentity);
        const mdocContextToken = await sealMdocContext(
          { readerPrivateJwk: mdoc.readerPrivateJwk, base64EncryptionInfo: mdoc.base64EncryptionInfo },
          cfg.secret,
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
    // checkout gates run. On success the claim is recorded against THIS pending grant; it is
    // sealed into the intent when the human then taps Approve.
    post(`${base}/verify`, async (req, res) => {
      const r = await resolveGrantCred(grants, req.params.id, cred);
      if (!r) { res.status(404).json({ verified: false, error: `this grant has no ${cred} step` }); return; }
      const body = await readJsonBody(req);
      // The terms are the SERVER's, never the body's (invariant 5). A presentation that only
      // clears a lower bar fails the policy and records nothing.
      const { minimumAge, percent } = r;

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
            out = await verifyMdocPresentation({ kind: cred, result, mdocContextToken: body.mdocContextToken, origin: originOf(req), secret: cfg.secret, minimumAge, percent });
          } else {
            if (typeof body.readerContextToken !== "string") {
              res.status(400).json({ verified: false, error: "missing readerContextToken for openid4vp presentation" });
              return;
            }
            out = await verifyCredentialPresentation({ kind: cred, result, readerContextToken: body.readerContextToken, secret: cfg.secret, minimumAge, percent });
          }
        } else {
          // Instant-demo claims path (the tested default).
          const claims = (body.claims && typeof body.claims === "object" ? body.claims : {}) as Record<string, unknown>;
          out = evaluateCredential(cred, claims, { minimumAge, percent });
        }

        if (out.verified) {
          // Record ONLY what the server demanded and the policy actually confirmed — never a
          // threshold or a rate that arrived with the request.
          const recorded =
            cred === "age"
              ? await grants._recordAgeProof(r.grant.id, { provenAge: minimumAge! })
              : await grants._recordMembershipProof(r.grant.id, { membershipNumber: out.membershipNumber! });
          if (!recorded) {
            // The grant left `pending` between the resolve above and here (a concurrent approve).
            res.status(409).json({ verified: false, error: "grant is no longer pending", trust_level: "presence-only-demo" });
            return;
          }
        }
        res.json(out);
      } catch (err) {
        res.status(400).json({ verified: false, error: (err as Error).message, trust_level: "presence-only-demo" });
      }
    });
  }
}
