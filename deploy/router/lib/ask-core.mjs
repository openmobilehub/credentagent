// Ask AI — a tiny agent that answers a visitor's questions about their order, cart and the
// catalog, for the website's live demo. A model (see MODELS and PROVIDERS) picks a storefront tool, the tool runs
// against the real store, and the model answers from its result.
//
// Pure: every network call goes through the injected `fetch`, so the tests drive it without a server.
// Safety controls, each covered by a test in ../ask.test.mjs:
//   - only READ_ONLY tools plus the CART_EDIT tools are offered, and any other tool the model names
//     (checkout, every grant write) is refused, never called: the AI can fill the visitor's own cart
//     (the store refuses a forged cartId) but never check out, pay or approve — that's the visitor;
//   - tool results are trimmed (get-cart's widget catalog made models read the catalog as the cart);
//   - a tool that declares an MCP App (_meta.ui.resourceUri) has its result relayed to the page, which
//     renders the app like any MCP host would (a cart edit shows up in the open picker);
//   - an answer claiming a cart change with no CART_EDIT call behind it gets one corrective round, then
//     is replaced by an honest line — the chat never says the cart changed when it didn't;
//   - at most MAX_ROUNDS tool rounds, then one final call WITHOUT tools forces a plain answer;
//   - input is bounded (question length, id shape, history size) before anything is sent upstream;
//   - a model that answers 429 "overloaded" is retried with BACKOFF_MS, then the next model in MODELS is
//     tried; the last (fallback) model always keeps FALLBACK_RESERVE_MS of the budget, and once a model
//     answers the rest of the question stays on it;
//   - every upstream call has a timeout (the free tier can hold a request for minutes instead of
//     refusing it) and the whole question has a DEADLINE_MS budget inside the function's 30 s limit.

export const READ_ONLY = ['browse-products', 'get-order-status', 'get-cart', 'list-products', 'get-product-details', 'get-product-reviews', 'get-grant-status'];
// The visitor's own cart, by the page's cartId: adding, changing and removing items. Checkout stays theirs.
export const CART_EDIT = ['add-to-cart', 'set-quantity', 'remove-from-cart'];
const ALLOWED = [...READ_ONLY, ...CART_EDIT];
// A claimed cart change must be backed by a CART_EDIT call the store accepted in this question: small models
// copy their earlier "Added …" / "Done — 2 mice." replies from the history without calling anything (seen
// live on 2026-09-27). A sentence claims a change when it has a change word and no negation ("you haven't
// added", "nothing was added" are reads); a question asks for one when it reads like an edit request.
const CHANGE = /\b(added|removed|updated|changed|put|increased|decreased|dropped|deleted|adjusted|done)\b|\bnow in your cart\b/i;
const NEGATION = /n't\b|\b(not|never|nothing|no|unable|cannot)\b/i;
export function claimsCartEdit(answer) {
  return String(answer).split(/(?<=[.!?])\s+/).some((s) => CHANGE.test(s) && !NEGATION.test(s));
}
export function asksCartEdit(question) {
  return /\b(add|remove|delete|take (it |them )?(out|off)|increase|decrease)\b|\bmake it \w+|\b(set|change) .+ to\b|\bput .+ in\b|\b(empty|clear) (my|the) cart\b/i.test(question);
}
const ANSWERS_THE_CHECK = /no cart tool (ran|was called)|\bthe check\b/i;
const NOT_CHANGED = 'Check: no cart tool ran for this message, so the cart has NOT changed. If I asked to change the cart, ' +
  'call add-to-cart, set-quantity or remove-from-cart now (get ids from get-cart or list-products) and answer only after ' +
  'it succeeds; if I didn\'t ask for a change, answer without saying the cart changed.';
