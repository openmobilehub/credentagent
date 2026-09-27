// POST https://credentagent.ai/api/ask — the website demo's "Ask about your order" agent.
// All logic lives in ../lib/ask-core.mjs (kept out of api/, where every file becomes a public function).
import { ask, AskError, createLimiter, originAllowed } from '../lib/ask-core.mjs';

const STORE_URL = process.env.ASK_STORE_MCP || 'https://credentagent-demo.vercel.app/mcp';   // what /marketplace/mcp rewrites to
const allow = createLimiter({ perMinute: 8 });

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  // The page calls this same-origin; a browser always sends Origin on a POST, so a missing or foreign one is refused.
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: 'forbidden_origin' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!allow(ip)) return res.status(429).json({ error: 'rate_limited', message: 'Too many questions — wait a minute and try again.' });
  try {
    const out = await ask(req.body, { fetch, apiKey: process.env.ZAI_API_KEY, storeUrl: STORE_URL });
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof AskError) return res.status(e.status).json({ error: e.code, message: e.message });
    console.error('ask failed', e);
    return res.status(500).json({ error: 'internal', message: 'Something went wrong — try again.' });
  }
}
