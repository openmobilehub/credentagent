// grants.serve(app) — make `grant.approveUrl` a REAL page (a P1 on #112: the documented
// create-and-send-the-link flow 404'd; only the demo's private endpoints could authorize).
//
//   credentagent.grants.serve(app);
//   const grant = await credentagent.grants.create({ ... });
//   sendToUser(grant.approveUrl);        // → GET /credentagent/grants/:id — Approve / Deny
//
// The page is built from the SAME design system as the checkout hub and the ceremony gate pages
// (theme.ts: pageHead / brandHeader / progressRail / the card + btn chrome), so a human who
// approves a grant and a buyer who checks out are looking at one product, not two. It follows the
// hub's shape exactly — brand header, a summary card, a numbered progress rail, one card per step,
// the decision last — and, like the hub, the rail lists ONLY the steps this grant actually has
// (#172): an age step when the granted scope contains age-restricted items, a membership step when
// the host runs a loyalty programme. A grant with nothing to prove is a single decision, so it
// gets no stepper at all.
//
// HONESTY: this page is the DEMO stand-in for the wallet ceremony — clicking Approve seals the
// intent server-side (presence "delegated-demo"). The wallet key-signing ceremony (#71) replaces
// this page and calls the SAME _authorize/_deny seams; the URL contract doesn't change. When a
// wallet credential has been captured, the footer states that claim's own weaker posture too
// (presence-only-demo — real wire crypto, no issuer trust anchor yet).

import type { Grant, Grants } from "./grants.js";
import type { GrantAgeScope } from "./grants-age.js";
import type { Branding } from "./types.js";
import { pageHead, brandHeader, progressRail, type RailStep } from "./ceremony/theme.js";

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

/** Grants are USD-only (the engine seals `currency: "USD"`), so one formatter covers the page. */
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The page shell — the shared chrome every ceremony page wears. */
const shell = (title: string, body: string, branding?: Branding) =>
  `<!doctype html>
<html lang="en">
${pageHead(title, "", branding)}
<body>
  <div class="wrap">
${body}
  </div>
</body>
</html>`;

/**
 * The honesty line, in the shared `.trust` chrome. It states THIS page's posture
 * ("delegated-demo" — approving here stands in for the wallet ceremony) and, once an age proof
 * has been captured, that proof's own separate and weaker posture. Deliberately not
 * `theme.trustFooter()`: that line is fixed to the OpenID4VP rails' presence-only claim, and a
 * grant approval is a different act with a different honest answer.
 */
const trustLine = (g?: Grant) =>
  `<div class="trust"><div class="trust-line">🔒 delegated-demo — approving here stands in for the wallet ceremony; no real money moves.${
    g?.ageProof || g?.membershipProof
      ? " The wallet credential is presence-only-demo: the wire crypto is real; the issuer trust anchor is not."
      : ""
  }</div></div>`;

/** Name the scope the way the human chose it, so the warning reads like their own sentence:
 *  a category grant says "Beverages includes…", a sku grant "The items you picked include…",
 *  an unbounded one "This store includes…". */
function scopeLabel(g: Grant): string {
  const categories = g.allow?.categories;
  if (categories?.length) return `${esc(categories.join(", "))} includes`;
  if (g.allow?.skus?.length) return "The items you picked include";
  return "This store includes";
}

/** What the grant is bounded to, as a plain-English row value. */
function scopeValue(g: Grant): string {
  const categories = g.allow?.categories;
  if (categories?.length) return esc(categories.join(", "));
  if (g.allow?.skus?.length) return esc(g.allow.skus.join(", "));
  return `Anything at ${esc(g.merchant)}`;
}

/** The limits card — the grant's answer to the hub's order-summary card. The budget is the
 *  bold total row because it is the number the human is actually deciding on. */
function limitsCard(g: Grant): string {
  // Once a membership is proved, the discount is a term of the grant — show it here, in the accent
  // row the checkout summary uses for exactly this, rather than only inside the step card.
  const loyalty = g.membershipProof
    ? `<tr class="disc"><td>Loyalty discount (${g.membershipProof.discountPct}%)</td><td class="num">on every purchase</td></tr>`
    : "";
  return `<div class="card summary">
    <p class="card-title">Spending limits</p>
    <table>
      <tr class="line"><td>Max per purchase</td><td class="num">${usd(g.perSpend)}</td></tr>
      <tr class="line"><td>Allowed</td><td class="num">${scopeValue(g)}</td></tr>
      ${loyalty}
      <tr class="total"><td>Total budget</td><td class="num">${usd(g.budget)}</td></tr>
    </table>
  </div>`;
}