const HONEST_NO_EDIT = 'Sorry — I didn\'t change your cart just then. Ask me again, or use the picker.';
// Nebius gpt-oss-120b first ($0.15 in / $0.60 out per 1M tokens, ~$0.0007 a question, ~1.5 s, from a prepaid
// Nebius Token Factory balance). In a 2026-09-27 live run of the 9-turn cart conversation (picker / add / "make
// it 2" / price / add / one more / remove / what's-in-my-cart / "check out for me"), with the store's cart
// checked after every turn, it scored 36/36 over 4 runs; Nebius GLM-5.3-Flash also 36/36 but ~4.5 s. Failed:
// Qwen3-235B-2507 and MiniMax-M3 (claimed edits they never made, invented a product), GLM-5.3 (2 of 4 runs
// broke, once printing a raw <tool_call>). Then Z.ai as a second provider: glm-5 (9/9, ~4.5 s, ~$0.005 a
// question; glm-4.5-air claimed edits it never made), and the free glm-4.5-flash, which also covers both
// balances running out (Z.ai logs 1113). Dropped earlier: glm-4.7-flash / glm-4.7-flashx (overloaded).
// Each entry is 'provider:model-id' (see PROVIDERS); the ASK_MODELS env var replaces the chain without a code
// change, e.g. ASK_MODELS=nebius:zai-org/GLM-5.3-Flash,zai:glm-5,zai:glm-4.5-flash. A model whose provider has
// no key configured is skipped.
export const MODELS = ['nebius:openai/gpt-oss-120b', 'nebius:zai-org/GLM-5.3-Flash', 'zai:glm-5', 'zai:glm-4.5-flash'];
// The wait before each retry after a 429; a model not listed here gets DEFAULT_BACKOFF_MS.
export const BACKOFF_MS = { 'zai:glm-4.5-flash': [700, 1500] };
export const DEFAULT_BACKOFF_MS = [600];
// OpenAI-compatible chat-completions endpoints. `env` names the key's environment variable; `extra` is merged
// into every request body (Z.ai's `thinking` switch is Z.ai-only — others may refuse unknown fields).
export const PROVIDERS = {
  zai: { url: 'https://api.z.ai/api/paas/v4/chat/completions', env: 'ZAI_API_KEY', extra: { thinking: { type: 'disabled' } } },
  nebius: { url: 'https://api.tokenfactory.nebius.com/v1/chat/completions', env: 'NEBIUS_API_KEY' },
};
export const providerOf = (model) => model.slice(0, model.indexOf(':'));
export const modelId = (model) => model.slice(model.indexOf(':') + 1);
// ASK_MODELS (comma-separated) or the default chain; an entry with an unknown provider is a config error.
export function modelChain(env = '') {
  const list = String(env).split(',').map((m) => m.trim()).filter(Boolean);
  const chain = list.length ? list : MODELS;
  for (const m of chain) if (!PROVIDERS[providerOf(m)]) throw new Error(`ASK_MODELS: unknown provider in "${m}" (use ${Object.keys(PROVIDERS).join(', ')})`);
  return chain;
}
// Every provider's key from the environment: { zai: '…', nebius: '…' } (missing ones left out).
export function keysFrom(env) {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([p, c]) => [p, env[c.env]]).filter(([, k]) => k));
}
export const FALLBACK_RESERVE_MS = 8_000;   // a model before the last isn't tried with less than this left
// One-line descriptions for a small model — the store's own are written for large agents, and every
// token here is resent on each call. The input schemas still come from the store.
const SHORT = {
  'browse-products': 'Show the visitor the store\'s visual product picker (the page renders it). Use it whenever they want to see, browse or shop products; pass their cartId if they have one.',
  'get-order-status': 'Status of the visitor\'s order by orderId (pending until they finish checkout; then paid, with totals).',
  'get-cart': 'The visitor\'s cart by cartId: line items, quantities, total.',
  'add-to-cart': 'Add products to the visitor\'s cart: items [{productId, quantity}] (ids from list-products); quantities add on top.',
  'set-quantity': 'Set the exact quantity of one product in the visitor\'s cart (0 removes it).',
  'remove-from-cart': 'Remove one product from the visitor\'s cart.',
  'list-products': 'Catalog as data for YOU (optional query/category): ids, names, prices, age restrictions. Nothing is shown to the visitor — to show products, use browse-products.',
  'get-product-details': 'Full details for product ids (use list-products first to find an id).',
  'get-product-reviews': 'Customer reviews for product ids (use list-products first to find an id).',
  'get-grant-status': 'A spending grant by grantId: status, budget left, per-purchase limit.',
};
export const MAX_ROUNDS = 3;
export const MAX_QUESTION = 500;
export const MAX_HISTORY = 6;
export const MODEL_TIMEOUT_MS = 10_000;   // gpt-oss-120b answers in ~1-2 s, GLM-5.3-Flash / glm-5 ~2-5 s, glm-4.5-flash ~1-5 s
export const STORE_TIMEOUT_MS = 8_000;
export const DEADLINE_MS = 25_000;        // vercel.json gives the function 30 s
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
    'say you don\'t know. Keep answers to 1-3 sentences, plain text (no markdown). When the visitor wants to see or shop ' +
    'products, call browse-products: the page shows them the picker, so don\'t list the products in text. When they ask to ' +
    'add, change or remove items, do it with add-to-cart / set-quantity / remove-from-cart (find ids with list-products; ' +
    'add-to-cart adds on top of what is already in the cart, so pass ONLY the newly requested items); the ' +
    'picker on their page updates, so just confirm briefly. You cannot check out, pay, approve anything or verify anyone\'s ' +
    'age: the visitor checks out in the picker, and 21+ items ask for their wallet proof there — say so if asked. ' +
    'Always look facts up with a tool before answering about products, prices, age limits, the cart or an order — ' +
    'never from memory. Only say the cart changed if you called a cart tool for THIS message and it succeeded — earlier ' +
    'replies in the chat are not a record of the cart. If the visitor has no cartId yet, their cart is empty (they haven\'t shopped yet); never ask ' +
    `them for an id. The visitor's ids: ${ids}. Pass them to tools when needed.`;
}

