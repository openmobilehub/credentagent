// grants.serve(app) — make `grant.approveUrl` a REAL page (a P1 on #112: the documented
// create-and-send-the-link flow 404'd; only the demo's private endpoints could authorize).
//
//   credentagent.grants.serve(app);
//   const grant = await credentagent.grants.create({ ... });
//   sendToUser(grant.approveUrl);        // → GET /credentagent/grants/:id
//
// One call wires everything that page needs: the page itself, the intent-sign rail a device-mode
// grant signs through (spec 012), and the grant-credential rail the human presents wallet
// credentials on before authorizing (#172). No `mount()` required — a host that only does grants
// never has to assemble a checkout's ceremony seams to serve this.
//
// TWO MODES, ONE SHAPE. A device-mode grant (the default) authorizes on a real wallet signature
// over its exact bounds; a page-mode grant authorizes on a tap. Either way the page reads the
// same: the limits, a numbered rail of only the steps THIS grant has, one card per step, and the
// authorization last.
//
// HONESTY: in page mode the tap stands in for the wallet ceremony (presence "delegated-demo").
// In device mode the signature is real (trust_level "device-signed") but its trust anchor is a
// demo credential until issuer verification lands (#14). Wallet credentials presented on the way
// are "presence-only-demo" on the same footing.

