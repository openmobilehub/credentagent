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

import type { Grants } from "./grants.js";

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
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve spending grant</title><body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.55">${body}<p style="color:#888;font-size:13px;border-top:1px solid #ddd;padding-top:12px;margin-top:28px">🔒 delegated-demo — this page stands in for the wallet ceremony; no real money moves.</p></body>`;

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
       <form method="post" action="/credentagent/grants/${encodeURIComponent(g.id)}/approve" style="display:inline"><button style="font:inherit;font-weight:600;padding:10px 16px;border-radius:9px;border:0;background:#2f9e77;color:#fff;cursor:pointer">✓ Approve</button></form>
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
