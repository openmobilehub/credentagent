// The router's vercel.json (#370): `/` answers Markdown to an agent that asks for it (Accept: text/markdown)
// and HTML to everyone else. The Markdown is this folder's domain.md, which describes the whole domain, with `Vary: Accept` so a CDN never serves one copy to the other.
// Vercel's edge can't run here, so this resolves the config the way Vercel does: the first matching
// rewrite wins, every matching `headers` entry applies, and a `has` header value is a regex.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const HTML = 'https://openmobilehub.github.io/credentagent-website/';
const MARKDOWN = '/domain.md';

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

// Vercel serves a file in the output directory (this folder, `outputDirectory: "."`) before any rewrite,
// and that includes `/`: a root `index.*` file answers `/` for every request, so no rewrite for `/` runs.
// (#399 shipped `index.md` here and credentagent.ai served Markdown to browsers; is-agentic dropped to 70.)
const rootIndex = () => readdirSync(new URL('.', import.meta.url)).find((f) => /^index\./i.test(f));
const isFile = (path) =>
  path === '/' ? Boolean(rootIndex()) : existsSync(new URL(`.${path}`, import.meta.url));

function resolve(path, headers = {}) {
  let destination = isFile(path) ? path : null;
  for (const r of destination ? [] : config.rewrites ?? []) {
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

// Each demo mints its checkout and consent links from the PUBLIC_URL its deploy workflow sets (#226).
// That address must be one this router forwards back to the same demo, or every link a buyer gets
// 404s (or lands on the other demo). SMOKE_URL is the workflow's own name for the demo's vercel.app host.
describe('router: each demo\'s PUBLIC_URL is a path this router serves from that demo', () => {
  for (const [workflow, want] of [
    ['deploy-prod.yml', 'https://credentagent.ai/marketplace'],
    ['deploy-dev.yml', 'https://credentagent.ai/marketplace-dev'],
  ]) {
    it(workflow, () => {
      const yml = readFileSync(new URL(`../../.github/workflows/${workflow}`, import.meta.url), 'utf8');
      const publicUrl = yml.match(/--env PUBLIC_URL=(\S+)/)?.[1];
      const smokeUrl = yml.match(/SMOKE_URL:\s*(\S+)/)?.[1];
      expect(publicUrl).toBe(want);
      expect(smokeUrl).toMatch(/^https:\/\/credentagent-demo(-dev)?\.vercel\.app$/);
      const { pathname } = new URL(publicUrl);
      expect(resolve(`${pathname}/checkout`).destination).toBe(`${smokeUrl}/checkout`);
      expect(resolve(`${pathname}/credentagent/passkey/request`).destination).toBe(
        `${smokeUrl}/credentagent/passkey/request`,
      );
    });
  }

  // The prod demo deploys examples/quickstart with the PUBLISHED packages. Before 0.6.0 (#228) their
  // pages fetch root paths, so under /marketplace every consent-page call would miss the store. A
  // caret on 0.x never crosses a minor, so `^0.5.0` stays on 0.5.x: pin both the range and the lock.
  it('the prod demo installs packages that support a path prefix (>= 0.6.0)', () => {
    const atLeast060 = (v) => {
      const [major, minor] = v.replace(/^[\^~]/, '').split('.').map(Number);
      return major > 0 || minor >= 6;
    };
    const quickstart = (f) => JSON.parse(readFileSync(new URL(`../../examples/quickstart/${f}`, import.meta.url), 'utf8'));
    const pkg = quickstart('package.json');
    const lock = quickstart('package-lock.json');
    for (const name of ['@openmobilehub/credentagent-gate', '@openmobilehub/credentagent-storefront']) {
      expect(atLeast060(pkg.dependencies[name]), `${name} range ${pkg.dependencies[name]}`).toBe(true);
      const locked = lock.packages[`node_modules/${name}`].version;
      expect(atLeast060(locked), `${name} locked at ${locked}`).toBe(true);
    }
  });
});

describe('router: domain.md, the domain\'s Markdown copy', () => {
  const file = new URL('./domain.md', import.meta.url);

  it('is a file in this folder, so Vercel serves it before any rewrite', () => {
    expect(existsSync(file)).toBe(true);
    expect(config.outputDirectory).toBe('.');
    expect(resolve('/domain.md').destination).toBe(MARKDOWN);
  });

  it('there is no index.* file in this folder: Vercel would serve it for / to browsers too', () => {
    expect(rootIndex()).toBeUndefined();
  });

  it('/index.md (listed in the website\'s sitemap) is rewritten to it', () => {
    expect(resolve('/index.md').destination).toBe(MARKDOWN);
  });

  it('is what the Markdown rewrite for / points at, not a path the catch-all would proxy', () => {
    const dest = resolve('/', { accept: 'text/markdown' }).destination;
    expect(dest).toBe(MARKDOWN);
    expect(isFile(dest)).toBe(true);
  });

  it('is typed text/markdown when fetched directly at /index.md or /domain.md', () => {
    expect(resolve('/index.md').headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(resolve('/domain.md').headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  it('names the domain\'s MCP endpoints, the presence-only trust level and the walletless demo path', () => {
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('https://credentagent.ai/marketplace/mcp');
    expect(md).toContain('https://credentagent.ai/marketplace-dev/mcp');
    expect(md).toContain('presence-only-demo');
    expect(md).toContain('instant demo');
  });
});
