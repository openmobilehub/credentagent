// grants.serve(app) — make `grant.approveUrl` a REAL page (a P1 on #112: the documented
// create-and-send-the-link flow 404'd; only the demo's private endpoints could authorize).
//
//   credentagent.grants.serve(app);
//   const grant = await credentagent.grants.create({ ... });
//   sendToUser(grant.approveUrl);        // → GET /credentagent/grants/:id — Approve / Deny
//
// HONESTY: this page is the DEMO stand-in for the wallet ceremony — clicking Approve seals the
// intent server-side (presence "delegated-demo"). The wallet key-signing ceremony (#71) replaces
// this page and calls the SAME _authorize/_deny seams; the URL contract doesn't change.

import type { Grant, Grants } from "./grants.js";
import type { GrantAgeScope } from "./grants-age.js";

/** Structural Express app — the package stays dependency-free (mirrors orders-serve). */
export interface GrantsApp {
  get?(path: string, ...handlers: unknown[]): unknown;
  post?(path: string, ...handlers: unknown[]): unknown;
}
interface GrantsRequest {
  params: Record<string, string>;
}
interface GrantsResponse {
  status(code: number): GrantsResponse;
  type(t: string): GrantsResponse;
  send(body: string): unknown;
  redirect(status: number, url: string): unknown;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve spending grant</title><body style="font-family:system-ui;max-width:34rem;margin:0 auto;padding:3rem 1rem;line-height:1.55;background:#fff;color:#141413">${body}<p style="color:#888;font-size:13px;border-top:1px solid #ddd;padding-top:12px;margin-top:28px">🔒 delegated-demo — this page stands in for the wallet ceremony; no real money moves.</p></body>`;

/** Name the scope the way the human chose it, so the warning reads like their own sentence:
 *  a category grant says "Beverages includes…", a sku grant "The items you picked include…",
 *  an unbounded one "This store includes…". */
function scopeLabel(g: Grant): string {
  const categories = g.allow?.categories;
  if (categories?.length) return `${esc(categories.join(", "))} includes`;
  if (g.allow?.skus?.length) return "The items you picked include";
  return "This store includes";
}

/** The money line for one disclosed item — its catalog name when it has one, else its sku id. */
const itemLine = (i: { sku: string; name?: string; price: number }) => `${esc(i.name ?? i.sku)} — $${i.price}`;

/**
 * The age disclosure (#172): tell the human, BEFORE the tap, that the scope they are about to
 * approve contains items the agent will be refused on — and name them. Nothing is rendered for
 * a clean scope, so an unrestricted grant's page is unchanged.
 *
 * HONESTY: this is DISCLOSURE, and for a category grant a forecast made at approval time (a 21+
 * product added to that category next week could not have been predicted). The control is still
 * the server-side refusal at spend time, not this screen.
 */
function ageDisclosure(g: Grant, ageScope: GrantAgeScope, ageRailMounted: boolean): string {
  const minimumAge = ageScope.minimumAge;
  if (minimumAge == null) return "";
  const named = ageScope.items.map(itemLine).join(" · ");

  // Already proved, on this page, before the tap — say what it bought them.
  if (g.ageProof && g.ageProof.provenAge >= minimumAge) {
    return `<div style="border:1px solid #2f9e77;background:#e6f3ed;border-radius:10px;padding:12px 14px;margin:20px 0">
       <p style="margin:0 0 6px;font-weight:600;color:#1d6f52">✓ Age verified (${g.ageProof.provenAge}+).</p>
       <p style="margin:0;color:#1d6f52;font-size:14px">Your agent may buy these while you're away: ${named}</p>
     </div>`;
  }

  // Not proved. Step 1 — tell them. Step 2 — offer the way out, but only if the ceremony is
  // actually mounted; otherwise the honest thing is the warning alone.
  const verify = ageRailMounted
    ? `<p style="margin:12px 0 0"><a href="/credentagent/grants/${encodeURIComponent(g.id)}/age" style="display:inline-block;font-weight:600;padding:10px 16px;border-radius:9px;border:1px solid #2f9e77;background:#fff;color:#1d6f52;text-decoration:none">Verify ${minimumAge}+ with your wallet</a></p>`
    : "";
  return `<div style="border:1px solid #fab219;background:#fdf2da;border-radius:10px;padding:12px 14px;margin:20px 0">
       <p style="margin:0 0 6px;font-weight:600;color:#7a5606">⚠️ ${scopeLabel(g)} age-restricted items (${minimumAge}+).</p>
       <p style="margin:0;color:#7a5606;font-size:14px">Your agent can't buy these: ${named}</p>${verify}
     </div>`;
}

/** What the primary button says. Once age is on the table, "Approve" alone is ambiguous — the
 *  human is choosing between approving WITH the restricted items and approving without them. */
function approveLabel(g: Grant, ageScope: GrantAgeScope): string {
  const minimumAge = ageScope.minimumAge;
  if (minimumAge == null) return "✓ Approve";
  return g.ageProof && g.ageProof.provenAge >= minimumAge ? "✓ Approve" : "Approve without them";
}

const STATUS_LINE: Record<string, string> = {
  authorized: "✅ <strong>Approved.</strong> The agent may now spend within these bounds. You can close this tab.",
  denied: "⛔ <strong>Denied.</strong> This grant will never spend. You can close this tab.",
  revoked: "🚫 <strong>Revoked.</strong> No further spending is possible against this grant.",
};

/** Register the approve page + its POST actions onto `app` (called via `grants.serve(app)`). */
export function serveGrants(app: GrantsApp, grants: Grants): void {
  const get = app.get?.bind(app);
  const post = app.post?.bind(app);
  if (!get || !post) throw new Error("[credentagent] grants.serve(app): the app must expose Express-style get()/post().");

  get("/credentagent/grants/:id", async (req: GrantsRequest, res: GrantsResponse) => {
    const g = await grants.retrieve(req.params.id);
    if (!g) return res.status(404).type("html").send(page("<h1>Unknown grant</h1>"));
    if (g.status !== "pending") return res.status(200).type("html").send(page(`<h1>Spending grant</h1><p>${STATUS_LINE[g.status] ?? esc(g.status)}</p>`));
    const bounds = [
      `up to <strong>$${g.budget}</strong> total`,
      `max <strong>$${g.perSpend}</strong> per purchase`,
      ...(g.allow?.categories?.length ? [`only <strong>${esc(g.allow.categories.join(", "))}</strong>`] : []),
      ...(g.allow?.skus?.length ? [`only these items: <strong>${esc(g.allow.skus.join(", "))}</strong>`] : []),
    ].join(" · ");
    res.status(200).type("html").send(page(
      `<h1>Approve this spending grant?</h1>
       <p>${g.description ? esc(g.description) : "An AI agent asks to spend on your behalf while you're away."}</p>
       <p>${bounds}</p>
       ${ageDisclosure(g, g.ageScope, grants._ageRailMounted)}
       <form method="post" action="/credentagent/grants/${encodeURIComponent(g.id)}/approve" style="display:inline"><button style="font:inherit;font-weight:600;padding:10px 16px;border-radius:9px;border:0;background:#2f9e77;color:#fff;cursor:pointer">${approveLabel(g, g.ageScope)}</button></form>
       <form method="post" action="/credentagent/grants/${encodeURIComponent(g.id)}/deny" style="display:inline;margin-left:8px"><button style="font:inherit;font-weight:600;padding:10px 16px;border-radius:9px;border:1px solid #ccc;background:transparent;cursor:pointer">✗ Deny</button></form>`,
    ));
  });

  const act = (fn: (id: string) => Promise<boolean>) => async (req: GrantsRequest, res: GrantsResponse) => {
    const known = await grants.retrieve(req.params.id);
    if (!known) return res.status(404).type("html").send(page("<h1>Unknown grant</h1>"));
    await fn(req.params.id); // a non-pending grant is a no-op (terminal states stay terminal)
    res.redirect(303, `/credentagent/grants/${encodeURIComponent(req.params.id)}`);
  };
  post("/credentagent/grants/:id/approve", act((id) => grants._authorize(id)));
  post("/credentagent/grants/:id/deny", act((id) => grants._deny(id)));
}
