import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  constructEvent,
  verifyEvent,
  generateWebhookSecret,
  signPayload,
  Webhooks,
  WebhookSignatureError,
  SIGNATURE_HEADER,
} from "./webhooks.js";
import { CredentAgent } from "./client.js";

// A fixed clock so timestamps are deterministic. NOW_MS → t = 1_700_000_000 s.
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const T = Math.floor(NOW_MS / 1000);

const secret = "whsec_test_0123456789";
const event = { id: "evt_1", type: "order.settled", created: T, data: { object: { orderId: "ord_1", amount: 500, currency: "USD" } } };
const body = JSON.stringify(event);
const sign = (b = body, s = secret, t = T) => signPayload(b, s, t);

describe("webhooks — verify (the security door)", () => {
  it("POSITIVE CONTROL: a correctly-signed body within tolerance verifies + returns the typed event", () => {
    const ev = constructEvent(body, sign(), secret, { now });
    expect(ev.type).toBe("order.settled");
    expect(ev.data.object.orderId).toBe("ord_1");
    expect(verifyEvent(body, sign(), secret, { now })).toMatchObject({ ok: true });
  });

  // BYPASS 1 — wrong secret. Remove the timingSafeEqual match check and this passes a forged event.
  it("BYPASS: a signature made with the WRONG secret is rejected (no-match)", () => {
    const forged = signPayload(body, "whsec_attacker", T);
    expect(() => constructEvent(body, forged, secret, { now })).toThrow(WebhookSignatureError);
    expect(verifyEvent(body, forged, secret, { now })).toMatchObject({ ok: false, code: "no-match" });
  });

  // BYPASS 2 — tampered body. The signature was over the ORIGINAL bytes; a flipped byte no longer matches.
  it("BYPASS: a body tampered after signing is rejected (no-match)", () => {
    const goodHeader = sign(); // signed over the original body
    const tampered = body.replace('"amount":500', '"amount":5'); // attacker lowers the price
    expect(verifyEvent(tampered, goodHeader, secret, { now })).toMatchObject({ ok: false, code: "no-match" });
    expect(() => constructEvent(tampered, goodHeader, secret, { now })).toThrow(/no signature matched/);
  });

  // BYPASS 3 — replay. A captured, correctly-signed event whose timestamp is stale is refused.
  it("BYPASS: a valid signature with a stale timestamp is rejected (timestamp / replay)", () => {
    const oldT = T - 3600; // an hour old — well outside the 300s window
    const header = signPayload(body, secret, oldT); // genuinely signed at oldT (MAC is valid)
    const v = verifyEvent(body, header, secret, { now });
    expect(v).toMatchObject({ ok: false, code: "timestamp" });
    // …but WITHIN tolerance the same shape passes (proves it's the window, not the signature):
    expect(verifyEvent(body, signPayload(body, secret, T - 100), secret, { now })).toMatchObject({ ok: true });
  });

  it("rejects a missing or malformed header without throwing (verdict door)", () => {
    expect(verifyEvent(body, undefined, secret, { now })).toMatchObject({ ok: false, code: "no-signature" });
    expect(verifyEvent(body, "garbage", secret, { now })).toMatchObject({ ok: false, code: "bad-format" });
  });

  it("accepts multiple v1 (secret rotation): passes if ANY provided signature matches", () => {
    const rotated = `${sign()},v1=${"0".repeat(64)}`; // real sig + a bogus one
    expect(verifyEvent(body, rotated, secret, { now })).toMatchObject({ ok: true });
  });

  it("generateWebhookSecret mints a whsec_ secret", () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[A-Za-z0-9_-]+$/);
  });
});

