// The dSD-JWT compact serialization — Delegate SD-JWT §5.1.1 — and nothing else.
//
//   <SD-JWT>~~<KB-SD-JWT 1>~<disclosures…>~~ … ~~<KB-SD-JWT n>~<disclosures…>~
//
// Each link is an SD-JWT in its own right; the empty component between two links is what marks
// where one ends. The chain this package handles is a dSD-JWT (it ends in `~`), never a
// dSD-JWT+KB: AP2's agent signs its purchase as a terminal KB-SD-JWT hop, not as a trailing
// KB-JWT, and the AP2 Python SDK does the same.
//
// RISK, stated where the format lives: the draft is an individual Internet-Draft with no formal
// standing, and it expires 2026-10-23. The revision implemented is pinned below so a reader can
// tell which text this code follows, and so a later revision is one deliberate change.

/** The Delegate SD-JWT text this module implements. */
export const DELEGATE_SD_JWT_REVISION = "draft-gco-oauth-delegate-sd-jwt-00";

/** One link of a chain: its signed JWT and the disclosures presented with it. */
export interface ChainLink {
  jwt: string;
  disclosures: string[];
}

const isCompactJwt = (s: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s);

/**
 * Join links, each an SD-JWT serialization ending in `~`, into one dSD-JWT.
 *
 * A link's trailing `~` plus the `~` this adds is the empty component §5.1.1 requires between
 * links — so the separator falls out of the format rather than being invented here.
 */
export function joinChain(links: string[]): string {
  return links.map((l, i) => (i < links.length - 1 && l.endsWith("~") ? l.slice(0, -1) : l)).join("~~");
}

/** The SD-JWT serialization of one link, with its trailing `~` — what an `sd_hash` is taken over. */
export function linkToString(link: ChainLink): string {
  return `${link.jwt}~${link.disclosures.map((d) => `${d}~`).join("")}`;
}

/**
 * Split a dSD-JWT into its links. `undefined` for anything that is not a chain of at least two
 * links: a single link is a plain SD-JWT, not a delegation, and must not be read as a chain whose
 * hops all "checked out" because there were none.
 */
export function splitChain(token: string): ChainLink[] | undefined {
  if (!token.endsWith("~")) return undefined; // a trailing KB-JWT (dSD-JWT+KB) is not the AP2 shape
  const segments = token.split("~~");
  if (segments.length < 2) return undefined;
  const links: ChainLink[] = [];
  for (const [i, segment] of segments.entries()) {
    const body = i === segments.length - 1 ? segment.slice(0, -1) : segment;
    const [jwt, ...disclosures] = body.split("~");
    if (!jwt || !isCompactJwt(jwt) || disclosures.some((d) => d === "" || isCompactJwt(d))) return undefined;
    links.push({ jwt, disclosures });
  }
  return links;
}

/**
 * The first two links of a chain, from what the intent-sign rail holds after a ceremony: the
 * wallet's presentation `<credential>~<disclosures>~<KB-SD-JWT>` and ONE of the `delegate`
 * disclosures the request carried.
 *
 * The wallet's key binding IS the second link (Delegate SD-JWT §4: "the KB-JWT in the preceding
 * SD-JWT+KB fulfils the role of the Issuer-JWT for the next"). Its disclosures were never on
 * the wire — the verifier sent them in the request — so they are re-attached here, one at a
 * time: §5.1.4 requires exactly one delegate payload disclosed per chain.
 */
export function walletChain(presentation: string, disclosure: string): string | undefined {
  const cut = presentation.lastIndexOf("~");
  const kbJwt = presentation.slice(cut + 1);
  if (cut < 0 || !isCompactJwt(kbJwt)) return undefined;
  return joinChain([presentation.slice(0, cut + 1), `${kbJwt}~${disclosure}~`]);
}
