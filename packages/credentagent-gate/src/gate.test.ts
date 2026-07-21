// credentagent.gate() — the Mode-B "gate a tool" facade (spec 2026-07-20, #17/#23 core).
// The wrap IS the enforcement point: an unproven call returns the typed
// verification_required envelope and the real handler NEVER runs (invariant 1 —
// enforce server-side on every completion path; a page-less tool's completion
// path is its handler). Proof is keyed per subject (invariant 4) and must be the
// explicit positive claim (invariant 5).

import { describe, it, expect, vi } from "vitest";
import { CredentAgent } from "./client.js";
import { age, defineCredential, dcql, gate, membership, payment } from "./credentials.js";
import { isVerificationRequired } from "./envelope.js";

function releaseRecords(subject: string) {
  return { released: true, subject, records: [`record:${subject}:summary`] };
}

/** A gated release-records tool + a `ran` probe, on a fresh CredentAgent. */
function gatedFixture(opts?: { require?: Parameters<CredentAgent["gate"]>[1]["require"] }) {
  const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });
  const calls: string[] = [];
  const gated = credentagent.gate(
    async ({ subject }: { subject: string }) => {
      calls.push(subject);
      return { content: [{ type: "text" as const, text: JSON.stringify(releaseRecords(subject)) }] };
    },
    {
      require: opts?.require ?? age.over(21),
      provenBy: ({ subject }: { subject: string }) => subject,
      name: "release-records",
    },
  );
  const call = async (subject: string) =>
    (await gated({ subject })) as {
      structuredContent?: Record<string, unknown>;
      content?: { type: string; text: string }[];
    };
  return { credentagent, gated, call, calls };
}

