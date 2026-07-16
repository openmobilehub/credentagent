// RevocationStore — the fail-closed revocation + atomic single-use/cap ledger (005).
import { describe, it, expect } from "vitest";
import { MemoryRevocationStore } from "./revocation.js";

describe("MemoryRevocationStore", () => {
  it("revoke + kill-switch", () => {
    const s = new MemoryRevocationStore();
    expect(s.isRevoked("int_1")).toBe(false);
    s.revoke("int_1");
    expect(s.isRevoked("int_1")).toBe(true);
    expect(s.isRevoked("int_2", "user_a")).toBe(false);
    s.revokeSubject("user_a");
    expect(s.isRevoked("int_2", "user_a")).toBe(true); // subject kill-switch, any intent
    expect(s.isRevoked("int_2", "user_b")).toBe(false);
  });

  it("single-use: a duplicate pspTransactionId is rejected (consumed)", () => {
    const s = new MemoryRevocationStore();
    expect(s.commitDraw("int_1", { amount: 10, pspTransactionId: "tx" }, { totalAmount: 100 })).toEqual({ ok: true });
    expect(s.commitDraw("int_1", { amount: 10, pspTransactionId: "tx" }, { totalAmount: 100 })).toEqual({ ok: false, reason: "consumed" });
  });

  it("ATOMIC cumulative cap (Codex P1): two DIFFERENT-txid draws that each pass a cap pre-check cannot both commit", () => {
    const s = new MemoryRevocationStore();
    // Both draws are $30 against a $40 cumulative cap. checkDraw's non-atomic over-total
    // pre-check would let each through when read against empty priorDraws (the concurrent
    // race). The commit is the atomic backstop: the first wins, the second is refused
    // over-total — the committed sum can never exceed totalAmount.
    expect(s.commitDraw("int_1", { amount: 30, pspTransactionId: "a" }, { totalAmount: 40 })).toEqual({ ok: true });
    expect(s.commitDraw("int_1", { amount: 30, pspTransactionId: "b" }, { totalAmount: 40 })).toEqual({ ok: false, reason: "over-total" });
    // the ledger holds exactly the one committed draw
    expect(s.priorDraws("int_1")).toEqual([{ amount: 30, pspTransactionId: "a" }]);
  });

  it("cap counts only committed draws, per intent", () => {
    const s = new MemoryRevocationStore();
    s.commitDraw("int_1", { amount: 25, pspTransactionId: "a" }, { totalAmount: 40 });
    // a DIFFERENT intent has its own independent ledger
    expect(s.commitDraw("int_2", { amount: 40, pspTransactionId: "z" }, { totalAmount: 40 })).toEqual({ ok: true });
    // back on int_1: 25 committed, 20 more would be 45 > 40 → refused
    expect(s.commitDraw("int_1", { amount: 20, pspTransactionId: "b" }, { totalAmount: 40 })).toEqual({ ok: false, reason: "over-total" });
    // …but 15 more (40 total) is exactly the cap → allowed
    expect(s.commitDraw("int_1", { amount: 15, pspTransactionId: "c" }, { totalAmount: 40 })).toEqual({ ok: true });
  });
});

// ── Atomic revocation at the consume (PR #41 review — TOCTOU fix) ──────────────────────────
describe("MemoryRevocationStore — commitDraw is the atomic revocation point", () => {
  it("BYPASS: commitDraw refuses a revoked grant (kill-switch decided at the consume, not only the pre-check)", () => {
    const s = new MemoryRevocationStore();
    s.revoke("int_1");
    expect(s.commitDraw("int_1", { amount: 10, pspTransactionId: "tx" }, { totalAmount: 100 })).toEqual({ ok: false, reason: "revoked" });
  });
  it("commitDraw refuses a subject-revoked grant (kill-switch by subject)", () => {
    const s = new MemoryRevocationStore();
    s.revokeSubject("acct-42");
    expect(s.commitDraw("int_1", { amount: 10, pspTransactionId: "tx" }, { totalAmount: 100, subject: "acct-42" })).toEqual({ ok: false, reason: "revoked" });
  });
});
