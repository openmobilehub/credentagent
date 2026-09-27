// Ask AI — a tiny read-only agent that answers a visitor's questions about their order, cart and the
// catalog, for the website's live demo. Z.ai's free GLM models pick a storefront tool, the tool runs
// against the real store, and the model answers from its result.
//
// Pure: every network call goes through the injected `fetch`, so the tests drive it without a server.
// Safety controls, each covered by a test in ../ask.test.mjs:
//   - only READ_ONLY tools are offered, and any other tool the model names is refused, never called;
//   - tool results are trimmed (get-cart's widget catalog made models read the catalog as the cart);
//   - at most MAX_ROUNDS tool rounds, then one final call WITHOUT tools forces a plain answer;
//   - input is bounded (question length, id shape, history size) before anything is sent upstream;
//   - a model that answers 429 "overloaded" is retried once, then the next model in MODELS is tried;
//   - every upstream call has a timeout (the free tier can hold a request for minutes instead of
//     refusing it) and the whole question has a DEADLINE_MS budget inside the function's 30 s limit.

export const READ_ONLY = ['get-order-status', 'get-cart', 'list-products', 'get-product-details', 'get-product-reviews', 'get-grant-status'];
// Both free on Z.ai. 4.5 first: in testing it got every tool and answer right and was never throttled,
// while 4.7's free tier refused or held most requests.
export const MODELS = ['glm-4.5-flash', 'glm-4.7-flash'];
// One-line descriptions for a small model — the store's own are written for large agents, and every
// token here is resent on each call. The input schemas still come from the store.
const SHORT = {
  'get-order-status': 'Status of the visitor\'s order by orderId (pending until they finish checkout; then paid, with totals).',
  'get-cart': 'The visitor\'s cart by cartId: line items, quantities, total.',
  'list-products': 'Search or list the catalog (optional query/category): ids, names, prices, age restrictions.',
  'get-product-details': 'Full details for product ids (use list-products first to find an id).',
  'get-product-reviews': 'Customer reviews for product ids (use list-products first to find an id).',
  'get-grant-status': 'A spending grant by grantId: status, budget left, per-purchase limit.',
};
export const MAX_ROUNDS = 3;
export const MAX_QUESTION = 500;
export const MAX_HISTORY = 6;
export const MODEL_TIMEOUT_MS = 10_000;   // glm-4.7-flash answers in ~1 s, glm-4.5-flash in ~5 s
export const STORE_TIMEOUT_MS = 8_000;
export const DEADLINE_MS = 25_000;        // vercel.json gives the function 30 s
const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const ID = /^[A-Za-z0-9_.:-]{1,300}$/;

export class AskError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Validate and normalise the page's request body. Throws AskError(400) on anything malformed.
export function parseRequest(body) {
  if (!body || typeof body !== 'object') throw new AskError(400, 'bad_request', 'Send JSON: { question, context?, history? }.');
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new AskError(400, 'bad_request', 'Ask a question.');
  if (question.length > MAX_QUESTION) throw new AskError(400, 'too_long', `Keep questions under ${MAX_QUESTION} characters.`);
  const context = {};
  for (const k of ['cartId', 'orderId', 'grantId']) {
    const v = body.context && body.context[k];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !ID.test(v)) throw new AskError(400, 'bad_request', `context.${k} is not a valid id.`);
    context[k] = v;
  }
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION * 2) }));
  return { question, context, history };
}

export function systemPrompt(context) {
  const ids = Object.entries(context).map(([k, v]) => `${k}=${v}`).join(', ') || 'none yet';
  return 'You are the help assistant for the CredentAgent demo store. Answer ONLY questions about the visitor\'s ' +
    'order, cart, the products, and spending grants, using the tools. Never invent facts: if a tool did not return it, ' +
    'say you don\'t know. Keep answers to 1-3 sentences, plain text. You cannot place orders, change the cart, approve ' +
    'anything, or verify anyone\'s age — say so if asked; the visitor does those in the demo itself. ' +
    `The visitor's ids: ${ids}. Pass them to tools when needed.`;
}

// Only what the model needs: get-cart without the widget's catalog, and no inline images anywhere.
export function trimResult(name, result) {
  const s = result && (result.structuredContent ?? result.content ?? result);
  const out = name === 'get-cart' && s && s.cart ? { cart: s.cart } : s;
  return JSON.stringify(out ?? null, (k, v) => (k === 'image' ? undefined : v)).slice(0, 4000);
}

