// credentagent.webhooks — the REAL HTTP completion signal (spec 010, under #97).
//
// `on("order.settled", …)` is an IN-PROCESS listener: same process only, gone on restart. This is
// the durable, cross-service arm: when an order settles, the gate POSTs a SIGNED event to the
// endpoint URLs you registered, and the receiver verifies it with one call — the Stripe idiom:
//
//   // sending — configure once:
//   new CredentAgent({ webhooks: { endpoints: [{ url, secret }] } });
//   // …order settles → a signed order.settled POST lands at url.
//
//   // receiving — a DIFFERENT service, only the shared secret needed:
//   const event = constructEvent(rawBody, req.get("CredentAgent-Signature"), secret); // throws if forged
//
// The signature is a SECURITY control (spec §Security): HMAC-SHA256 over `${t}.${rawBody}`, the
// timestamp bound into the MAC, constant-time compare, replay-window bound. A forged, tampered,
// wrong-secret, or stale event is refused. Delivery is at-least-once + retried; dedupe on event.id.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/** The header carrying the signature — `t=<unix>,v1=<hex hmac-sha256>` (Stripe-shaped). */
export const SIGNATURE_HEADER = "CredentAgent-Signature";
/** Replay window: an event whose timestamp is older/newer than this is refused (invariant-6 analogue). */
export const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_RETRIES = 3;
/** Per-attempt delivery bound: a receiver that accepts but never responds counts as a failed attempt. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Hosts where plain http is allowed (local dev). Everywhere else the SSRF stance requires https.
 *  An immutable module-level lookup (not per-order state) — typed ReadonlySet per the invariant-4 rule. */
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Enforce the SSRF boundary where endpoints enter (constructor + `register()`): https, or http on localhost. */
function assertEndpointUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`webhook endpoint url is not a valid URL: ${JSON.stringify(url)}`);
  }
  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost");
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalhost)) return;
  throw new TypeError(`webhook endpoint url must be https (http is allowed only for localhost dev): ${JSON.stringify(url)}`);
}

/** The Stripe-shaped event envelope. `data.object` is the settled resource (a CompletedOrder). */
export interface WebhookEvent<T = unknown> {
  /** Stable per event — dedupe on this (delivery is at-least-once). */
  id: string;
  /** Today only `"order.settled"`; a union as more lifecycle events land. */
  type: "order.settled";
  /** Unix seconds the event was created. */
  created: number;
  data: { object: T };
}

/** A registered destination. `secret` is `whsec_…`; `events` filters types (default: all). */
export interface WebhookEndpoint {
  url: string;
  secret: string;
  events?: string[];
}

/** Why a signature check refused — one taxonomy for both doors. */
export type WebhookRefusalCode = "no-signature" | "bad-format" | "no-match" | "timestamp";

/** The Stripe-door error: `constructEvent` throws this; it still carries an actionable `code`. */
export class WebhookSignatureError extends Error {
  readonly code: WebhookRefusalCode;
  constructor(code: WebhookRefusalCode, message: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.code = code;
  }
}

/** The repo-native door — shaped like `OrderDoor` / `CartMandateVerdict`; never throws. */
export type WebhookVerdict<T = unknown> =
  | { ok: true; event: WebhookEvent<T> }
  | { ok: false; code: WebhookRefusalCode; reason: string };

export interface VerifyOptions {
  /** Replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Injectable clock (ms), for tests. Default `Date.now`. */
  now?: () => number;
}