describe("CredentAgent.gate", () => {
  it("REFUSES an unproven gated action — returns the verification_required envelope, the handler never runs", async () => {
    const { call, calls } = gatedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call("casey");
    warn.mockRestore();

    // The attack: call the tool with no verification on file. The action must not run.
    expect(calls).toEqual([]);
    const env = res.structuredContent;
    expect(isVerificationRequired(env)).toBe(true);
    if (!isVerificationRequired(env)) throw new Error("unreachable");
    // Assert the typed refusal precisely — not just "didn't succeed".
    expect(env.reason.pass).toBe(false);
    expect(env.order.id).toBe("casey");
    expect(env.present.credential).toBe("age");
    expect(env.present.min_age).toBe(21);
    expect(env.present.approve_url).toContain("https://records.example");
    expect(env.present.approve_url).toContain("casey");
    expect(env.resume.tool).toBe("release-records");
    expect(env.resume.poll).toBe("re-call with the same arguments until verification_required clears");
    expect(env.trust_level).toBe("presence-only-demo");
    // The agent-facing instruction rides in content and is ACTION-agnostic —
    // never the checkout wording ("order is placed", "buyer").
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain(env.present.approve_url);
    expect(text).toContain("release-records");
    expect(text).not.toMatch(/order is placed|buyer/i);
  });

  it("runs the handler once proof is recorded under the envelope's own id — and REFUSES a cross-subject bleed (casey's proof never unlocks riley)", async () => {
    const { credentagent, call, calls } = gatedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The loop, end to end at unit scope: the refusal names the id the ceremony
    // will record the proof under (order.id) — write the proof exactly there,
    // as the credential rail's verify handler would.
    const refusal = await call("casey");
    const env = refusal.structuredContent as { order: { id: string } };
    await credentagent.store.write(env.order.id, { ageVerified: true });

    const res = await call("casey");
    expect(calls).toEqual(["casey"]);
    expect(res.content?.[0]?.text).toContain('"released":true');

    // The attack: a DIFFERENT subject rides on casey's proof (invariant 4).
    const riley = await call("riley");
    expect(calls).toEqual(["casey"]); // handler did not run again
    expect(isVerificationRequired(riley.structuredContent)).toBe(true);
    warn.mockRestore();
  });

  it("REFUSES a negative/absent claim: a record WITHOUT ageVerified === true is not proof (invariant 5)", async () => {
    const { credentagent, call, calls } = gatedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A record EXISTS for casey (e.g. loyalty ran), but the age claim is false.
    await credentagent.store.write("casey", { ageVerified: false, loyalty: { applied: true, membershipNumber: "M-1" } });
    const res = await call("casey");
    warn.mockRestore();
    expect(calls).toEqual([]);
    expect(isVerificationRequired(res.structuredContent)).toBe(true);
  });

  it("gates on a CUSTOM defineCredential — proven only via verifiedGates[its id], never another id's proof", async () => {
    const license = defineCredential({
      id: "license",
      request: dcql({ docType: "org.example.license.1", claims: ["license_number"] }),
      verify: (claims) => typeof claims.license_number === "string",
      effect: gate(),
      ui: { label: "Professional license", action: "Present your license" },
    });
    const { credentagent, call, calls } = gatedFixture({ require: license });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const refusal = await call("casey");
    const env = refusal.structuredContent;
    expect(isVerificationRequired(env)).toBe(true);
    if (!isVerificationRequired(env)) throw new Error("unreachable");
    expect(env.present.credential).toBe("license");

    // The attack: a proof for a DIFFERENT credential id must not satisfy this gate.
    await credentagent.store.write("casey", { verifiedGates: { "other-cred": true } });
    expect(isVerificationRequired((await call("casey")).structuredContent)).toBe(true);
    expect(calls).toEqual([]);

    await credentagent.store.write("casey", { verifiedGates: { license: true } });
    await call("casey");
    expect(calls).toEqual(["casey"]);
    warn.mockRestore();
  });

  it("skips a gate whose .when() predicate says it does not apply", async () => {
    const { call, calls } = gatedFixture({
      require: age.over(21).when((order) => order.id.startsWith("restricted:")),
    });
    await call("casey"); // predicate false — the gate is not in the manifest
    expect(calls).toEqual(["casey"]);
  });

  it("fails FAST at wrap time on a policy gate() cannot honor (payment / discount — no silent no-op)", () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });
    const handler = async () => ({ content: [] });
    expect(() =>
      credentagent.gate(handler, { require: payment.in("usd"), provenBy: () => "s" }),
    ).toThrow(/payment/i);
    expect(() =>
      credentagent.gate(handler, { require: membership.discount(10), provenBy: () => "s" }),
    ).toThrow(/discount/i);
    expect(() => credentagent.gate(handler, { require: [], provenBy: () => "s" })).toThrow(/require/);
  });

  it("fails CLOSED on an empty subject — refuses loudly rather than sharing a proof bucket", async () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });
    let ran = false;
    const gated = credentagent.gate(
      async () => {
        ran = true;
        return { content: [] };
      },
      { require: age.over(21), provenBy: () => "" },
    );
    await expect(gated({})).rejects.toThrow(/provenBy/);
    expect(ran).toBe(false);
  });

  it("defaults resume.tool to \"this-tool\" and the instruction to \"this tool\" when no name is given", async () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });
    const gated = credentagent.gate(async () => ({ content: [] }), {
      require: age.over(21),
      provenBy: () => "casey",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = (await gated({})) as { structuredContent?: Record<string, unknown>; content?: { text: string }[] };
    warn.mockRestore();
    const env = res.structuredContent;
    if (!isVerificationRequired(env)) throw new Error("expected envelope");
    expect(env.resume.tool).toBe("this-tool");
    expect(res.content?.[0]?.text).toContain("this tool");
  });

  it("passes the MCP handler's `extra` through to provenBy — session-keyed proofs work", async () => {
    const credentagent = new CredentAgent({ walletOrigin: "https://records.example" });
    const gated = credentagent.gate(async () => ({ content: [] }), {
      require: age.over(21),
      // The SDK calls handlers as (args, extra) — key by the transport session.
      provenBy: (_args, extra) => (extra as { sessionId: string }).sessionId,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = (await gated({}, { sessionId: "sess-9" })) as { structuredContent?: Record<string, unknown> };
    warn.mockRestore();
    const env = res.structuredContent;
    if (!isVerificationRequired(env)) throw new Error("expected envelope");
    expect(env.order.id).toBe("sess-9");
  });

  it("warns ONCE at refusal time when the ceremony is not mounted in this process (the approve link may be a dead end)", async () => {
    const { call } = gatedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await call("casey");
    await call("casey");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("mount")).length).toBe(1);
    warn.mockRestore();
  });
});
