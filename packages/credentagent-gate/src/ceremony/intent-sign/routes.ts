// The intent-sign rail's HTTP endpoints (spec 012), registered by `grants.serve(app)`
// alongside the grant approve page. Keyed by grant id (invariant 4):
//   GET  /credentagent/grants/:id/sign/request  → the signed OpenID4VP request (nonce
//                                                  bound to THIS grant's bounds)
//   POST /credentagent/grants/:id/sign/verify    → verify the device signature; on success
//                                                  authorize the grant with device-signed evidence
//
// The signing PAGE itself is served by the existing GET /credentagent/grants/:id, which
// branches to renderIntentSignPage for a device-mode grant (grants-serve.ts) — so the
// grant's approveUrl IS the signing page (FR-3).
//
// Every endpoint re-derives the grant's bounds from the SERVER's record and refuses if the
// grant is unknown, page-mode, or no longer pending. The verify handler re-derives boundsHash
// server-side and requires equality (verify.ts) before authorizing.
import { deriveOrigin, type Origin, type RequestLike } from "../origin.js";
import { buildIntentSignRequest } from "./request.js";
import { verifyIntentPresentation, memoryNonceGuard } from "./verify.js";
import type { Grants } from "../../grants.js";

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
  json(body: unknown): unknown;
}
type RailHandler = (req: RailRequest, res: RailResponse) => void | Promise<void>;

interface RailApp {
  get?(path: string, ...handlers: unknown[]): unknown;
  post?(path: string, ...handlers: unknown[]): unknown;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function originOf(req: RailRequest): Origin {
  const reqLike: RequestLike = { headers: req.headers, host: firstHeader(req.headers.host) ?? "localhost", protocol: req.protocol };
  return deriveOrigin(reqLike);
}

// Read the JSON body from a host body parser, or straight off the stream when none ran
// (the rail is self-contained — it doesn't require the host to mount express.json()).
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

/** Register the intent-sign endpoints for device-mode grants onto the host app. */
export function registerIntentSignRail(app: RailApp, grants: Grants): void {
  const get = app.get?.bind(app) as ((path: string, ...h: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...h: RailHandler[]) => unknown) | undefined;
  if (!get || !post) return;

  // Single-use nonce ledger, shared across this instance's device grants (invariant 6 /
  // FR-6b). In-process — grant records are process-local too.
  const nonceGuard = memoryNonceGuard();

  get("/credentagent/grants/:id/sign/request", async (req, res) => {
    const id = req.params.id;
    const g = await grants.retrieve(id);
    if (!g || g.signing !== "device") { res.status(404).json({ error: "unknown device grant" }); return; }
    if (g.status !== "pending") { res.status(409).json({ error: `grant is ${g.status}` }); return; }
    const bounds = grants._boundsInputFor(id);
    if (!bounds) { res.status(404).json({ error: "unknown grant" }); return; }
    try {
      const cfg = grants.railConfig;
      const oid = await buildIntentSignRequest({
        bounds,
        origin: originOf(req),
        secret: cfg.secret,
        ...(cfg.readerIdentity ? { readerIdentity: cfg.readerIdentity } : {}),
      });
      res.json({
        requests: [{ protocol: "openid4vp-v1-signed", data: { request: oid.request } }],
        dcql_query: oid.dcql_query,
        readerContextToken: oid.readerContextToken,
        trust_level: oid.trust_level,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  post("/credentagent/grants/:id/sign/verify", async (req, res) => {
    const id = req.params.id;
    const g = await grants.retrieve(id);
    if (!g || g.signing !== "device") { res.status(404).json({ ok: false, reason: "unknown device grant" }); return; }
    const bounds = grants._boundsInputFor(id);
    if (!bounds) { res.status(404).json({ ok: false, reason: "unknown grant" }); return; }
    const body = await readJsonBody(req);
    const result = body.result as { protocol?: string; data?: unknown } | undefined;
    const readerContextToken = body.readerContextToken;
    if (typeof readerContextToken !== "string" || !result || typeof result !== "object") {
      res.status(400).json({ ok: false, reason: "missing readerContextToken or result" });
      return;
    }
    try {
      const cfg = grants.railConfig;
      const out = await verifyIntentPresentation({
        result,
        readerContextToken,
        secret: cfg.secret,
        bounds,
        origin: originOf(req),
        nonceGuard,
      });
      if (!out.ok) { res.status(400).json({ ok: false, reason: out.reason }); return; }
      // Authorize ONLY through the verified-evidence seam — a page-mode or already-sealed
      // grant is refused there (fail-closed).
      const sealed = await grants._authorizeDevice(id, {
        boundsHash: out.boundsHash,
        signedAt: out.signedAt,
        credentialDoctype: out.credentialDoctype,
        verifiedBy: out.verifiedBy,
        trustLevel: out.trustLevel,
      });
      if (!sealed) { res.status(409).json({ ok: false, reason: "grant is not pending" }); return; }
      res.json({ ok: true, status: "authorized", trustLevel: out.trustLevel, verifiedBy: out.verifiedBy, boundsHash: out.boundsHash });
    } catch (err) {
      res.status(400).json({ ok: false, reason: (err as Error).message });
    }
  });
}
