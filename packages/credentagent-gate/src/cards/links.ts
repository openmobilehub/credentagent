// Which links a card may open (spec 015 FR-11): an absolute `https:` URL, or `http:` on this machine
// for local development. Shared by both halves: `grant()` checks a link before it reaches the model's
// note, and the page checks again before it hands one to the host, since a grant result built without
// `grant()` still reaches the page. A leaf with no imports, so the page can bundle it.

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
