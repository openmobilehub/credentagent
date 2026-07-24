// grants.serve(app) — the grant approve page, wired in one call (spec 009, #104).
//
//   const ca = new CredentAgent({ walletOrigin, catalog });
//   ca.grants.serve(app);                                    // approve page + decline + status
//   const grant = await ca.grants.create({ merchant, budget, perSpend, policy });
//   sendToUser(grant.approveUrl);                            // they approve the LIMIT here, once
//
// Increment-1 scope (#104 decision 3): an UNGATED grant (policy []) authorizes end-to-end via
// the demo approve button; a POLICY-GATED grant renders its requirements but the approve POST
// is FENCED (403, fail-closed) — rails-backed grant authorization is the wallet-custody
// increment (a second mountCeremony here would collide with orders' rail routes; the composite
// mount belongs to that increment). Honesty: the page states trust "server-issued-demo".

import type { GateOrder, Step, VerificationManifestEntry } from "./types.js";
import type { OrderStore } from "./orders.js";
import type { GrantRecord } from "./grants.js";
import { isGated } from "./orders-serve.js";

export interface ServeGrantsDeps {
  walletOrigin: string;
  store: OrderStore<GrantRecord>;
  /** `grants._authorize` — seals the Intent Mandate, mints the delegate key, flips status. */
  authorize: (id: string) => Promise<void>;
  /** `grants._decline` — pending → denied, fail-closed everywhere else. */
  decline: (id: string) => Promise<void>;
  requirements: (order: GateOrder, policy: Step[]) => VerificationManifestEntry[];
}

/** A structural Express app/request/response — the package stays dependency-free (mirrors orders-serve). */
interface GrantsApp {
  get?(path: string, handler: GrantsHandler): unknown;
  post?(path: string, handler: GrantsHandler): unknown;
}
interface GrantsRequest {
  params: Record<string, string>;
}
interface GrantsResponse {
  status(code: number): GrantsResponse;
  type(t: string): GrantsResponse;
  send(body: string): unknown;
  json(body: unknown): unknown;
}
type GrantsHandler = (req: GrantsRequest, res: GrantsResponse) => void | Promise<void>;

const fmt = (n: number): string => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (body: string) =>
  `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:3rem auto">${body}</body>`;

/** The grant presented as a one-line GateOrder so `requirements()` resolves the policy
 *  against it (amount = budget — what the human is authorizing up to). */
function pseudoOrder(record: GrantRecord): GateOrder {
  return {
    id: record.id,
    total: record.budgetDollars,
    currency: record.currency,
    lines: [{ id: "grant", name: `Pre-approval at ${record.merchant}`, quantity: 1, unitPrice: record.budgetDollars }],
  };
}

function termsCard(record: GrantRecord, manifest: VerificationManifestEntry[]): string {
  const rows = [
    `<tr><td>Merchant</td><td><strong>${esc(record.merchant)}</strong></td></tr>`,
    `<tr><td>Total budget</td><td><strong>${fmt(record.budgetDollars)}</strong></td></tr>`,
    `<tr><td>Per-purchase cap</td><td><strong>${fmt(record.perSpendDollars)}</strong></td></tr>`,
    ...(record.description ? [`<tr><td>Purpose</td><td>${esc(record.description)}</td></tr>`] : []),
  ].join("");
  const requires = manifest.length
    ? `<p>Requires: ${manifest.map((m) => esc(m.credential)).join(", ")}</p>`
    : "";
  return `<h1>Approve a spending limit</h1><table>${rows}</table>${requires}
    <p style="color:#666">Demo trust: <code>server-issued-demo</code> — the approval key is minted by this
    server and <strong>no real value moves</strong>. Age-restricted items never complete on autopilot.</p>`;
}

export function serveGrants(app: GrantsApp, deps: ServeGrantsDeps): void {
  const get = app.get?.bind(app);
  const post = app.post?.bind(app);
  if (!get || !post) {
    throw new Error("[credentagent] grants.serve(app): the app must expose Express-style get()/post() route methods.");
  }

  const page: GrantsHandler = async (req, res) => {
    const record = await deps.store.read(req.params.id);
    if (!record) { res.status(404).type("html").send(html("<h1>Unknown grant</h1>")); return; }
    const manifest = deps.requirements(pseudoOrder(record), record.policy);
    const gated = isGated(manifest);
    let action = "";
    if (record.status === "pending") {
      action = gated
        ? `<p><strong>This grant needs a wallet ceremony to approve</strong> (its policy requires a
           credential) — not available in this demo increment. It can still be declined.</p>`
        : `<form method="post" action="/credentagent/grants/${encodeURIComponent(record.id)}/approve"><button>Approve this limit</button></form>`;
      action += `<form method="post" action="/credentagent/grants/${encodeURIComponent(record.id)}/decline"><button>Decline</button></form>`;
    } else {
      action = `<p><strong>Status: ${record.status}</strong></p>`;
    }
    res.type("html").send(html(termsCard(record, manifest) + action));
  };

  // Demo approve — UNGATED grants only. A policy-gated grant is refused here (fail-closed,
  // same rule as orders' instant-demo place path): approving it requires the credential
  // ceremony its policy names, which this increment does not serve.
  const approve: GrantsHandler = async (req, res) => {
    const id = req.params.id;
    const record = await deps.store.read(id);
    if (!record) { res.status(404).type("html").send(html("<h1>Unknown grant</h1>")); return; }
    if (record.status === "authorized") { res.type("html").send(html("<h1>✓ Limit approved</h1><p>Already approved — you can close this tab.</p>")); return; }
    if (record.status !== "pending") {
      res.status(403).type("html").send(html(`<h1>Cannot approve</h1><p>This grant is ${record.status} — a ${record.status} grant is never resurrected.</p>`));
      return;
    }
    const manifest = deps.requirements(pseudoOrder(record), record.policy);
    if (isGated(manifest)) {
      res.status(403).type("html").send(html("<h1>Wallet ceremony required</h1><p>This grant's policy requires a credential — it can't be approved from the demo button. Rails-backed grant approval lands with the wallet-custody increment.</p>"));
      return;
    }
    await deps.authorize(id);
    res.type("html").send(html("<h1>✓ Limit approved</h1><p>Your agent can now spend within these bounds. You can close this tab.</p>"));
  };

  const decline: GrantsHandler = async (req, res) => {
    const id = req.params.id;
    const record = await deps.store.read(id);
    if (!record) { res.status(404).type("html").send(html("<h1>Unknown grant</h1>")); return; }
    if (record.status === "denied") { res.type("html").send(html("<h1>Declined</h1><p>Already declined.</p>")); return; }
    if (record.status !== "pending") {
      res.status(403).type("html").send(html(`<h1>Cannot decline</h1><p>This grant is ${record.status}. To stop an approved grant, revoke it.</p>`));
      return;
    }
    await deps.decline(id);
    res.type("html").send(html("<h1>Declined</h1><p>No spending authority was granted. You can close this tab.</p>"));
  };

  const status: GrantsHandler = async (req, res) => {
    const record = await deps.store.read(req.params.id);
    res.json({ completed: record?.status === "authorized", status: record?.status ?? "not-found" });
  };

  get("/credentagent/grants/:id", page);
  post("/credentagent/grants/:id/approve", approve);
  post("/credentagent/grants/:id/decline", decline);
  get("/credentagent/grants/:id/status", status);
}
