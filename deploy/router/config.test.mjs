// The router's vercel.json (#370): `/` answers Markdown to an agent that asks for it (Accept: text/markdown)
// and HTML to everyone else, with `Vary: Accept` so a CDN never serves one copy to the other.
// Vercel's edge can't run here, so this resolves the config the way Vercel does: the first matching
// rewrite wins, every matching `headers` entry applies, and a `has` header value is a regex.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const HTML = 'https://openmobilehub.org/credentagent/';
const MARKDOWN = 'https://openmobilehub.org/credentagent/index.md';

// The source patterns vercel.json uses: a literal path, or a prefix with a trailing `:path*`.
function matchSource(source, path) {
  const wild = source.match(/^(.*)\/:path\*$/);
  if (!wild) return source === path ? {} : null;
  const prefix = wild[1];
  if (path === prefix) return { path: '' };
  return path.startsWith(`${prefix}/`) ? { path: path.slice(prefix.length + 1) } : null;
}

function hasMatches(has = [], headers) {
  return has.every((c) => {
    if (c.type !== 'header') throw new Error(`unsupported has type ${c.type}`);
    const value = headers[c.key.toLowerCase()];
    if (value === undefined) return false;
    return c.value === undefined || new RegExp(`^${c.value}$`).test(value);
  });
}

function resolve(path, headers = {}) {
  let destination = null;
  for (const r of config.rewrites ?? []) {
    const params = matchSource(r.source, path);
    if (params && hasMatches(r.has, headers)) {
      destination = r.destination.replace(':path*', params.path ?? '');
      break;
    }
  }
  const out = {};
  for (const h of config.headers ?? []) {
    if (matchSource(h.source, path) && hasMatches(h.has, headers)) {
      for (const { key, value } of h.headers) out[key.toLowerCase()] = value;
    }
  }
  return { destination, headers: out };
}

const varyOf = (res) => (res.headers.vary ?? '').split(',').map((s) => s.trim().toLowerCase());

describe('router: / content negotiation', () => {
  it('Accept: text/markdown gets the Markdown copy, typed text/markdown, varying on Accept', () => {
    const res = resolve('/', { accept: 'text/markdown' });
    expect(res.destination).toBe(MARKDOWN);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(varyOf(res)).toEqual(expect.arrayContaining(['accept', 'accept-encoding']));
  });

  it('a mixed Accept that lists text/markdown still gets Markdown', () => {
    const res = resolve('/', { accept: 'text/html;q=0.9, text/markdown' });
    expect(res.destination).toBe(MARKDOWN);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  for (const [name, headers] of [
    ['Accept: text/html', { accept: 'text/html' }],
    ['a browser Accept', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }],
    ['no Accept header', {}],
  ]) {
    it(`${name} gets the HTML page, with no Markdown type override, still varying on Accept`, () => {
      const res = resolve('/', headers);
      expect(res.destination).toBe(HTML);
      expect(res.headers['content-type']).toBeUndefined();
      expect(varyOf(res)).toEqual(expect.arrayContaining(['accept', 'accept-encoding']));
    });
  }

  it('the conditional Markdown rewrite comes before the unconditional / rewrite', () => {
    const slash = config.rewrites.map((r, i) => ({ ...r, i })).filter((r) => r.source === '/');
    const md = slash.find((r) => r.destination === MARKDOWN);
    const html = slash.find((r) => r.destination === HTML && !r.has);
    expect(md && html).toBeTruthy();
    expect(md.i).toBeLessThan(html.i);
  });
});

describe('router: other routes are unaffected by Accept: text/markdown', () => {
  for (const [path, want] of [
    ['/marketplace/mcp', 'https://credentagent-demo.vercel.app/mcp'],
    ['/marketplace-dev/checkout', 'https://credentagent-demo-dev.vercel.app/checkout'],
  ]) {
    it(path, () => {
      const res = resolve(path, { accept: 'text/markdown' });
      expect(res.destination).toBe(want);
      expect(res.headers['content-type']).toBeUndefined();
    });
  }
});