// Only what the model needs: cart results without the widget's catalog, and no inline images anywhere.
export function trimResult(name, result) {
  // browse-products: the store's own note to the model ("the picker is showing … don't re-list"), not the catalog.
  const note = name === 'browse-products' && result && Array.isArray(result.content) && result.content.find((c) => c.type === 'text');
  if (note) return note.text.slice(0, 4000);
  const s = result && (result.structuredContent ?? result.content ?? result);
  const out = name === 'get-cart' && s && s.cart ? { cart: s.cart }
    : CART_EDIT.includes(name) && s && s.cart ? { cart: s.cart, cartId: s.cartId } : s;
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

// tools/list, filtered to ALLOWED and shaped as OpenAI-style function tools, plus each offered tool's
// MCP App (its _meta.ui.resourceUri, if it declares one). Cached per instance.
let toolCache = null;
export function resetToolCache() { toolCache = null; }
async function readOnlyTools(fetchImpl, storeUrl) {
  if (toolCache) return toolCache;
  const { tools } = await mcpCall(fetchImpl, storeUrl, 'tools/list', {});
  const offered = tools.filter((t) => ALLOWED.includes(t.name));
  const ui = {};
  for (const t of offered) {
    const uri = t._meta && t._meta.ui && t._meta.ui.resourceUri;
    if (typeof uri === 'string' && uri.startsWith('ui://')) ui[t.name] = uri;
  }
  toolCache = {
    ui,
    tools: offered.map((t) => ({
      type: 'function', function: { name: t.name, description: SHORT[t.name] || t.description, parameters: t.inputSchema },
    })),
  };
  return toolCache;
}

// The store's cart tools take this conversation's cartId; a small model often drops it, so the page's id
// fills in when the model passed none (never overriding one it did pass — the store refuses a forged id).
const CART_TOOLS = ['browse-products', 'get-cart', ...CART_EDIT];

async function chat({ fetchImpl, keys, sleep, now, deadline, modelTimeoutMs }, messages, tools, models) {
  let lastStatus = 0;
  for (const model of models) {
    const waits = BACKOFF_MS[model] || DEFAULT_BACKOFF_MS;
    const provider = PROVIDERS[providerOf(model)];
    const floor = model === models[models.length - 1] ? 1000 : FALLBACK_RESERVE_MS;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      const left = deadline - now();
      if (left < floor) break;
      let r;
      try {
        r = await fetchImpl(provider.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keys[providerOf(model)] },
          body: JSON.stringify({
            model: modelId(model), messages, max_tokens: 400, temperature: 0.2, ...provider.extra,
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
      if (!r.ok) {
        // Visible in the function logs. Z.ai: 1305 = overloaded, 1113 = the prepaid balance ran out (top up at z.ai).
        console.warn('ask: %s answered %d %s', model, r.status, (await r.text().catch(() => '')).slice(0, 160));
        if (r.status === 429 && attempt < waits.length) { await sleep(waits[attempt]); continue; }
        break;   // out of retries, or not a throttle: go to the next model
      }
      const body = await r.json();
      return { model, message: body.choices[0].message };   // model: the chain entry, e.g. 'zai:glm-5'
    }
  }
  // 503 when throttled or out of time (nothing was called), 502 when a model failed some other way.
  throw new AskError(lastStatus === 429 || lastStatus === 0 ? 503 : 502, 'model_unavailable', 'The AI is busy right now — try again in a moment.');
}

// The whole agent: returns { answer, tools, model, app? } — model is the bare id that answered (the page shows
// it), app is the last call to a tool with an MCP App:
// { tool, resourceUri, result } with the store's full result, for the page to render that app.
export async function ask(input, {
  fetch: fetchImpl, keys = {}, storeUrl, models = MODELS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), modelTimeoutMs = MODEL_TIMEOUT_MS,
}) {
  models = models.filter((m) => keys[providerOf(m)]);   // a model without its provider's key can't be called
  if (!models.length) throw new AskError(503, 'not_configured', 'Ask AI is not configured on this server yet.');
  const { question, context, history } = parseRequest(input);
  const deps = { fetchImpl, keys, sleep, now, deadline: now() + DEADLINE_MS, modelTimeoutMs };
  const { tools, ui } = await readOnlyTools(fetchImpl, storeUrl);
  const messages = [{ role: 'system', content: systemPrompt(context) }, ...history, { role: 'user', content: question }];
  const used = [];
  let model, app = null, pool = models, nudged = false, edited = false;   // edited: a cart edit the store accepted
  for (let round = 0; ; round++) {
    const last = round === MAX_ROUNDS;
    const reply = await chat(deps, messages, last ? null : tools, pool);
    model = reply.model;
    pool = pool.slice(pool.indexOf(model));   // the rest of this question stays on the model that answered
    const calls = reply.message.tool_calls || [];
    if (last || !calls.length) {
      let answer = (reply.message.content || '').trim() || 'Sorry — I couldn\'t find an answer to that.';
      if (!edited && !last && !nudged && (asksCartEdit(question) || claimsCartEdit(answer))) {
        nudged = true;   // one corrective round: do the edit for real, or say truthfully why not
        messages.push({ role: 'assistant', content: answer }, { role: 'user', content: NOT_CHANGED });
        continue;
      }
      // A claim still unbacked (or on the last round), or the model answering the check itself: say it plainly.
      // A truthful decline ("we don't sell laptops, so nothing was added") stands.
      if (!edited && (claimsCartEdit(answer) || (nudged && ANSWERS_THE_CHECK.test(answer)))) answer = HONEST_NO_EDIT;
      return { answer, tools: used, model: modelId(model), ...(app ? { app } : {}) };
    }
    messages.push({ role: 'assistant', content: reply.message.content || '', tool_calls: calls });
    for (const c of calls) {
      const name = c.function && c.function.name;
      let content;
      if (!ALLOWED.includes(name)) {
        content = JSON.stringify({ error: `${name} is not available here: you can read the store and edit the cart, but the visitor checks out themselves.` });
      } else {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
        if (CART_TOOLS.includes(name) && !args.cartId && context.cartId) args.cartId = context.cartId;
        used.push(name);
        const result = await mcpCall(fetchImpl, storeUrl, 'tools/call', { name, arguments: args });
        if (ui[name] && result && !result.isError) app = { tool: name, resourceUri: ui[name], result };
        if (CART_EDIT.includes(name) && result && !result.isError) edited = true;
        content = trimResult(name, result);
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
}

// Best-effort per-instance limiter (serverless instances don't share memory): keeps one noisy client from
// draining the prepaid balances (which cap the bill) or the free-tier quota.
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