describe("webhooks — deliver (the sender)", () => {
  it("fans a settled order out as a signed event the receiver can verify (round-trip)", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const wh = new Webhooks({
      endpoints: [{ url: "https://fulfillment.example/hooks", secret }],
      transport: async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return { status: 200 }; },
      now,
    });
    await wh.deliver("order.settled", { orderId: "ord_42", amount: 700, currency: "USD" });

    expect(calls).toHaveLength(1);
    // the receiver verifies the delivered bytes with the shared secret — end to end
    const ev = constructEvent(calls[0].body, calls[0].headers[SIGNATURE_HEADER], secret, { now });
    expect(ev.type).toBe("order.settled");
    expect(ev.data.object).toMatchObject({ orderId: "ord_42", amount: 700 });
    expect(ev.id).toMatch(/^evt_/);
  });

  it("retries a failed delivery with backoff (at-least-once)", async () => {
    let attempts = 0;
    const wh = new Webhooks({
      endpoints: [{ url: "https://x/hooks", secret }],
      transport: async () => { attempts++; return { status: attempts === 1 ? 500 : 200 }; }, // fail once, then succeed
      sleep: async () => {}, // no real backoff wait in the test
      now,
    });
    await wh.deliver("order.settled", { orderId: "ord_r" });
    expect(attempts).toBe(2);
  });

  it("only delivers to endpoints subscribed to the event type", async () => {
    const calls: string[] = [];
    const wh = new Webhooks({
      endpoints: [
        { url: "https://all/hooks", secret },
        { url: "https://none/hooks", secret, events: ["some.other.event"] },
      ],
      transport: async (url) => { calls.push(url); return { status: 200 }; },
      now,
    });
    await wh.deliver("order.settled", { orderId: "ord_s" });
    expect(calls).toEqual(["https://all/hooks"]);
  });

  it("is inert with no endpoints (additive, zero-cost)", async () => {
    let called = false;
    const wh = new Webhooks({ transport: async () => { called = true; return { status: 200 }; }, now });
    expect(wh.enabled).toBe(false);
    await wh.deliver("order.settled", { orderId: "ord_x" });
    expect(called).toBe(false);
  });

  it("register() mints an endpoint + secret and starts delivering to it", async () => {
    const calls: string[] = [];
    const wh = new Webhooks({ transport: async (url) => { calls.push(url); return { status: 200 }; }, now });
    const ep = wh.register({ url: "https://ops.example/hooks" });
    expect(ep.secret).toMatch(/^whsec_/);
    expect(ep.id).toMatch(/^whep_/);
    await wh.deliver("order.settled", { orderId: "ord_reg" });
    expect(calls).toEqual(["https://ops.example/hooks"]);
  });

  // BYPASS (SSRF via redirect) — a compromised endpoint answers 3xx pointing at an internal host. The
  // default transport must NOT follow it: the 3xx is a failed delivery, the redirect target sees nothing.
  // Uses the REAL fetch transport against local servers — deleting `redirect: "manual"` turns this red.
  it("BYPASS: a 3xx from the receiver is not followed — the redirect target never sees the delivery", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => { targetHits++; res.writeHead(200); res.end("ok"); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetPort = (target.address() as AddressInfo).port;

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/internal` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const redirectorPort = (redirector.address() as AddressInfo).port;

    const errors: Array<{ lastStatus?: number }> = [];
    const wh = new Webhooks({
      endpoints: [{ url: `http://127.0.0.1:${redirectorPort}/hooks`, secret }], // localhost http = dev carve-out
      retries: 0,
      sleep: async () => {},
      onDeliveryError: (info) => errors.push(info),
    });
    try {
      await wh.deliver("order.settled", { orderId: "ord_redirect" });
    } finally {
      target.close();
      redirector.close();
    }

    expect(targetHits).toBe(0); // the internal host was never contacted
    expect(errors).toMatchObject([{ lastStatus: 302 }]); // the 3xx surfaced as a failed delivery
  });

  // BYPASS (resource pinning) — a receiver accepts the connection and never responds. The per-attempt
  // timeout must unblock the retry loop and report the exhaustion; without it this promise pends forever
  // (deleting the timeout turns this red by hanging the test past vitest's own timeout).
  it("BYPASS: a receiver that accepts but never responds is timed out, retried, and reported", async () => {
    let attempts = 0;
    const errors: Array<{ attempts: number; error?: unknown }> = [];
    const wh = new Webhooks({
      endpoints: [{ url: "https://hung.example/hooks", secret }],
      transport: () => { attempts++; return new Promise(() => {}); }, // never settles, ignores the signal
      timeoutMs: 5,
      retries: 1,
      sleep: async () => {},
      now,
      onDeliveryError: (info) => errors.push(info),
    });
    await wh.deliver("order.settled", { orderId: "ord_hung" });

    expect(attempts).toBe(2); // the timeout unblocked the loop: attempt 1 timed out, attempt 2 ran
    expect(errors).toMatchObject([{ attempts: 2 }]);
    expect(String((errors[0] as { error?: unknown }).error)).toMatch(/timed out/);
  });
});

describe("webhooks — endpoint URLs (the SSRF boundary at entry)", () => {
  // BYPASS — an http endpoint pointed at an internal host is refused where endpoints ENTER (both doors:
  // constructor and register()), per the spec's "https required by default; http for localhost dev".
  it("BYPASS: a non-localhost http endpoint is refused at the constructor and at register()", () => {
    expect(() => new Webhooks({ endpoints: [{ url: "http://internal.example/hooks", secret }] }))
      .toThrow(/must be https/);
    const wh = new Webhooks();
    expect(() => wh.register({ url: "http://internal.example/hooks" })).toThrow(/must be https/);
    expect(() => wh.register({ url: "not a url" })).toThrow(/not a valid URL/);
  });

  it("allows https anywhere and http on localhost (dev)", () => {
    const wh = new Webhooks();
    expect(() => wh.register({ url: "https://fulfillment.example/hooks" })).not.toThrow();
    expect(() => wh.register({ url: "http://localhost:3000/hooks" })).not.toThrow();
    expect(() => wh.register({ url: "http://127.0.0.1:3000/hooks" })).not.toThrow();
  });
});

describe("webhooks — end to end via CredentAgent (a settled order POSTs a verifiable event)", () => {
  it("a completed order fans out a signed order.settled the receiver verifies", async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    let resolveDelivered: () => void;
    const delivered = new Promise<void>((r) => { resolveDelivered = r; });
    const ca = new CredentAgent({
      walletOrigin: "http://localhost:4000",
      webhooks: {
        endpoints: [{ url: "https://fulfillment.example/hooks", secret }],
        transport: async (_url, init) => { calls.push({ headers: init.headers, body: init.body }); resolveDelivered(); return { status: 200 }; },
        now,
        sleep: async () => {},
      },
    });

    await ca.orders._complete({ orderId: "ord_e2e", amount: 2100, currency: "USD", method: "passkey", completedAt: "t" });
    await delivered; // the webhook is fire-and-forget; wait for the POST

    expect(calls).toHaveLength(1);
    const ev = constructEvent(calls[0].body, calls[0].headers[SIGNATURE_HEADER], secret, { now });
    expect(ev.type).toBe("order.settled");
    expect(ev.data.object).toMatchObject({ orderId: "ord_e2e", amount: 2100, method: "passkey" });
  });
});