/** Mint an endpoint secret: `whsec_` + base64url(32 random bytes). Store it; share it with the receiver. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function toRaw(body: string | Buffer | Uint8Array): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

/** Compute the `t=…,v1=…` header value for a raw body signed with `secret` at `timestamp` (unix s). */
export function signPayload(rawBody: string | Buffer | Uint8Array, secret: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${toRaw(rawBody)}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify a signed webhook body — the repo-native door: returns a verdict, never throws.
 * Constant-time and fail-closed. `secret` alone is enough (a receiver needs no CredentAgent).
 */
export function verifyEvent<T = unknown>(
  rawBody: string | Buffer | Uint8Array,
  sigHeader: string | undefined | null,
  secret: string,
  opts: VerifyOptions = {},
): WebhookVerdict<T> {
  if (!sigHeader) return { ok: false, code: "no-signature", reason: `missing ${SIGNATURE_HEADER} header` };

  // Parse `t=<unix>,v1=<hex>[,v1=<hex>…]` — multiple v1 = secret rotation (sign with old+new, verify any).
  let t: number | undefined;
  const v1s: string[] = [];
  for (const part of sigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) v1s.push(v);
  }
  if (t === undefined || !Number.isFinite(t) || v1s.length === 0) {
    return { ok: false, code: "bad-format", reason: "malformed signature header (need t=… and v1=…)" };
  }

  // Recompute over `${t}.${rawBody}` — t is INSIDE the MAC, so a backdated t breaks the signature.
  const raw = toRaw(rawBody);
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex"), "hex");
  const matched = v1s.some((v) => {
    let got: Buffer;
    try { got = Buffer.from(v, "hex"); } catch { return false; }
    return got.length === expected.length && timingSafeEqual(got, expected); // constant-time, equal-length only
  });
  if (!matched) return { ok: false, code: "no-match", reason: "no signature matched the secret" };

  // Replay bound: reject a t outside the tolerance window (checked AFTER the MAC, on a trusted t).
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - t) > tolerance) {
    return { ok: false, code: "timestamp", reason: `timestamp ${t} outside ±${tolerance}s of ${nowSec} (replay)` };
  }

  let event: WebhookEvent<T>;
  try { event = JSON.parse(raw) as WebhookEvent<T>; } catch { return { ok: false, code: "bad-format", reason: "body is not valid JSON" }; }
  return { ok: true, event };
}

/**
 * Verify a signed webhook body — the Stripe door: returns the typed event or THROWS
 * `WebhookSignatureError`. `constructEvent(...)` is exactly `verifyEvent(...)` + throw-on-refusal.
 */
export function constructEvent<T = unknown>(
  rawBody: string | Buffer | Uint8Array,
  sigHeader: string | undefined | null,
  secret: string,
  opts?: VerifyOptions,
): WebhookEvent<T> {
  const v = verifyEvent<T>(rawBody, sigHeader, secret, opts);
  if (!v.ok) throw new WebhookSignatureError(v.code, v.reason);
  return v.event;
}

/** One attempt at delivering a signed body to a URL. Default = global `fetch`; injectable for tests. */
export type WebhookTransport = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export interface WebhookOptions {
  /** Static endpoints (env secrets) — correct across instances, the multi-instance path. */
  endpoints?: WebhookEndpoint[];
  /** Delivery attempts before giving up (default 3). */
  retries?: number;
  /** Per-attempt timeout in ms — a stalled receiver is aborted, retried, and reported (default 10_000). */
  timeoutMs?: number;
  /** Replay tolerance passed to receivers' verify (informational default; receivers set their own). */
  toleranceSeconds?: number;
  /** Injectable HTTP transport (default global fetch). */
  transport?: WebhookTransport;
  /** Injectable clock (ms) for `created`/backoff, for tests. */
  now?: () => number;
  /** Injectable sleep (ms) between retries, for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Called when an endpoint exhausts its retries (observability; never receives the secret). */
  onDeliveryError?: (info: { url: string; eventId: string; attempts: number; lastStatus?: number; error?: unknown }) => void;
}

const realFetch: WebhookTransport = async (url, init) => {
  // `redirect: "manual"` is the SSRF stance: a 3xx is surfaced as-is (a failed attempt), never followed —
  // a compromised endpoint must not be able to bounce delivery traffic to an internal host.
  const res = await (globalThis.fetch as typeof fetch)(url, { ...init, redirect: "manual" });
  return { status: res.status };
};
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rejects with the abort reason when `signal` fires — bounds even a transport that ignores `signal`. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * The sender + registry, exposed as `credentagent.webhooks`. Fans a settled order out to every
 * subscribed endpoint as a SIGNED event, retried with backoff, and NEVER blocking the completion
 * that triggered it. Also carries the `constructEvent` / `verifyEvent` convenience (they delegate
 * to the standalone core, so a receiver can verify without a CredentAgent).
 */
