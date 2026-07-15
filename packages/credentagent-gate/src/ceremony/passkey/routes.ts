// The passkey payment rail (US2) — same-device (Touch ID / Windows Hello) and
// cross-device (FIDO caBLE). Registers its routes onto the host app through the
// Foundational mount() seam:
//   GET  /credentagent/passkey?order=<id>[&xdev=1]   → the authorize page (xdev toggle)
//   GET  /credentagent/passkey/options[?xdev=1]      → WebAuthn options + signed challenge token
//   POST /credentagent/passkey/verify                → verify assertion → four gates → completeOrder
//   GET  /credentagent/lib/sw/*                       → @simplewebauthn/browser ESM, same-origin
//
// Dependency-free (no `express` import — invariant from mount.ts): handlers are
// registered against the structural CeremonyApp.get/post/use, the verify body is
// read either from a host-installed parser (`req.body`) or off the request stream,
// and the browser ESM is served from disk (no `express.static`).
//
// EVERY route resolves the order by id THROUGH `resolveOrder` (catalog re-pricing;
// a tampered/unknown id is refused — CT3, invariant 2). Completion runs through the
// SHARED `completeOrder` seam (ctx.completion) — the same path dc-payment uses — so
// re-pricing, the age gate, settlement, and state-clearing behave identically
// across rails (FR-008). WebAuthn stays bound to this server's origin/RP-ID with a
// sealed, time-limited, single-use challenge (FR-007, invariant 6).
//
// Trust is PRESENCE-ONLY (Principle VII / FR-011): the WebAuthn flow is real, but
// the mandate is dev-signed — a flow demo, not a real safety control.
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveOrder, type CeremonyApp, type CeremonyContext, type RailRegistrar } from "../mount.js";
import { decodeCartMandateParam } from "../cartMandate.js";
import type { RequestLike } from "../origin.js";
import type { CompletionInput } from "../types.js";
import { buildPasskeyMandate, buildBindingFields, runGates } from "../mandate.js";
import { buildRegistrationOptions, verifyPasskeyAssertion } from "./verify.js";
import { renderPasskeyPage } from "./page.js";
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

// Static-serve shapes (the `use`-mounted ESM handler) — Express strips the mount
// prefix, so `req.path` is the sub-path within the served directory.
interface StaticRequest {
  path?: string;
  url?: string;
}
type StaticHandler = (req: StaticRequest, res: RailResponse) => void;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function originOf(ctx: CeremonyContext, req: RailRequest) {
  const reqLike: RequestLike = { headers: req.headers, host: firstHeader(req.headers.host) ?? "localhost", protocol: req.protocol };
  return ctx.origin(reqLike);
}

function isCrossDevice(raw: unknown): boolean {
  return (Array.isArray(raw) ? raw[0] : raw) === "1";
}

// Read the JSON body from a host-installed parser, or straight off the stream when
// no parser ran (so the rail is self-contained — it doesn't require express.json()).
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

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".ts": "text/plain",
};

// Resolve @simplewebauthn/browser's ESM dir (its `main` is script/index.js; walk
// up two levels to the package root, then into /esm). Fail LOUDLY at wire-up if the
// layout changed, rather than silently 404-ing the browser module at runtime.
function resolveBrowserEsmDir(): string {
  const requireFrom = createRequire(import.meta.url);
  const scriptIndexPath = requireFrom.resolve("@simplewebauthn/browser");
  const dir = path.join(path.dirname(path.dirname(scriptIndexPath)), "esm");
  if (!existsSync(path.join(dir, "index.js"))) {
    throw new Error(`[credentagent] @simplewebauthn/browser ESM not found at ${dir}`);
  }
  return dir;
}

