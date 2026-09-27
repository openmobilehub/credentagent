// POST https://credentagent.ai/api/ask — the website demo's "Ask about your order" agent.
// All logic lives in ../lib/ask-core.mjs (kept out of api/, where every file becomes a public function).
import { ask, AskError, createLimiter, originAllowed, modelChain, keysFrom,
  MODELS as DEFAULT_MODELS, EDIT_MODELS as DEFAULT_EDIT_MODELS } from '../lib/ask-core.mjs';

// The store the website's in-browser demo uses — Ask AI must read the same one to find the visitor's
// cart and order. The demo runs on /marketplace-dev (library main), so that's the default here too.
const STORE_URL = process.env.ASK_STORE_MCP || 'https://credentagent-demo-dev.vercel.app/mcp';   // what /marketplace-dev/mcp rewrites to
// ASK_MODELS / ASK_EDIT_MODELS replace the read / cart-edit chains; both throw at cold start on a typo'd provider.
const MODELS = modelChain(process.env.ASK_MODELS, DEFAULT_MODELS);
const EDIT_MODELS = modelChain(process.env.ASK_EDIT_MODELS, DEFAULT_EDIT_MODELS);
const allow = createLimiter({ perMinute: 8 });

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  // The page calls this same-origin; a browser always sends Origin on a POST, so a missing or foreign one is refused.
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: 'forbidden_origin' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!allow(ip)) return res.status(429).json({ error: 'rate_limited', message: 'Too many questions — wait a minute and try again.' });
  try {
    const out = await ask(req.body, { fetch, keys: keysFrom(process.env), models: MODELS, editModels: EDIT_MODELS, storeUrl: STORE_URL });
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof AskError) return res.status(e.status).json({ error: e.code, message: e.message });
    console.error('ask failed', e);
    return res.status(500).json({ error: 'internal', message: 'Something went wrong — try again.' });
  }
}
