// `@openmobilehub/credentagent-gate/cards` — the card kit (spec 015): one card page any MCP server
// serves to Claude and ChatGPT, and the tool results that render as cards on it.
//
//   const cards = createCards({ readPermission });                   // once per process
//   cards.register(server);                                           // per server instance
//   server.registerTool("request-permission", { inputSchema, _meta: cards.toolMeta() }, async (a) => cards.permission({ … }));
//   server.registerTool("check-permission", { inputSchema }, async ({ grantId }) => reply(await cards.waitForSignature(grantId)));
//
// A card only shows; it never decides — every limit is enforced on the server (security invariant 1).

import { loadCardsPage } from "./page.js";
import { cardToolMeta, cardUris, registerCardResources, registerPermissionStatusTool, type CardsServer, type CardToolMeta } from "./meta.js";
import { cardResult, type CardResult } from "./results.js";
import { createPermissionWatch, type PermissionStatus, type ReadPermission, type UnknownPermission } from "./permissions.js";
import { qrDataUrl } from "./qr.js";
import { PERMISSION_KIND, QR_META_KEY, type PermissionCardData, type PermissionInput } from "./contract.js";
import type { GrantViewData } from "./grant-view.js";

export interface CardsOptions<R extends PermissionStatus = PermissionStatus> {
  /** How to read a permission's live status. Needed for permission cards: the card follows the
   *  signature through it, and `waitForSignature` holds on it. */
  readPermission?: ReadPermission<R>;
  /** How long `waitForSignature` holds before answering "pending" (default 45 000 ms — under claude.ai's
   *  60 s tool-call limit, like the storefront's `approvalHoldMs`). Only takes effect with `readPermission`. */
  holdMs?: number;
  /** After the model last heard "pending", how long it still counts as waiting in its own turn — the
   *  card stays quiet meanwhile (default 20 000 ms). Only takes effect with `readPermission`. */
  modelGraceMs?: number;
}

export interface Cards<R extends PermissionStatus = PermissionStatus> {
  /** The card page itself — serve it on a route to preview every card without a chat (`?view=`). */
  readonly html: string;
  /** Register the card page on an MCP server, once per server instance (a stateless server builds one per request). */
  register(server: CardsServer): void;
  /** The tool `_meta` that makes a tool's result render as a card, in Claude and ChatGPT alike. */
  toolMeta(status?: { invoking?: string; invoked?: string }): CardToolMeta;
  /** A tool result that shows a grant; the gallery picks the view that fits it. */
  grant(view: GrantViewData, options?: { note?: string }): CardResult;
  /** A tool result that asks the person to sign a permission on their phone: the card shows a QR code
   *  of `approveUrl` and follows the signature live. Requires `readPermission`. */
  permission(input: PermissionInput, options?: { note?: string }): CardResult;
  /** The model's wait for the signature, in its own turn: holds up to `holdMs` and answers what
   *  `readPermission` answered — `{ status: "unknown" }` for a grant this process never issued. */
  waitForSignature(grantId: string): Promise<R | UnknownPermission>;
}

const GRANT_NOTE = "If the person can see this grant in a card, don't repeat its numbers; say in a sentence what changed.";

const PERMISSION_NOTE =
  "The person sees a card with a QR code for approveUrl. In one short sentence, ask them to scan it with their phone and sign " +
  "(give them the link too). Then, without ending your turn, wait for the signature: call the tool that checks it, and again " +
  "while it says pending. When it says authorized, continue. Don't ask the person to confirm they signed.";

const NEEDS_READER = "createCards({ readPermission }) is required for permission cards: the card follows the signature through it.";

/** Configure once per process. Reads the built page now, so a missing build fails at startup, not mid-chat. */
export function createCards<R extends PermissionStatus = PermissionStatus>(config: CardsOptions<R> = {}): Cards<R> {
  const page = loadCardsPage();
  const uris = cardUris(page.hash);
  const watch = config.readPermission
    ? createPermissionWatch({ read: config.readPermission, holdMs: config.holdMs ?? 45_000, modelGraceMs: config.modelGraceMs ?? 20_000 })
    : undefined;
  return {
    html: page.html,
    register(server) {
      registerCardResources(server, page.html, uris);
      if (watch) registerPermissionStatusTool(server, (grantId) => watch.cardStatus(grantId));
    },
    toolMeta: (status) => cardToolMeta(uris, status),
    grant: (view, options) => cardResult(view, options?.note ?? GRANT_NOTE),
    permission(input, options) {
      if (!watch) throw new Error(NEEDS_READER);
      if (typeof input.trustLevel !== "string" || input.trustLevel === "") {
        throw new Error('cards.permission(): trustLevel is required — say out loud what the purchase will be verified at (e.g. "presence-only-demo").');
      }
      const qr = qrDataUrl(input.approveUrl); // before `issued`: a failed QR must not leave a remembered permission behind
      watch.issued(input);
      const data: PermissionCardData = { kind: PERMISSION_KIND, ...input };
      return cardResult(data, options?.note ?? PERMISSION_NOTE, { [QR_META_KEY]: qr });
    },
    waitForSignature: (grantId) => (watch ? watch.waitForSignature(grantId) : Promise.reject(new Error(NEEDS_READER))),
  };
}

export { GRANT_VIEW_KIND } from "./grant-view.js";
export type { GrantViewData, GrantViewProduct } from "./grant-view.js";
export { PERMISSION_KIND, PERMISSION_STATUS_TOOL, QR_META_KEY } from "./contract.js";
export type { PermissionCardData, PermissionInput, PermissionStatusAnswer } from "./contract.js";
export type { PermissionStatus, ReadPermission, UnknownPermission } from "./permissions.js";
export type { CardsServer, CardToolMeta } from "./meta.js";
export type { CardResult } from "./results.js";
