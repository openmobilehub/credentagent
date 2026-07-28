// Preflight tests for credentagent.doctor() (#25). Two layers: the pure `runDoctor` core (each
// check fires on its trigger, and stays QUIET when configured correctly — a check wired backwards
// fails the "healthy" tests), and the `CredentAgent.doctor()` wiring (it assembles the config it
// was constructed with, reads the env, and the print path returns the same report).
import { describe, it, expect, vi, afterEach } from "vitest";
import { runDoctor, formatDoctorReport, type DoctorInput } from "./doctor.js";
import { CredentAgent } from "./client.js";
import { MemoryVerificationStore, MemoryOrderStore } from "./index.js";
import type { VerificationStore, VerificationRecord } from "./types.js";
import type { OrderStore } from "./orders.js";

// Stand-ins for GENUINELY shared stores (e.g. Redis) — NOT the exported in-memory impls, so doctor
// treats them as surviving an instance split (PR #134 review finding: only in-memory is process-local).
class SharedVerificationStore implements VerificationStore {
  read(): VerificationRecord | undefined { return undefined; }
  write(): void {}
  clear(): void {}
}
class SharedOrderStore<T> implements OrderStore<T> {
  read(): T | undefined { return undefined; }
  write(): void {}
  clear(): void {}
}
const sharedStores = () => ({ store: new SharedVerificationStore(), orderStore: new SharedOrderStore(), completedOrderStore: new SharedOrderStore() });

// A fully-healthy DEPLOYED config: public https origin, stable secret, shared stores. Individual
// tests break exactly one field to pin the matching check.
const healthy = (over: Partial<DoctorInput> = {}): DoctorInput => ({
  walletOrigin: "https://shop.example",
  hasGateSecret: true,
  sharedVerificationStore: true,
  sharedOrderStores: true,
  env: { VERCEL: "1" }, // strongest multi-instance signal
  ...over,
});

const codes = (input: DoctorInput) => runDoctor(input).findings.map((f) => f.code);