/** True once the human has proved an age that covers everything restricted in this scope. */
const ageProved = (g: Grant, scope: GrantAgeScope) =>
  scope.minimumAge != null && g.ageProof != null && g.ageProof.provenAge >= scope.minimumAge;

/**
 * The age step's card (#172), mirroring the hub's numbered gate card.
 *
 * UNPROVED — it names what the agent will be refused on, as a line-item table, and offers the
 * wallet ceremony. The button appears ONLY when that ceremony is actually mounted: a host that
 * calls `grants.serve(app)` without `mount(app)` gets the disclosure alone, never a dead link.
 *
 * PROVED — one ✓ row, plus what it bought the human.
 *
 * HONEST LIMIT: for a category grant this is a FORECAST made at approval time (a 21+ product
 * added to that category next week could not have been predicted). The control is the
 * server-side refusal at spend time; this screen is disclosure.
 */
function ageCard(g: Grant, scope: GrantAgeScope, n: number, railMounted: boolean): string {
  const minimumAge = scope.minimumAge;
  if (minimumAge == null) return "";
  const no = `<span class="step-no">${n}.</span>`;

  if (ageProved(g, scope)) {
    return `<div class="card">
    <div class="row-ok">${no} ✓ Age verified — ${g.ageProof!.provenAge}+</div>
    <p class="card-title" style="margin:10px 0 0;text-transform:none;letter-spacing:0;font-weight:400">Your agent may buy the age-restricted items above while you're away.</p>
  </div>`;
  }

  const rows = scope.items
    .map((i) => `<tr class="line"><td>${esc(i.name ?? i.sku)}</td><td class="num">${usd(i.price)}</td></tr>`)
    .join("\n      ");
  const verify = railMounted
    ? `<div style="margin-top:12px;"><a class="btn btn-primary" href="/credentagent/grants/${encodeURIComponent(g.id)}/age">Verify ${minimumAge}+ with your wallet</a></div>`
    : "";
  return `<div class="card summary">
    <div class="row-pending">${no} 🔒 ${scopeLabel(g)} age-restricted items (${minimumAge}+). Your agent can't buy these:</div>
    <table style="margin-top:10px">
      ${rows}
    </table>${verify}
  </div>`;
}

/**
 * The membership step's card (#172) — the mirror of the age card, and of the hub's discount gate.
 * Where age UNLOCKS items, this LOWERS the price of every purchase the agent makes under the grant.
 *
 * Optional by nature: declining still approves the grant, at full catalog price. It renders only
 * when the host configured a loyalty rate (`new CredentAgent({ loyaltyDiscountPct })`) — no
 * programme, no step — and the button only when the ceremony is actually mounted.
 */
function membershipCard(g: Grant, pct: number | undefined, n: number, railMounted: boolean): string {
  if (pct == null) return "";
  const no = `<span class="step-no">${n}.</span>`;
  const proof = g.membershipProof;
  if (proof) {
    return `<div class="card">
    <div class="row-ok">${no} ✓ Membership applied — ${proof.discountPct}% off</div>
    <p class="card-title" style="margin:10px 0 0;text-transform:none;letter-spacing:0;font-weight:400">Member ${esc(proof.membershipNumber)} · every purchase your agent makes under this grant is discounted.</p>
  </div>`;
  }
  const present = railMounted
    ? `<div style="margin-top:12px;"><a class="btn btn-secondary" href="/credentagent/grants/${encodeURIComponent(g.id)}/membership">Apply loyalty discount (${pct}% off)</a></div>`
    : "";
  return `<div class="card">
    <div class="row-pending">${no} Take ${pct}% off every purchase your agent makes under this grant by presenting your membership. Optional — the grant works without it.</div>${present}
  </div>`;
}

/** The decision card — always last, the way payment is last on the hub. */
function decisionCard(g: Grant, scope: GrantAgeScope, n: number): string {
  const withheld = scope.minimumAge != null && !ageProved(g, scope);
  // Once age is on the table, "Approve" alone is ambiguous: the human is choosing between
  // approving WITH the restricted items and approving without them. Say which one this is.
  const label = withheld ? "Approve without them" : "✓ Approve";
  const lede = withheld
    ? `Your agent will be able to spend within these limits, but will be refused on the ${scope.minimumAge}+ items above.`
    : "Your agent can spend within these limits until the budget runs out, or until you revoke it.";
  const action = (verb: string) => `/credentagent/grants/${encodeURIComponent(g.id)}/${verb}`;
  return `<div class="card">
    <p class="card-title"><span class="step-no">${n}.</span> Your decision</p>
    <p class="row-pending" style="margin:0 0 14px">${lede}</p>
    <form method="post" action="${action("approve")}"><button class="btn btn-primary" type="submit">${label}</button></form>
    <form method="post" action="${action("deny")}" style="margin-top:10px"><button class="btn btn-secondary" type="submit">✗ Deny</button></form>
  </div>`;
}

