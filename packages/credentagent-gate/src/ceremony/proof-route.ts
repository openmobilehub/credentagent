// GET /credentagent/orders/:id/proof — the order proof receipt: what the gate proved for an order
// (spec docs/superpowers/specs/2026-09-27-order-proof-receipt-design.md). A completed order answers
// from its completed record (through the optional `completedOrders` seam); an unfinished one from
// its per-order verification record. Readable by anyone with the order id, like the store's
// order-status. Credential bytes appear only when the store set `inspectPresentations` — they were
// never stored otherwise. Each proof states its own trust_level; nothing here upgrades it.
import type { CeremonyApp, CeremonyContext, RailRegistrar } from "./mount.js";

interface ProofRequest {
  params: Record<string, string | undefined>;
}
interface ProofResponse {
  status(code: number): ProofResponse;
  json(body: unknown): unknown;
}
type ProofHandler = (req: ProofRequest, res: ProofResponse) => Promise<void>;

export const registerProofRoute: RailRegistrar = (app: CeremonyApp, ctx: CeremonyContext): void => {
  const get = app.get?.bind(app) as ((path: string, handler: ProofHandler) => unknown) | undefined;
  if (!get) return;

  get("/credentagent/orders/:id/proof", async (req, res) => {
    const orderId = req.params.id ?? "";
    const done = ctx.completedOrders ? await ctx.completedOrders.read(orderId) : undefined;
    if (done) {
      res.json({ orderId, status: "completed", proofs: done.proofs ?? [] });
      return;
    }
    const pending = (await ctx.verificationStore.read(orderId))?.proofs;
    if (pending?.length) {
      res.json({ orderId, status: "pending", proofs: pending });
      return;
    }
    res.status(404).json({ error: "order not found" });
  });
};
