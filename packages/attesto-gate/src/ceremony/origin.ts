// Derive the WebAuthn / OpenID4VP RP identity from a request. rpID is the host
// without port; origin is <proto>://<host>. Honors x-forwarded-* (a TLS-terminating
// proxy such as Vercel rewrites these). Pure over a minimal request shape so it is
// unit-testable without a live server. The injected `origin` seam defaults to this.
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  host: string;
  protocol: string;
}

export interface Origin {
  rpID: string;
  origin: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function deriveOrigin(req: RequestLike): Origin {
  const host = first(req.headers["x-forwarded-host"]) ?? req.host;
  const proto = first(req.headers["x-forwarded-proto"]) ?? req.protocol;
  const rpID = host.split(":")[0];
  return { rpID, origin: `${proto}://${host}` };
}
