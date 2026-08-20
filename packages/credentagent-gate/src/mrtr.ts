// Multi Round-Trip Requests (MRTR) — the MCP pattern for "I need more information before I can
// do this", implemented here because the pinned @modelcontextprotocol/sdk does not ship it yet.
//
//   const rounds = new MultiRoundTrip({ secret });                  // configure once
//
//   // inside a tool handler — one call, every round:
//   const round = rounds.open({ request: "create-spending-grant", params: args, state, responses });
//   if (!round.ok) return refuse(round.code);                       // tampered | expired | …
//   if (!round.answers.size) {
//     return round.ask({ size: { message: "Which size?", fields: { size: { type: "string" } } } });
//   }
//   // …enough information: do the thing.
//
// WHY IT LOOKS LIKE THIS: the pattern's whole point is that the SERVER KEEPS NO MEMORY between
// rounds (spec: no shared storage, no sticky load balancing). Everything gathered so far rides in
// `requestState`, an opaque blob the client echoes back verbatim. So `open()` takes the blob and
// hands back the merged answers; `ask()` re-seals them with the new question.
//
// SECURITY (spec §"Security Considerations"; repo invariants 2 + 4): `requestState` travels
// through the client, so it is ATTACKER-CONTROLLED INPUT. This module therefore:
//   • signs it (HMAC-SHA256 over the exact payload bytes) and refuses anything that fails —
//     a hand-edited blob never becomes trusted state;
//   • stamps a short TTL and refuses a lapsed one;
//   • binds it to the request (name + digest of the salient params) and to the authenticated
//     principal, so state minted for one call/user cannot be presented on another;
//   • merges ONLY answers to questions this flow actually asked — an unsolicited field is dropped.
// It is deliberately NOT single-use (the spec notes state alone cannot guarantee that): a flow
// whose completion must happen at most once enforces that where the effect lands, not here.
//
// HONESTY: the sealed blob proves THIS SERVER minted it and that nobody edited it in transit. It
// says nothing about whether a human really gave the answers inside — a client without MRTR
// support has its agent answer on the human's behalf. Anything consequential must still be shown
// to the human on a confirmation surface before it takes effect.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default validity window for a round of questions — mirrors the challenge-token TTL policy. */
export const DEFAULT_MRTR_TTL_MS = 15 * 60 * 1000;

/** A single field a question asks for (the restricted primitive schema elicitation allows). */
export interface AskField {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  /** Closed set of acceptable values — rendered as a picker by MRTR-aware clients. */
  enum?: string[];
  enumNames?: string[];
}

/** One question to put to the human. `fields` become the elicitation's `requestedSchema`. */
export interface Ask {
  message: string;
  fields: Record<string, AskField>;
  /** Which fields must come back. Default: all of them. */
  required?: string[];
}

/** The server→client requests of an `input_required` result (spec: `InputRequests`). */
export type InputRequests = Record<
  string,
  {
    method: "elicitation/create";
    params: {
      mode: "form";
      message: string;
      requestedSchema: { type: "object"; properties: Record<string, AskField>; required: string[] };
    };
  }
>;

/** The result that says "ask the human this, then call me again" (spec: `InputRequiredResult`). */
export interface InputRequiredResult {
  resultType: "input_required";
  inputRequests: InputRequests;
  /** Opaque to the client: it MUST echo this back verbatim and MUST NOT parse it. */
  requestState: string;
}

/** Why a presented `requestState` was refused — a typed union, never a bare string. */
export type MultiRoundTripRefusal =
  | "tampered" // failed signature (or isn't a state blob at all) — forged or hand-edited
  | "expired" // past its TTL — the human took too long, start over
  | "wrong-request" // minted for a different call, or the salient params changed underneath it
  | "wrong-principal"; // minted for a different session/user — no cross-user reuse

export interface OpenRoundArgs {
  /** What this state may be presented on — e.g. the tool name. */
  request: string;
  /** The salient params a retry must repeat. Digested, never stored in the clear. */
  params?: unknown;
  /** The authenticated principal (session id / user). Absent = not bound to one. */
  principal?: string;
  /** `params.requestState` as the client echoed it back (absent on the first call). */
  state?: unknown;
  /** `params.inputResponses` — the client's answers to the last round's questions. */
  responses?: unknown;
  /**
   * Flat fallback for clients that do not implement MRTR yet: `{ size: "US 40" }`, gathered by
   * the agent instead of by the client's own elicitation UI. Filtered by the SAME allowlist —
   * a field this flow never asked for is dropped — but note the honesty caveat: these answers
   * are attested by the AGENT, not by the human.
   */
  answers?: Record<string, unknown>;
  /** Injectable clock (tests); defaults to `Date.now()`. */
  now?: number;
}

/** An open round: what is known so far, and the door to ask for the rest. */
export type Round =
  | {
      ok: true;
      /** Everything gathered so far — earlier rounds merged with this call's accepted answers. */
      answers: Record<string, unknown>;
      /** Question keys the human declined or cancelled in THIS round. */
      declined: string[];
      /** How many times this flow has already asked (0 on the first call) — cap your own loops. */
      round: number;
      /** Build the `input_required` result: these questions + a freshly sealed state. */
      ask(requests: Record<string, Ask>): InputRequiredResult;
    }
  | { ok: false; code: MultiRoundTripRefusal };

