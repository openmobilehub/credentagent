// credentagent.gate() — wrap an MCP tool handler so it refuses-until-proven.
//
// The general Mode-B "gate a tool" facade (#17/#23): a page-less tool returns the
// typed `verification_required` envelope instead of running, and an agent drives
// the loop — show the person the approve link, they prove the credential on their
// phone, the agent re-calls and the handler runs. The wrap IS the enforcement
// point (enforce-by-construction): a wrapped tool cannot fail open by
// "forgetting the check" (Security invariant 1).
//
// Built on the same resolver as `requirements()` — one policy language, one
// code→data boundary — with `enforcedAt: "tool"` stated honestly in each entry.

import type { Credential, GateOrder, Step, VerificationManifestEntry, VerificationRecord, VerificationStore } from "./types.js";
import type { MinimalToolResult } from "./gated.js";
import { buildVerificationRequired, type VerificationRequired } from "./envelope.js";

/** Options for `credentagent.gate()` — what to prove, and whose proof counts. */
export interface GateOptions<A> {
  /** The credential(s) to prove: `age.over(21)`, a `defineCredential(...)`, or an array.
   *  Only `gate()`-effect credentials belong here — payment settles on the checkout
   *  ceremony (`requirements()` + `mount()`), and a discount is a benefit, not a gate. */
  require: Credential | Credential[];
  /**
   * Whose proof unlocks the call — derive a stable id (a user / session / subject id)
   * from the tool args. Calls that derive the same value share one proof; proofs are
   * stored per-subject on this server's store, NEVER process-global (Security
   * invariant 4). Returning a shared constant would let one person's proof unlock
   * everyone's calls — an empty/missing value is refused fail-closed, not shared.
   */
  provenBy: (args: A) => string;
  /** Your registered tool name — names the re-call in the refusal (`resume.tool`).
   *  Optional; without it the refusal says "this tool" (the agent knows what it called). */
  name?: string;
}

/** The seams `CredentAgent.gate()` binds: its store + its policy resolver. */
export interface GateSeams {
  store: VerificationStore;
  resolve: (order: GateOrder, steps: Step[]) => VerificationManifestEntry[];
  /** True once `mount()` wired the ceremony rails in this process (warn honestly if not). */
  isMounted: () => boolean;
}

/** True iff THIS order's record proves the entry (explicit positive — invariant 5). */
function proven(entry: VerificationManifestEntry, record: VerificationRecord | undefined): boolean {
  if (entry.credential === "age") return record?.ageVerified === true;
  return record?.verifiedGates?.[entry.credential] === true;
}

/** Action-agnostic agent instruction — NOT the checkout-worded `envelopeInstruction()`. */
export function toolEnvelopeInstruction(env: VerificationRequired, toolName?: string): string {
  const recall = toolName ? `\`${toolName}\`` : "this tool";
  return (
    `This action requires ${env.reason.gate} before it can run. Ask the person to open this ` +
    `link on their phone and present the credential: ${env.present.approve_url} — then call ` +
    `${recall} again with the same arguments. Do not treat the action as done until it ` +
    `returns a result instead of verification_required.`
  );
}

export function makeToolGate<A, R>(
  handler: (args: A, ...rest: unknown[]) => R | Promise<R>,
  opts: GateOptions<A>,
  seams: GateSeams,
): (args: A, ...rest: unknown[]) => Promise<R | MinimalToolResult> {
  const credentials = Array.isArray(opts.require) ? opts.require : [opts.require];
  // Fail fast at WRAP time on a policy this gate cannot honor — a credential that
  // looks enforced but is a silent no-op would be a foot-gun for a consent library.
  if (credentials.length === 0) {
    throw new Error(`gate(): \`require\` is empty — pass the credential(s) to prove (e.g. age.over(21)).`);
  }
  for (const c of credentials) {
    if (c.effect.kind === "authorize") {
      throw new Error(
        `gate(${c.id}): payment authorization settles on the checkout ceremony — use ` +
          `credentagent.requirements() + credentagent.mount() for payment. gate() proves identity credentials.`,
      );
    }
    if (c.effect.kind === "discount") {
      throw new Error(
        `gate(${c.id}): a discount is a benefit applied at checkout, not a blocking gate — ` +
          `it has no meaning on a gated tool. Use a gate()-effect credential here.`,
      );
    }
  }
  const steps: Step[] = credentials.map((credential) => ({ credential, required: true }));
  let warnedUnmounted = false;

  return async (args: A, ...rest: unknown[]): Promise<R | MinimalToolResult> => {
    const subject = opts.provenBy(args);
    if (typeof subject !== "string" || subject.trim() === "") {
      // Fail CLOSED: a missing subject must never collapse callers into a shared
      // proof bucket (cross-user bleed, invariant 4) — refuse loudly instead.
      throw new Error(
        `gate(): \`provenBy\` returned ${JSON.stringify(subject)} — it must derive a non-empty ` +
          `per-caller id from the tool args, or one person's proof would unlock everyone's calls.`,
      );
    }
    // A $0 ACTION, not a sale — the gate doesn't care that there's no money.
    const order: GateOrder = { id: subject, total: 0, currency: "USD", lines: [] };
    const entries = seams.resolve(order, steps);
    const record = await seams.store.read(subject);
    const unproven = entries.find((e) => !proven(e, record));
    if (!unproven) return handler(args, ...rest);

    if (!seams.isMounted() && !warnedUnmounted) {
      warnedUnmounted = true;
      console.warn(
        `[credentagent] gate(): approve link points at ${unproven.approveUrl}, but ` +
          `credentagent.mount(app) has not run in this process — if no server serves that route, ` +
          `the link is a dead end. Mount the ceremony on your web app (sharing this store) to serve it.`,
      );
    }

    const step = steps.find((s) => s.credential.id === unproven.credential);
    const env = buildVerificationRequired({
      order,
      credential: unproven.credential,
      request: step!.credential.request,
      approveUrl: unproven.approveUrl ?? "",
      detail: `${unproven.label} must be proven before this action can run — no proof on file for "${subject}".`,
      minAge: unproven.minAge,
      gate: unproven.label,
      resumeTool: opts.name ?? "this-tool",
      resumePoll: "re-call with the same arguments until verification_required clears",
    });
    return {
      // VerificationRequired is a plain JSON object; widen to the tool-result shape.
      // (Do NOT declare an MCP `outputSchema` on a gated tool — the envelope must be
      // free to replace the success shape in `structuredContent`.)
      structuredContent: env as unknown as Record<string, unknown>,
      content: [{ type: "text", text: toolEnvelopeInstruction(env, opts.name) }],
    };
  };
}