export class Webhooks {
  private endpoints: WebhookEndpoint[];
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly transport: WebhookTransport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDeliveryError?: WebhookOptions["onDeliveryError"];

  constructor(opts: WebhookOptions = {}) {
    this.endpoints = [...(opts.endpoints ?? [])];
    for (const e of this.endpoints) assertEndpointUrl(e.url);
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = opts.transport ?? realFetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.onDeliveryError = opts.onDeliveryError;
  }

  /** Any endpoint configured? (delivery is skipped entirely when not — additive, zero-cost). */
  get enabled(): boolean {
    return this.endpoints.length > 0;
  }

  /**
   * Add an endpoint at runtime and mint its secret (Stripe's `webhookEndpoints.create`). The secret
   * is RETURNED once — store it on the receiver. NOTE: this mutates THIS instance only; for a
   * multi-instance deploy, put endpoints in `new CredentAgent({ webhooks: { endpoints } })` so every
   * instance signs alike.
   */
  register(input: { url: string; events?: string[]; secret?: string }): { id: string; url: string; secret: string } {
    assertEndpointUrl(input.url);
    const secret = input.secret ?? generateWebhookSecret();
    const id = `whep_${randomBytes(12).toString("hex")}`;
    const endpoint: WebhookEndpoint = { url: input.url, secret, ...(input.events ? { events: input.events } : {}) };
    this.endpoints.push(endpoint);
    return { id, url: input.url, secret };
  }

  /** Verify convenience (delegates to the standalone `constructEvent` — the Stripe door, throws). */
  constructEvent<T = unknown>(rawBody: string | Buffer | Uint8Array, sigHeader: string | undefined | null, secret: string, opts?: VerifyOptions): WebhookEvent<T> {
    return constructEvent<T>(rawBody, sigHeader, secret, opts);
  }

  /** Verify convenience (delegates to the standalone `verifyEvent` — the verdict door, never throws). */
  verifyEvent<T = unknown>(rawBody: string | Buffer | Uint8Array, sigHeader: string | undefined | null, secret: string, opts?: VerifyOptions): WebhookVerdict<T> {
    return verifyEvent<T>(rawBody, sigHeader, secret, opts);
  }

  /**
   * Fan a lifecycle event out to every subscribed endpoint. Fire-and-forget from the completion
   * path — the returned promise resolves after all attempts, but the caller does NOT await it, so a
   * slow/dead receiver never blocks or rolls back a settled order. At-least-once with exponential
   * backoff (250ms × 2^n); dedupe on `event.id`.
   */
  async deliver<T>(type: WebhookEvent["type"], object: T): Promise<void> {
    if (!this.enabled) return;
    const event: WebhookEvent<T> = {
      id: `evt_${randomBytes(12).toString("hex")}`,
      type,
      created: Math.floor(this.now() / 1000),
      data: { object },
    };
    const body = JSON.stringify(event);
    const targets = this.endpoints.filter((e) => !e.events || e.events.includes(type));
    await Promise.all(targets.map((endpoint) => this.deliverTo(endpoint, event.id, body)));
  }

  private async deliverTo(endpoint: WebhookEndpoint, eventId: string, body: string): Promise<void> {
    let lastStatus: number | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(250 * 2 ** (attempt - 1)); // 250, 500, 1000, …
      const t = Math.floor(this.now() / 1000);
      // Bound the attempt: abort the request at timeoutMs AND race the transport against the abort, so
      // a receiver that accepts but never responds becomes a failed attempt (retried, then reported) —
      // it can never leave this promise pending forever.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`webhook delivery attempt timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      try {
        const res = await Promise.race([
          this.transport(endpoint.url, {
            method: "POST",
            headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signPayload(body, endpoint.secret, t) },
            body,
            signal: controller.signal,
          }),
          abortRejection(controller.signal),
        ]);
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) return; // delivered (a 3xx is NOT followed — see realFetch)
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    // Exhausted — surface for observability; never throw (delivery must not affect completion).
    this.onDeliveryError?.({ url: endpoint.url, eventId, attempts: this.retries + 1, ...(lastStatus !== undefined ? { lastStatus } : {}), ...(lastError !== undefined ? { error: lastError } : {}) });
  }
}
