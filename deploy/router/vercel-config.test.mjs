// The router's vercel.json: every path reaches Pages, without stealing the marketplace routes or /api/ask.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const rewrites = config.rewrites;
const PAGES = 'https://openmobilehub.org/credentagent';
const CATCH_ALL = { source: '/:path*', destination: `${PAGES}/:path*` };

// Enough of Vercel's path-to-regexp for these sources: `:name*` matches zero or more segments.
const matches = (source, path) =>
  new RegExp(`^${source.replace(/\/:\w+\*/g, '(?:/.*)?').replace(/:\w+/g, '[^/]+')}/?$`).test(path);
const indexOf = (source) => rewrites.findIndex((r) => r.source === source);

describe('router vercel.json', () => {
  it('ends with a catch-all that forwards every other path to Pages', () => {
    expect(rewrites.at(-1)).toEqual(CATCH_ALL);
    for (const path of ['/robots.txt', '/llms.txt', '/sitemap.xml', '/about', '/no-such-page']) {
      expect(rewrites.find((r) => matches(r.source, path))).toEqual(CATCH_ALL);
    }
  });

  it('keeps the marketplace routes ahead of the catch-all, pointing at their demos', () => {
    const catchAll = indexOf(CATCH_ALL.source);
    expect(rewrites[indexOf('/marketplace-dev/:path*')]?.destination).toBe('https://credentagent-demo-dev.vercel.app/:path*');
    expect(rewrites[indexOf('/marketplace/:path*')]?.destination).toBe('https://credentagent-demo.vercel.app/:path*');
    expect(indexOf('/marketplace-dev/:path*')).toBeLessThan(catchAll);
    expect(indexOf('/marketplace/:path*')).toBeLessThan(catchAll);
    expect(rewrites.find((r) => matches(r.source, '/marketplace/mcp'))?.destination).toBe('https://credentagent-demo.vercel.app/:path*');
    expect(rewrites.find((r) => matches(r.source, '/marketplace-dev/mcp'))?.destination).toBe('https://credentagent-demo-dev.vercel.app/:path*');
  });

  it('still serves / from the Pages product page', () => {
    expect(rewrites).toContainEqual({ source: '/', destination: `${PAGES}/` });
  });

  it('leaves /api/ask to its function: declared, and no rewrite before the catch-all matches it', () => {
    expect(config.functions['api/ask.mjs']).toBeDefined();
    const first = rewrites.find((r) => matches(r.source, '/api/ask'));
    expect(first).toEqual(CATCH_ALL);   // only the catch-all, which Vercel applies after functions
  });
});
