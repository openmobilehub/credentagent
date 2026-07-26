// credentagent.doctor() — the config preflight (issue #25, the onboarding preflight half).
//
// The three knobs that must be set for a DEPLOYMENT — a stable `gateSecret`, a public
// `walletOrigin`, and shared stores — each warn from a different place today (a constructor
// console.warn, the quickstart's boot refusal, a store doc comment). A newcomer's first ten
// minutes shouldn't be "did I configure this right?". `doctor()` checks them all in ONE place
// and hands back typed plain data: `{ ok, findings: [{ level, code, message, fix }] }` — one
// error door, every finding carrying the concrete remedy. It NEVER throws (it reports; the
// caller decides) and NEVER touches the network (it only reads config + `process.env`).
//
// This module is the pure core: `runDoctor(input)` takes a plain description of the resolved
// config (so it is trivially testable with a crafted env) and returns the report. The
// ergonomic surface is `CredentAgent.doctor()` (client.ts), which assembles this input from the
// instance it was configured once with.

/** A finding's severity. `error` flips `report.ok` to false; `warn` is advisory (surfaced, not blocking). */
export type DoctorLevel = "error" | "warn";

/** One preflight finding — what's wrong, a stable machine `code`, and the concrete `fix`. */
export interface DoctorFinding {
  level: DoctorLevel;
  /** Stable identifier for this finding (e.g. `"ephemeral-gate-secret"`) — safe to switch on. */
  code: string;
  /** What's misconfigured and why it matters, in one sentence. */
  message: string;
  /** The concrete remedy — a command to run or the exact option to set. */
  fix: string;
}

/** The preflight result: `ok` is true iff there are no `error`-level findings. Plain, JSON-safe data. */
export interface DoctorReport {
  ok: boolean;
  findings: DoctorFinding[];
}

/** The resolved config `runDoctor` inspects — assembled by `CredentAgent.doctor()` from the instance. */
export interface DoctorInput {
  /** The origin the client resolved to (already defaulted to localhost when omitted). */
  walletOrigin: string;
  /** Did the caller set a stable `gateSecret`? (Absent ⇒ orders.serve uses an ephemeral key.) */
  hasGateSecret: boolean;
  /** Was a `store` injected (not the in-memory default `MemoryVerificationStore`)? */
  sharedVerificationStore: boolean;
  /** Were BOTH `orderStore` and `completedOrderStore` injected (not the in-memory defaults)? */
  sharedOrderStores: boolean;
  /** Environment to read deployment signals from. Defaults to `process.env`; injected in tests. */
  env?: Record<string, string | undefined>;
}

/** The env vars each serverless platform sets — presence of any ⇒ a multi-instance runtime. */
const SERVERLESS_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["VERCEL", "Vercel"],
  ["AWS_LAMBDA_FUNCTION_NAME", "AWS Lambda"],
  ["LAMBDA_TASK_ROOT", "AWS Lambda"],
  ["K_SERVICE", "Cloud Run"],
  ["FUNCTIONS_WORKER_RUNTIME", "Azure Functions"],
  ["NETLIFY", "Netlify"],
];

/**
 * Classify the runtime from its env. `serverless` is the strong multi-instance signal (a request
 * may hit any instance, so per-process state genuinely can't work → error-level). `production`
 * (`NODE_ENV=production`) is a deployment that MIGHT be single-instance → warn-level. `deployment`
 * is either. `platform` names the serverless host when known, for a friendlier message.
 */
function classifyEnv(env: Record<string, string | undefined>): {
  serverless: boolean;
  production: boolean;
  deployment: boolean;
  platform?: string;
} {
  const hit = SERVERLESS_ENV_VARS.find(([name]) => env[name]);
  const serverless = hit !== undefined;
  const production = env.NODE_ENV === "production";
  return { serverless, production, deployment: serverless || production, ...(hit ? { platform: hit[1] } : {}) };
}

/** True for `http://localhost…` / `http://127.0.0.1…` (a phone on another device can't reach it). */
function isLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(origin);
}

/**
 * Run the config preflight over a resolved config. Pure + never-throws: it returns findings,
 * it does not act on them. A DEV config (no deployment env signals) reports nothing — every
 * check only fires once the runtime looks deployed.
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const env = classifyEnv(input.env ?? {});
  const findings: DoctorFinding[] = [];
  // On serverless the risk is CERTAIN (instances share no memory) → error; on a production
  // deployment that might be single-instance it's a risk → warn. localhost origin is broken on
  // ANY deployment (a phone can't reach it), so it stays error-level either way.
  const multiInstanceLevel: DoctorLevel = env.serverless ? "error" : "warn";
  const where = env.platform ? `a ${env.platform} deployment` : "a multi-instance deployment";

  if (env.deployment && !input.hasGateSecret) {
    findings.push({
      level: multiInstanceLevel,
      code: "ephemeral-gate-secret",
      message:
        `No gateSecret is set, so orders.serve() signs its wallet challenges with an ephemeral per-process key. ` +
        `On ${where} a challenge issued on one instance won't verify on another — the ceremony fails.`,
      fix: "Set a stable secret — generate one with: openssl rand -hex 32 — and pass { gateSecret: process.env.GATE_SECRET }.",
    });
  }

  if (env.deployment && isLocalhostOrigin(input.walletOrigin)) {
    findings.push({
      level: "error",
      code: "localhost-wallet-origin",
      message:
        `walletOrigin is ${input.walletOrigin} in a deployed environment. Wallet ceremonies are origin-bound, ` +
        `so a buyer's phone can't open a localhost approve link.`,
      fix: "Set { walletOrigin } to your public https origin, e.g. https://shop.example.",
    });
  }

  if (env.deployment && !input.sharedVerificationStore) {
    findings.push({
      level: multiInstanceLevel,
      code: "in-memory-verification-store",
      message:
        `Verification state uses the default in-memory store, which doesn't survive an instance split: a proof ` +
        `recorded on one instance is invisible to the instance that completes the order.`,
      fix: "Inject a shared { store } (a VerificationStore backed by Redis/Upstash) for multi-instance deploys.",
    });
  }

  if (env.deployment && !input.sharedOrderStores) {
    findings.push({
      level: multiInstanceLevel,
      code: "in-memory-order-store",
      message:
        `The created / completed order stores use the in-memory default, so an order created on one instance is ` +
        `invisible to another — orders.serve() checkout and orders.retrieve() break across an instance split.`,
      fix: "Inject shared { orderStore, completedOrderStore } (OrderStore backed by Redis/Upstash) for multi-instance deploys.",
    });
  }

  return { ok: findings.every((f) => f.level !== "error"), findings };
}

/** Render a report as a human-readable multi-line block (used by `doctor({ print: true })`). */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.findings.length === 0) return "[credentagent] doctor — configuration looks healthy ✓";
  const errors = report.findings.filter((f) => f.level === "error").length;
  const warns = report.findings.length - errors;
  const counts = [errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warns ? `${warns} warning${warns === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
  const lines = report.findings.map((f) => {
    const badge = f.level === "error" ? "✗ error" : "⚠ warn ";
    return `  ${badge}  ${f.code}: ${f.message}\n           fix: ${f.fix}`;
  });
  return [`[credentagent] doctor — ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} (${counts})`, ...lines].join("\n");
}