const isTimeout = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError');

async function mcpCall(fetchImpl, storeUrl, method, params) {
  let r;
  try {
    r = await fetchImpl(storeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeout(e)) throw new AskError(504, 'store_timeout', 'The store took too long to answer — try again.');
    throw e;
  }
  if (!r.ok) throw new AskError(502, 'store_unavailable', `The store answered ${r.status}.`);
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) throw new AskError(502, 'store_error', msg.error.message || 'The store returned an error.');
  return msg.result;
}

// tools/list, filtered to READ_ONLY and shaped as OpenAI-style function tools. Cached per instance.
let toolCache = null;
export function resetToolCache() { toolCache = null; }
async function readOnlyTools(fetchImpl, storeUrl) {
  if (toolCache) return toolCache;
  const { tools } = await mcpCall(fetchImpl, storeUrl, 'tools/list', {});
  toolCache = tools.filter((t) => READ_ONLY.includes(t.name)).map((t) => ({
    type: 'function', function: { name: t.name, description: SHORT[t.name] || t.description, parameters: t.inputSchema },
  }));
  return toolCache;
}

async function chat({ fetchImpl, apiKey, sleep, now, deadline, modelTimeoutMs }, messages, tools, models) {
  let lastStatus = 0;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - now();
      if (left < 1000) throw new AskError(503, 'model_unavailable', 'The AI is busy right now — try again in a moment.');
      let r;
      try {
        r = await fetchImpl(ZAI_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({
            model, messages, thinking: { type: 'disabled' }, max_tokens: 400, temperature: 0.2,
            ...(tools ? { tools, tool_choice: 'auto' } : {}),
          }),
          signal: AbortSignal.timeout(Math.min(modelTimeoutMs, left)),
        });
      } catch (e) {
        if (!isTimeout(e)) throw e;
        lastStatus = 429;   // a held request is throttling by another name: go to the next model
        break;
      }
      lastStatus = r.status;
      if (r.status === 429) { if (attempt === 0) await sleep(800); continue; }
      if (!r.ok) break;   // not a throttle: go straight to the next model
      const body = await r.json();
      return { model, message: body.choices[0].message };
    }
  }
  throw new AskError(lastStatus === 429 ? 503 : 502, 'model_unavailable', 'The AI is busy right now — try again in a moment.');
}

// The whole agent: returns { answer, tools, model }.
export async function ask(input, {
  fetch: fetchImpl, apiKey, storeUrl, models = MODELS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), modelTimeoutMs = MODEL_TIMEOUT_MS,
}) {
  if (!apiKey) throw new AskError(503, 'not_configured', 'Ask AI is not configured on this server yet.');
  const { question, context, history } = parseRequest(input);
  const deps = { fetchImpl, apiKey, sleep, now, deadline: now() + DEADLINE_MS, modelTimeoutMs };
  const tools = await readOnlyTools(fetchImpl, storeUrl);
  const messages = [{ role: 'system', content: systemPrompt(context) }, ...history, { role: 'user', content: question }];
  const used = [];
  let model;
  for (let round = 0; ; round++) {
    const last = round === MAX_ROUNDS;
    const reply = await chat(deps, messages, last ? null : tools, models);
    model = reply.model;
    const calls = reply.message.tool_calls || [];
    if (last || !calls.length) {
      const answer = (reply.message.content || '').trim() || 'Sorry — I couldn\'t find an answer to that.';
      return { answer, tools: used, model };
    }
    messages.push({ role: 'assistant', content: reply.message.content || '', tool_calls: calls });
    for (const c of calls) {
      const name = c.function && c.function.name;
      let content;
      if (!READ_ONLY.includes(name)) {
        content = JSON.stringify({ error: `${name} is not available here: this assistant is read-only.` });
      } else {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
        used.push(name);
        content = trimResult(name, await mcpCall(fetchImpl, storeUrl, 'tools/call', { name, arguments: args }));
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
}

// Best-effort per-instance limiter (serverless instances don't share memory). The models are free,
// so this protects the free-tier quota from one noisy client rather than a bill.
export function createLimiter({ perMinute = 8, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now(), windowStart = t - 60_000;
    const list = (hits.get(key) || []).filter((x) => x > windowStart);
    if (list.length >= perMinute) { hits.set(key, list); return false; }
    list.push(t); hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

export const ALLOWED_ORIGINS = ['https://credentagent.ai', 'https://www.credentagent.ai'];
export function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);   // tools/dev-server.py in the website repo
}