export const registerPasskeyGate: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  // The Foundational fail-fast tests mount() with a route-less app shape; only
  // attach when the host app can actually route.
  const get = app.get?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const post = app.post?.bind(app) as ((path: string, ...handlers: RailHandler[]) => unknown) | undefined;
  const use = app.use?.bind(app) as ((path: string, ...handlers: StaticHandler[]) => unknown) | undefined;
  if (!get || !post || !use) return;

  // Serve @simplewebauthn/browser ESM same-origin (no CDN) — dependency-free file
  // serving with path-traversal containment.
  const browserEsmDir = resolveBrowserEsmDir();
  use("/credentagent/lib/sw", (req, res) => {
    const rel = (req.path ?? req.url ?? "/").split("?")[0];
    const filePath = path.resolve(browserEsmDir, "." + rel);
    // Containment: a resolved path must stay inside the served ESM directory.
    if (filePath !== browserEsmDir && !filePath.startsWith(browserEsmDir + path.sep)) {
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    const mime = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    res.status(200).type(mime).send(readFileSync(filePath, "utf8"));
  });

  // GET the authorize page — re-priced order, presence-only honesty banner.
  get("/credentagent/passkey", async (req, res) => {
    const order = await resolveOrder(ctx, typeof req.query.order === "string" ? req.query.order : undefined, { cartMandate: decodeCartMandateParam(req.query.cart) });
    if (!order) { res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>"); return; }
    // Order-derived stepper with Pay current: reflects only the gates THIS order has, and
    // shows Age ✓ only when it was ACTUALLY verified (read from the store) — never hardcoded.
    const verified = (await ctx.verificationStore.read(order.id)) ?? {};
    const rail = checkoutRail(order, "pay", { ageVerified: verified.ageVerified === true });
    try {
      res.status(200).type("html").send(renderPasskeyPage({ order, crossDevice: isCrossDevice(req.query.xdev), cart: typeof req.query.cart === "string" ? req.query.cart : undefined, rail }));
    } catch {
      // A hand-edited order can carry a bad currency that throws in Intl; never 500.
      res.status(404).type("html").send("<!doctype html><h1>Order not found</h1>");
    }
  });

  // GET WebAuthn options + a signed challenge token (order-independent — the
  // challenge binds to this origin/RP-ID, the order is bound at verify).
  get("/credentagent/passkey/options", async (req, res) => {
    const { options, challengeToken } = await buildRegistrationOptions(originOf(ctx, req), ctx.signingKey, {
      crossDevice: isCrossDevice(req.query.xdev),
    });
    res.json({ options, challengeToken });
  });

  // POST verify — recover the nonce, verify the assertion against this origin/RP-ID,
  // build the AP2 mandate, run the four deterministic gates, and complete through
  // the SHARED completeOrder seam (re-price + age gate + idempotent record).
  post("/credentagent/passkey/verify", async (req, res) => {
    const body = await readJsonBody(req);
    const cartMandate = (body as { cartMandate?: unknown }).cartMandate ?? decodeCartMandateParam((body as { cart?: unknown }).cart);
    const order = await resolveOrder(ctx, typeof body.order === "string" ? body.order : undefined, { cartMandate });
    if (!order) { res.status(400).json({ completed: false, error: "missing or invalid order" }); return; }
    try {
      const origin = originOf(ctx, req);
      const authenticator = await verifyPasskeyAssertion({
        response: body.response as never,
        challengeToken: String(body.challengeToken ?? ""),
        origin,
        secret: ctx.signingKey,
      });
      const mandate = buildPasskeyMandate({ order, authenticator, origin });
      const gates = runGates(mandate);
      const completion = await ctx.completion({
        order,
        mandateId: mandate.id,
        amount: mandate.payment.amount,
        currency: mandate.payment.currency,
        method: "passkey",
        instrument: { issuer: mandate.payment.instrument, maskedAccount: mandate.payment.instrumentReference, holder: null },
        gates: gates.map((g) => ({ gate: g.gate, pass: g.pass, detail: g.detail })),
        ...(cartMandate !== undefined ? { cartMandate: cartMandate as CompletionInput["cartMandate"] } : {}),
      });
      res.json({
        mandate,
        gates,
        completed: completion.completed,
        settlement: completion.settlement ?? null,
        settlementError: completion.settlementError ?? null,
        reason: completion.reason ?? null,
        binding: buildBindingFields(order, origin),
        trust_level: "presence-only-demo",
      });
    } catch (err) {
      res.status(400).json({ completed: false, error: (err as Error).message });
    }
  });
};