import type { Grant, Grants } from "./grants.js";
import type { GrantAgeScope } from "./grants-age.js";
import type { Branding } from "./types.js";
import { registerIntentSignRail } from "./ceremony/intent-sign/routes.js";
import { renderIntentSignPage } from "./ceremony/intent-sign/page.js";
import { registerGrantCredentialGate } from "./ceremony/grant-credential/routes.js";
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
 * The honesty line for the PAGE-mode page, in the shared `.trust` chrome. Deliberately not
 * `theme.trustFooter()` (fixed to the OpenID4VP rails' claim) and not the device page's
 * `deviceSignedTrustFooter()` — a tap-to-approve is a third, weaker act and says so itself.
 */
const trustLine = (g?: Grant) =>
  `<div class="trust"><div class="trust-line">🔒 delegated-demo — approving here stands in for the wallet ceremony; no real money moves.${
    g?.ageProof || g?.membershipProof
      ? " The wallet credential is presence-only-demo: the wire crypto is real; the issuer trust anchor is not."
      : ""
  }</div></div>`;

/** What the grant is bounded to, as a plain-English row value. */
function scopeValue(g: Grant): string {
  if (g.allow?.skus?.length) return esc(g.allow.skus.join(", "));
  const categories = g.allow?.categories;
  if (categories?.length) return esc(categories.join(", "));
  return `Anything at ${esc(g.merchant)}`;
}

/** The limits card — the grant's answer to the checkout hub's order-summary card. */
function limitsCard(g: Grant): string {
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

/** True once the human has proved an age that covers every restricted product the grant names. */
const ageProved = (g: Grant, scope: GrantAgeScope) =>
  scope.minimumAge != null && g.ageProof != null && g.ageProof.provenAge >= scope.minimumAge;

/**
 * The age step (#172) — mirroring the checkout hub's numbered gate card.
 *
 * The copy tells the human WHICH question this is answering, because the two are different
 * promises. A grant that NAMES its products (the storefront pins the exact one before the link
 * exists — #175) gets a closed list: this is what it's for. A grant bounded by a CATEGORY gets
 * what that category holds today, said as such — a product added to it next week could not have
 * been predicted, and the page must not imply a guarantee it can't keep.
 *
 * Either way the offer is the same and so is the enforcement: the proof is threshold-checked
 * against each purchase's OWN product at spend time, so an incomplete forecast can only fail to
 * offer this step — never let something through that wasn't proved for.
 */
function ageCard(g: Grant, scope: GrantAgeScope, n: number): string {
  const minimumAge = scope.minimumAge;
  if (minimumAge == null) return "";
  const no = `<span class="step-no">${n}.</span>`;

  if (ageProved(g, scope)) {
    return `<div class="card">
    <div class="row-ok">${no} ✓ Age verified — ${g.ageProof!.provenAge}+</div>
    <p class="small" style="margin:10px 0 0">Your agent may buy age-restricted items up to ${g.ageProof!.provenAge}+ while you're away. Anything stricter still comes back to you.</p>
  </div>`;
  }
  const rows = scope.items
    .map((i) => `<tr class="line"><td>${esc(i.name ?? i.sku)}</td><td class="num">${usd(i.price)}</td></tr>`)
    .join("\n      ");
  const scanned = scope.from === "scanned";
  const categories = g.allow?.categories;
  const lede = scanned
    ? `🔒 ${categories?.length ? `${esc(categories.join(", "))} includes` : "This store includes"} age-restricted items (${minimumAge}+). Your agent can't buy them unless you prove your age:`
    : `🔒 This grant is for age-restricted items (${minimumAge}+). Your agent can't buy them unless you prove your age:`;
  // The honest limit, stated only where it applies: a scan is what the shelf holds right now.
  const caveat = scanned
    ? `<p class="small" style="margin:10px 0 0">That's what this ${categories?.length ? "category holds" : "store holds"} today. If something stricter is added later, it comes back to you even after you verify.</p>`
    : "";
  return `<div class="card summary">
    <div class="row-pending">${no} ${lede}</div>
    <table style="margin-top:10px">
      ${rows}
    </table>${caveat}
    <div style="margin-top:12px;"><a class="btn btn-primary" href="/credentagent/grants/${encodeURIComponent(g.id)}/age">Verify ${minimumAge}+ with your wallet</a></div>
  </div>`;
}

/**
 * The membership step (#172) — the mirror of the age step, and of the hub's discount gate. Where
 * age UNLOCKS items, this LOWERS the price of every purchase. Renders only when the host
 * configured a loyalty rate: no programme, no step.
 */
function membershipCard(g: Grant, pct: number | undefined, n: number): string {
  if (pct == null) return "";
  const no = `<span class="step-no">${n}.</span>`;
  const proof = g.membershipProof;
  if (proof) {
    return `<div class="card">
    <div class="row-ok">${no} ✓ Membership applied — ${proof.discountPct}% off</div>
    <p class="small" style="margin:10px 0 0">Member ${esc(proof.membershipNumber)} · every purchase your agent makes under this grant is discounted.</p>
  </div>`;
  }
  return `<div class="card">
    <div class="row-pending">${no} Take ${pct}% off every purchase your agent makes under this grant by presenting your membership. Optional — the grant works without it.</div>
    <div style="margin-top:12px;"><a class="btn btn-secondary" href="/credentagent/grants/${encodeURIComponent(g.id)}/membership">Apply loyalty discount (${pct}% off)</a></div>
  </div>`;
}

/**
 * The steps this grant has, as rail entries + the rendered cards, numbered as ONE sequence.
 * `final` is what the last step is called — "Approve" for a page-mode tap, "Sign" for a
 * device-mode signature. A grant with a single step gets no rail: a one-dot stepper says nothing.
 */
function stepsFor(g: Grant, loyaltyPct: number | undefined, final: string): { rail: string; cards: string; nextNo: number } {
  const scope = g.ageScope;
  const hasAge = scope.minimumAge != null;
  const steps: RailStep[] = [
    ...(hasAge ? [{ label: "Age", done: ageProved(g, scope) }] : []),
    ...(loyaltyPct != null ? [{ label: "Membership", done: g.membershipProof != null }] : []),
    { label: final, done: false },
  ];
  const ageNo = hasAge ? 1 : 0;
  const memberNo = loyaltyPct != null ? ageNo + 1 : ageNo;
  return {
    rail: steps.length > 1 ? progressRail(steps, steps.findIndex((s) => !s.done)) : "",
    cards: `${ageCard(g, scope, ageNo)}\n  ${membershipCard(g, loyaltyPct, memberNo)}`,
    nextNo: memberNo + 1,
  };
}

/** The page-mode decision card — always last, the way payment is last on the checkout hub. */
function decisionCard(g: Grant, n: number): string {
  const withheld = g.ageScope.minimumAge != null && !ageProved(g, g.ageScope);
  // Once age is on the table, "Approve" alone is ambiguous: the human is choosing between
  // approving WITH the restricted items and approving without them. Say which one this is.
  const label = withheld ? "Approve without them" : "✓ Approve";
  const lede = withheld
    ? `Your agent will be able to spend within these limits, but will be refused on the ${g.ageScope.minimumAge}+ items above.`
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
  authorized: { row: "row-ok", text: "✓ Authorized — your agent may now spend within these limits. You can close this tab." },
  denied: { row: "row-pending", text: "⛔ Denied — this grant will never spend. You can close this tab." },
  revoked: { row: "row-pending", text: "🚫 Revoked — no further spending is possible against this grant." },
};

/** Register the grant page, its POST actions, and the two rails it needs. */
export function serveGrants(app: GrantsApp, grants: Grants): void {
  const get = app.get?.bind(app);
  const post = app.post?.bind(app);
  if (!get || !post) throw new Error("[credentagent] grants.serve(app): the app must expose Express-style get()/post().");

  // The intent-sign endpoints for device-mode grants (spec 012): /sign/request + /sign/verify.
  registerIntentSignRail(app, grants);
  // The wallet credentials a human may present before authorizing (#172): /age, /membership.
  registerGrantCredentialGate(app, grants);

  const branding = grants.railConfig.branding;
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

    const loyaltyPct = grants.railConfig.loyaltyDiscountPct;

    // A device-mode grant's approveUrl IS the signing ceremony (spec 012, FR-3): the wallet signs
    // the Intent Mandate — there is no click-to-approve for it. The credential steps ride the same
    // page, ABOVE the signature, because what the human proves there is part of what they sign
    // (the proofs are inside `canonicalIntentBounds` — #172).
    if (g.signing === "device") {
      const { rail, cards } = stepsFor(g, loyaltyPct, "Sign");
      return res.status(200).type("html").send(
        renderIntentSignPage({
          grantId: g.id,
          merchant: g.merchant,
          budget: g.budget,
          perSpend: g.perSpend,
          ...(g.allow ? { allow: g.allow } : {}),
          ...(g.description ? { description: g.description } : {}),
          returnUrl: `/credentagent/grants/${encodeURIComponent(g.id)}`,
          ...(rail ? { rail } : {}),
          ...(cards.trim() ? { steps: cards } : {}),
          ...(branding ? { branding } : {}),
        }),
      );
    }

    const { rail, cards, nextNo } = stepsFor(g, loyaltyPct, "Approve");
    res.status(200).type("html").send(
      shell(`Approve spending grant · ${g.id}`, `${brandHeader(
        // The page-mode heading is the one main's device-grant suite pins ("a page-mode grant's
        // approveUrl still serves the click-to-approve page") — it also reads better here than a
        // bare noun, because this page IS the decision.
        { h1: "Approve this spending grant?", tagline: g.description ?? "An AI agent asks to spend on your behalf while you're away." },
        branding,
      )}
  ${limitsCard(g)}
  ${rail}
  ${cards}
  ${decisionCard(g, nextNo)}
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