/** What a grant that is no longer pending says, and how that reads. */
const STATUS_LINE: Record<string, { row: "row-ok" | "row-pending"; text: string }> = {
  authorized: { row: "row-ok", text: "✓ Approved — your agent may now spend within these limits. You can close this tab." },
  denied: { row: "row-pending", text: "⛔ Denied — this grant will never spend. You can close this tab." },
  revoked: { row: "row-pending", text: "🚫 Revoked — no further spending is possible against this grant." },
};

/** Register the approve page + its POST actions onto `app` (called via `grants.serve(app)`). */
export function serveGrants(app: GrantsApp, grants: Grants): void {
  const get = app.get?.bind(app);
  const post = app.post?.bind(app);
  if (!get || !post) throw new Error("[credentagent] grants.serve(app): the app must expose Express-style get()/post().");

  const branding = grants._branding;
  const notFound = () => shell("Spending grant", `${brandHeader({ h1: "Spending grant", tagline: "This link doesn't match a grant." }, branding)}
  <div class="card"><div class="row-pending">We don't recognise this grant. It may have been created by a different server, or the link may be incomplete.</div></div>
  ${trustLine()}`, branding);

  get("/credentagent/grants/:id", async (req: GrantsRequest, res: GrantsResponse) => {
    const g = await grants.retrieve(req.params.id);
    if (!g) return res.status(404).type("html").send(notFound());

    if (g.status !== "pending") {
      const line = STATUS_LINE[g.status];
      return res.status(200).type("html").send(
        shell(`Spending grant · ${g.id}`, `${brandHeader({ h1: "Spending grant", tagline: `At ${g.merchant}` }, branding)}
  ${limitsCard(g)}
  <div class="card"><div class="${line?.row ?? "row-pending"}">${line ? line.text : esc(g.status)}</div></div>
  ${trustLine(g)}`, branding),
      );
    }

    const scope = g.ageScope;
    const loyaltyPct = grants._loyaltyDiscountPct;
    // The rail lists only the steps this grant HAS (the hub's rule): an age step when the scope is
    // age-restricted, a membership step when the host runs a loyalty programme, then the decision.
    // A single-step rail says nothing a stepper is for, so a grant with nothing to prove gets none.
    const steps: RailStep[] = [
      ...(scope.minimumAge != null ? [{ label: "Age", done: ageProved(g, scope) }] : []),
      ...(loyaltyPct != null ? [{ label: "Membership", done: g.membershipProof != null }] : []),
      { label: "Approve", done: false },
    ];
    const rail = steps.length > 1 ? progressRail(steps, steps.findIndex((s) => !s.done)) : "";
    // The numbers on the cards are the numbers on the rail — one sequence, never two.
    const ageNo = scope.minimumAge != null ? 1 : 0;
    const memberNo = loyaltyPct != null ? ageNo + 1 : ageNo;

    res.status(200).type("html").send(
      shell(`Approve spending grant · ${g.id}`, `${brandHeader(
        {
          h1: "Spending grant",
          tagline: g.description ?? "An AI agent asks to spend on your behalf while you're away.",
        },
        branding,
      )}
  ${limitsCard(g)}
  ${rail}
  ${ageCard(g, scope, ageNo, grants._credentialRailMounted)}
  ${membershipCard(g, loyaltyPct, memberNo, grants._credentialRailMounted)}
  ${decisionCard(g, scope, memberNo + 1)}
  ${trustLine(g)}`, branding),
    );
  });

  const act = (fn: (id: string) => Promise<boolean>) => async (req: GrantsRequest, res: GrantsResponse) => {
    const known = await grants.retrieve(req.params.id);
    if (!known) return res.status(404).type("html").send(notFound());
    await fn(req.params.id); // a non-pending grant is a no-op (terminal states stay terminal)
    res.redirect(303, `/credentagent/grants/${encodeURIComponent(req.params.id)}`);
  };
  post("/credentagent/grants/:id/approve", act((id) => grants._authorize(id)));
  post("/credentagent/grants/:id/deny", act((id) => grants._deny(id)));
}