/** What the sealed blob carries. Never exposed — `requestState` is opaque by contract. */
interface StatePayload {
  v: 1;
  /** Request binding: the call this state belongs to. */
  req: string;
  /** Digest of the salient params — a retry that changed them is refused. */
  dig: string;
  /** Principal binding ("" = unbound). */
  sub: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Rounds already asked. */
  n: number;
  /** Answers gathered so far. */
  answers: Record<string, unknown>;
  /** Question key → the field names that question asked for. Anything else is ignored. */
  asked: Record<string, string[]>;
}

/** Stable JSON: object keys sorted at every depth, so the same params digest the same way. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

const digest = (params: unknown, secret: string): string =>
  createHmac("sha256", secret).update(canonical(params ?? null)).digest("base64url");

const sign = (payloadB64: string, secret: string): string =>
  createHmac("sha256", secret).update(`mrtr1.${payloadB64}`).digest("base64url");

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface MultiRoundTripOptions {
  /**
   * HMAC key the state is sealed with. On a multi-instance deployment this MUST be stable and
   * shared, or a state minted on one instance is refused (`tampered`) by the next.
   */
  secret: string;
  /** How long a round of questions stays answerable. Default 15 minutes. */
  ttlMs?: number;
}

/**
 * The MRTR engine: turns "I still need X" into a spec-shaped `input_required` result, and turns
 * a client's retry back into the answers gathered so far — with no server-side session.
 */
export class MultiRoundTrip {
  readonly #secret: string;
  readonly #ttlMs: number;

  constructor(opts: MultiRoundTripOptions) {
    if (!opts?.secret) throw new Error("[credentagent] MultiRoundTrip requires a `secret` to seal requestState with.");
    this.#secret = opts.secret;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_MRTR_TTL_MS;
  }

  /** Open the round: verify any presented state, merge the new answers, expose `ask()`. */
  open(args: OpenRoundArgs): Round {
    const now = args.now ?? Date.now();
    const dig = digest(args.params, this.#secret);
    const sub = args.principal ?? "";

    let prior: StatePayload | undefined;
    if (args.state !== undefined && args.state !== null && args.state !== "") {
      const opened = this.#openState(args.state, now);
      if ("code" in opened) return { ok: false, code: opened.code };
      prior = opened.payload;
      // Bind the state to THIS call: same request, same salient params, same principal.
      if (prior.req !== args.request || !equal(prior.dig, dig)) return { ok: false, code: "wrong-request" };
      if (prior.sub !== sub) return { ok: false, code: "wrong-principal" };
    }

    // Merge: only answers to questions THIS flow asked, and only the fields it asked for.
    // A first call asked nothing, so unsolicited `inputResponses` are dropped wholesale.
    const asked = prior?.asked ?? {};
    const answers: Record<string, unknown> = { ...(prior?.answers ?? {}) };
    const declined: string[] = [];
    const responses = args.responses;
    if (responses && typeof responses === "object" && !Array.isArray(responses)) {
      for (const [key, fields] of Object.entries(asked)) {
        const reply = (responses as Record<string, unknown>)[key];
        if (!reply || typeof reply !== "object") continue;
        const { action, content } = reply as { action?: unknown; content?: unknown };
        if (action !== undefined && action !== "accept") {
          declined.push(key);
          continue;
        }
        if (!content || typeof content !== "object") continue;
        for (const field of fields) {
          const v = (content as Record<string, unknown>)[field];
          if (v !== undefined) answers[field] = v;
        }
      }
    }

    // The fallback channel, held to the same rule: only fields some question actually asked for.
    if (args.answers && typeof args.answers === "object") {
      const askedFields = new Set(Object.values(asked).flat());
      for (const [field, v] of Object.entries(args.answers)) {
        if (v !== undefined && askedFields.has(field)) answers[field] = v;
      }
    }

    const round = prior?.n ?? 0;
    return {
      ok: true,
      answers,
      declined,
      round,
      ask: (requests: Record<string, Ask>): InputRequiredResult => {
        const inputRequests: InputRequests = {};
        const nextAsked: Record<string, string[]> = {};
        for (const [key, a] of Object.entries(requests)) {
          const properties = a.fields;
          const required = a.required ?? Object.keys(properties);
          inputRequests[key] = {
            method: "elicitation/create",
            params: { mode: "form", message: a.message, requestedSchema: { type: "object", properties, required } },
          };
          nextAsked[key] = Object.keys(properties);
        }
        const payload: StatePayload = {
          v: 1,
          req: args.request,
          dig,
          sub,
          exp: now + this.#ttlMs,
          n: round + 1,
          answers,
          asked: nextAsked,
        };
        return { resultType: "input_required", inputRequests, requestState: this.#seal(payload) };
      },
    };
  }

  #seal(payload: StatePayload): string {
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `mrtr1.${b64}.${sign(b64, this.#secret)}`;
  }

  /** Verify + parse a presented blob. Signature first, then expiry — never parse unsigned bytes. */
  #openState(state: unknown, now: number): { payload: StatePayload } | { code: MultiRoundTripRefusal } {
    if (typeof state !== "string") return { code: "tampered" };
    const parts = state.split(".");
    if (parts.length !== 3 || parts[0] !== "mrtr1") return { code: "tampered" };
    const [, b64, sig] = parts;
    if (!equal(sig, sign(b64, this.#secret))) return { code: "tampered" };
    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as StatePayload;
    } catch {
      return { code: "tampered" }; // signed but unreadable — treat as forged, never as usable state
    }
    if (payload?.v !== 1 || typeof payload.exp !== "number") return { code: "tampered" };
    if (now > payload.exp) return { code: "expired" };
    return { payload };
  }
}
