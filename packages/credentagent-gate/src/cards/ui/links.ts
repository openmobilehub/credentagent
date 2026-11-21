// Which links a card may open (spec 015 FR-11): an absolute `https:` URL, or `http:` on this machine
// for local development. A grant result built without the server half's own check still reaches the
// page, so the page checks too before it hands a link to the host.

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isSafeLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // a relative path or no URL at all
  }
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname));
}