describe("runDoctor — quiet when healthy (a backwards-wired check fails these)", () => {
  it("reports NOTHING for a fully-configured serverless deployment", () => {
    const report = runDoctor(healthy());
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reports NOTHING in plain local dev (no deployment env signals), even with all defaults", () => {
    const report = runDoctor({
      walletOrigin: "http://localhost:3000",
      hasGateSecret: false,
      sharedVerificationStore: false,
      sharedOrderStores: false,
      env: {}, // not deployed → every check is dormant
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor — each check fires on its own trigger", () => {
  it("missing gateSecret on serverless → an ERROR (matches the quickstart's boot refusal)", () => {
    const report = runDoctor(healthy({ hasGateSecret: false }));
    const f = report.findings.find((x) => x.code === "ephemeral-gate-secret");
    expect(f?.level).toBe("error");
    expect(f?.fix).toContain("openssl rand -hex 32");
    expect(report.ok).toBe(false);
  });

  it("missing gateSecret on a production-only deploy (no serverless signal) → a WARN, not an error", () => {
    const report = runDoctor(healthy({ hasGateSecret: false, env: { NODE_ENV: "production" } }));
    const f = report.findings.find((x) => x.code === "ephemeral-gate-secret");
    expect(f?.level).toBe("warn");
    expect(report.ok).toBe(true); // warnings surface but don't flip ok
  });

  it("localhost walletOrigin on a deployment → an ERROR", () => {
    const report = runDoctor(healthy({ walletOrigin: "http://localhost:3005" }));
    const f = report.findings.find((x) => x.code === "localhost-wallet-origin");
    expect(f?.level).toBe("error");
    expect(f?.fix).toMatch(/walletOrigin/);
  });

  it("in-memory verification store on serverless → an ERROR; on production-only → a WARN", () => {
    expect(runDoctor(healthy({ sharedVerificationStore: false })).findings.find((f) => f.code === "in-memory-verification-store")?.level).toBe("error");
    expect(runDoctor(healthy({ sharedVerificationStore: false, env: { NODE_ENV: "production" } })).findings.find((f) => f.code === "in-memory-verification-store")?.level).toBe("warn");
  });

  it("in-memory order stores on serverless → an ERROR", () => {
    const f = runDoctor(healthy({ sharedOrderStores: false })).findings.find((x) => x.code === "in-memory-order-store");
    expect(f?.level).toBe("error");
  });

  it("only-one-order-store-shared still trips the order-store check (both must be shared)", () => {
    // The instance sets sharedOrderStores=false unless BOTH are injected; a partial deploy is unsafe.
    expect(codes(healthy({ sharedOrderStores: false }))).toContain("in-memory-order-store");
  });

  it("a wholly-misconfigured serverless deploy reports all four and never throws", () => {
    const input: DoctorInput = { walletOrigin: "http://localhost:3000", hasGateSecret: false, sharedVerificationStore: false, sharedOrderStores: false, env: { VERCEL: "1" } };
    let report!: ReturnType<typeof runDoctor>;
    expect(() => { report = runDoctor(input); }).not.toThrow();
    expect(new Set(report.findings.map((f) => f.code))).toEqual(
      new Set(["ephemeral-gate-secret", "localhost-wallet-origin", "in-memory-verification-store", "in-memory-order-store"]),
    );
    expect(report.ok).toBe(false);
  });

  it("recognizes non-Vercel serverless platforms (Lambda / Cloud Run) as multi-instance", () => {
    expect(runDoctor(healthy({ hasGateSecret: false, env: { AWS_LAMBDA_FUNCTION_NAME: "fn" } })).findings.find((f) => f.code === "ephemeral-gate-secret")?.level).toBe("error");
    expect(runDoctor(healthy({ hasGateSecret: false, env: { K_SERVICE: "svc" } })).findings.find((f) => f.code === "ephemeral-gate-secret")?.level).toBe("error");
  });

  // PR #134 review: FUNCTIONS_WORKER_RUNTIME is set by the LOCAL Azure Functions host too (it selects
  // the worker language), so it alone must NOT trip serverless — only when paired with a hosted signal.
  it("local Azure Functions dev (FUNCTIONS_WORKER_RUNTIME, no host id) stays quiet", () => {
    const report = runDoctor({
      walletOrigin: "http://localhost:7071", hasGateSecret: false, sharedVerificationStore: false, sharedOrderStores: false,
      env: { FUNCTIONS_WORKER_RUNTIME: "node" }, // `func start` locally — not deployed
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("hosted Azure Functions (FUNCTIONS_WORKER_RUNTIME + WEBSITE_INSTANCE_ID) IS serverless → error", () => {
    const f = runDoctor(healthy({ hasGateSecret: false, env: { FUNCTIONS_WORKER_RUNTIME: "node", WEBSITE_INSTANCE_ID: "abc123" } }))
      .findings.find((x) => x.code === "ephemeral-gate-secret");
    expect(f?.level).toBe("error");
  });
});

// PR #134 review (mounted-seams blindness): a client composed with a host may take its signing key /
// stores from seams doctor only partially sees. When composedWithHost, the order-store check is
// skipped (the host owns order persistence) and a residual secret/store finding is ANNOTATED, not a
// bare hard error — so a correctly configured composition isn't told it's broken.
describe("runDoctor — composed-with-host (mounted seams)", () => {
  it("skips the order-store check (the host owns order persistence)", () => {
    const report = runDoctor(healthy({ sharedOrderStores: false, composedWithHost: true }));
    expect(report.findings.find((f) => f.code === "in-memory-order-store")).toBeUndefined();
  });

  it("still runs the order-store check when NOT composed (a bare orders.serve client)", () => {
    expect(runDoctor(healthy({ sharedOrderStores: false })).findings.find((f) => f.code === "in-memory-order-store")).toBeTruthy();
  });

  it("annotates a residual secret/store finding with the 'configured via seams? ignore this' note", () => {
    const report = runDoctor(healthy({ hasGateSecret: false, sharedVerificationStore: false, composedWithHost: true }));
    const secret = report.findings.find((f) => f.code === "ephemeral-gate-secret");
    expect(secret?.message).toMatch(/mounted ceremony seams|composed storefront/i);
  });
});

describe("formatDoctorReport", () => {
  it("says healthy when there are no findings", () => {
    expect(formatDoctorReport({ ok: true, findings: [] })).toContain("healthy");
  });
  it("lists each finding's code and its concrete fix", () => {
    const block = formatDoctorReport(runDoctor(healthy({ hasGateSecret: false })));
    expect(block).toContain("ephemeral-gate-secret");
    expect(block).toContain("openssl rand -hex 32");
  });
});

describe("CredentAgent.doctor() — assembles the instance's config + reads the env", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a misconfigured serverless instance surfaces the localhost + ephemeral-key + in-memory findings", () => {
    vi.stubEnv("VERCEL", "1");
    const ca = new CredentAgent(); // zero-config: localhost origin, no gateSecret, in-memory defaults
    const report = ca.doctor();
    expect(report.ok).toBe(false);
    const found = new Set(report.findings.map((f) => f.code));
    expect(found.has("localhost-wallet-origin")).toBe(true);
    expect(found.has("ephemeral-gate-secret")).toBe(true);
    expect(found.has("in-memory-verification-store")).toBe(true);
  });

  it("a fully-configured serverless instance is healthy (proves the wiring reads real config)", () => {
    vi.stubEnv("VERCEL", "1");
    const ca = new CredentAgent({ walletOrigin: "https://shop.example", gateSecret: "s".repeat(32), ...sharedStores() });
    expect(ca.doctor().findings).toEqual([]);
  });

  // PR #134 review: explicitly injecting the EXPORTED in-memory stores is still process-local, so a
  // serverless instance so configured is NOT healthy — the in-memory findings must still fire.
  it("injecting MemoryVerificationStore / MemoryOrderStore does NOT count as shared (still flagged)", () => {
    vi.stubEnv("VERCEL", "1");
    const ca = new CredentAgent({
      walletOrigin: "https://shop.example",
      gateSecret: "s".repeat(32),
      store: new MemoryVerificationStore(),
      orderStore: new MemoryOrderStore(),
      completedOrderStore: new MemoryOrderStore(),
    });
    const found = new Set(ca.doctor().findings.map((f) => f.code));
    expect(found.has("in-memory-verification-store")).toBe(true);
    expect(found.has("in-memory-order-store")).toBe(true);
  });

  // PR #134 review (mounted-seams blindness): a client composed with a host — createStorefront-style
  // seams published on app.locals — takes its signing key + shared store from those seams. doctor must
  // read the EFFECTIVE config, not just the constructor flags, so a correct composition isn't flagged.
  it("a composed client reads the effective signing key + store from the mounted seams (no false alarm)", () => {
    vi.stubEnv("VERCEL", "1");
    const ca = new CredentAgent({ walletOrigin: "https://shop.example" }); // NO constructor gateSecret/store
    const app = {
      locals: {
        credentagent: {
          orderStore: new SharedOrderStore(),
          catalog: {},
          completion: async () => ({ completed: true }),
          signingKey: "s".repeat(32), // the composed host's key
          verificationStore: new SharedVerificationStore(), // the composed host's shared store
        },
      } as Record<string, unknown>,
    };
    ca.mount(app);
    const report = ca.doctor();
    const found = new Set(report.findings.map((f) => f.code));
    expect(found.has("ephemeral-gate-secret")).toBe(false); // key captured from the seam
    expect(found.has("in-memory-verification-store")).toBe(false); // shared store captured from the seam
    expect(found.has("in-memory-order-store")).toBe(false); // the host owns order persistence
  });

  it("print:true returns the same report AND writes a block to the console", () => {
    vi.stubEnv("VERCEL", "1");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ca = new CredentAgent(); // misconfigured → console.error path
    const report = ca.doctor({ print: true });
    expect(report.ok).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain("[credentagent] doctor");
    spy.mockRestore();
  });

  it("doctor() never throws and touches nothing external (plain data, no side effects without print)", () => {
    const ca = new CredentAgent();
    expect(() => ca.doctor()).not.toThrow();
  });
});
