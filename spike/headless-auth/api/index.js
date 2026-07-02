// headless-auth spike — §12.2 of specs/005-human-not-present/connector-architecture-design.md
//
// A deliberately minimal MCP connector whose ONLY job is to answer one question:
// can a claude.ai scheduled routine call an OAuth-protected custom connector for
// 3 consecutive days with no human re-auth?
//
// Design for observability:
//   - Access tokens live 10 MINUTES, so every daily run MUST use the refresh token
//     (the behavior under test). Refresh rotates: each refresh increments `gen`.
//   - The `heartbeat` tool returns { serverTime, tokenGeneration, ... } — if day-3's
//     run reports a higher gen than day-1's with no re-consent, the spike PASSES.
//
// Spike-grade shortcuts (fine here, never in the real wallet server):
//   - Stateless HMAC tokens; rotation does not revoke prior refresh tokens.
//   - The SECRET is committed. It protects a timestamp.
//   - The consent page has no user accounts — one Approve button.

const crypto = require("crypto");

const SECRET = "spike-b2441316-4f8a6d1e9c2b7a05e3d8f1c6-not-a-real-secret";
const ACCESS_TTL_S = 600; // 10 min — forces a refresh on every daily run
const REFRESH_TTL_S = 30 * 24 * 3600;

// ── tiny signed-token helpers (JWT-shaped, HS256, only we verify) ────────────
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  const s = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
};
const verify = (token) => {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(parts[2]), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
};
const now = () => Math.floor(Date.now() / 1000);
const sha256b64u = (s) => crypto.createHash("sha256").update(s).digest("base64url");

// ── request body (Vercel usually pre-parses; fall back to reading the stream) ─
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return null;
  const ct = (req.headers["content-type"] || "").split(";")[0];
  if (ct === "application/json") { try { return JSON.parse(raw); } catch { return null; } }
  if (ct === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return raw; }
}

const json = (res, status, obj, headers = {}) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
};
const html = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
};

// ── OAuth metadata ───────────────────────────────────────────────────────────
const asMetadata = (base) => ({
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  registration_endpoint: `${base}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["heartbeat", "offline_access"],
});
const prMetadata = (base) => ({
  resource: `${base}/mcp`,
  authorization_servers: [base],
  scopes_supported: ["heartbeat", "offline_access"],
  bearer_methods_supported: ["header"],
});

// ── the consent page ─────────────────────────────────────────────────────────
const consentPage = (q) => `<!doctype html><meta charset="utf-8">
<title>headless-auth spike — authorize</title>
<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.5">
<h1 style="font-size:1.3rem">headless-auth spike</h1>
<p>A Claude connector is asking for access. This is the <b>one interactive consent</b> of the
3-day scheduled-run experiment (AttestoMCP HNP §12.2). Scope: <code>${q.scope || "heartbeat"}</code>.</p>
<form method="POST" action="/approve">
${["client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method", "response_type"]
  .map((k) => `<input type="hidden" name="${k}" value="${(q[k] || "").replace(/"/g, "&quot;")}">`)
  .join("\n")}
<button type="submit" style="font-size:1.1rem;padding:.5rem 2rem">Approve</button>
</form></body>`;

// ── MCP (stateless Streamable HTTP, single JSON responses) ──────────────────
const TOOLS = [{
  name: "heartbeat",
  description:
    "Returns the server time and OAuth token-generation info. Call this to verify that a " +
    "scheduled (unattended) run can still authenticate. tokenGeneration increments on every " +
    "refresh-token rotation, so rising values across days prove headless refresh works.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

function mcpResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function mcpError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function handleMcpMessage(msg, tok) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    return mcpResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "headless-auth-spike", version: "0.1.0" },
    });
  }
  if (method === "ping") return mcpResult(id, {});
  if (method === "tools/list") return mcpResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    if (!params || params.name !== "heartbeat") return mcpError(id, -32602, `Unknown tool: ${params && params.name}`);
    const payload = {
      serverTime: new Date().toISOString(),
      tokenGeneration: tok.gen,
      tokenIssuedAt: new Date((tok.iat || 0) * 1000).toISOString(),
      tokenExpiresAt: new Date(tok.exp * 1000).toISOString(),
      note: "If tokenGeneration is higher than yesterday's and no re-auth was needed, headless refresh works.",
    };
    console.log(`[spike] heartbeat gen=${tok.gen} at=${payload.serverTime}`);
    return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false });
  }
  if (id === undefined || id === null) return null; // notification — no response
  return mcpError(id, -32601, `Method not found: ${method}`);
}

// ── the handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const base = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const url = new URL(req.url, base);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = Object.fromEntries(url.searchParams);

  // RFC 8414 / RFC 9728 discovery (incl. path-suffixed variants clients may probe)
  if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))
    return json(res, 200, asMetadata(base));
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return json(res, 200, prMetadata(base));

  // DCR (RFC 7591) — stateless: the client_id IS the signed registration
  if (path === "/register" && req.method === "POST") {
    const body = (await readBody(req)) || {};
    // https for hosted clients (claude.ai) + http loopback for CLI clients (Claude Code's
    // localhost callback server) — the standard native-app OAuth pattern (RFC 8252 §7.3).
    const ru = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u))
      : [];
    if (!ru.length) return json(res, 400, { error: "invalid_client_metadata", error_description: "https or localhost-loopback redirect_uris required" });
    const client_id = sign({ t: "client", ru, iat: now() });
    console.log(`[spike] DCR register redirect_uris=${ru.join(",")}`);
    return json(res, 201, {
      client_id, redirect_uris: ru, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  }

  if (path === "/authorize" && req.method === "GET") {
    const client = verify(q.client_id);
    if (!client || client.t !== "client") return html(res, 400, "<p>invalid client_id</p>");
    if (!client.ru.includes(q.redirect_uri)) return html(res, 400, "<p>redirect_uri not registered</p>");
    if (q.response_type !== "code") return html(res, 400, "<p>response_type must be code</p>");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return html(res, 400, "<p>PKCE S256 required</p>");
    return html(res, 200, consentPage(q));
  }

  if (path === "/approve" && req.method === "POST") {
    const b = (await readBody(req)) || {};
    const client = verify(b.client_id);
    if (!client || client.t !== "client" || !client.ru.includes(b.redirect_uri)) return html(res, 400, "<p>invalid request</p>");
    const code = sign({ t: "code", cid: sha256b64u(b.client_id), ch: b.code_challenge, scope: b.scope || "heartbeat", exp: now() + 300 });
    const loc = new URL(b.redirect_uri);
    loc.searchParams.set("code", code);
    if (b.state) loc.searchParams.set("state", b.state);
    res.statusCode = 302;
    res.setHeader("location", loc.toString());
    console.log("[spike] consent approved, code issued");
    return res.end();
  }

  if (path === "/token" && req.method === "POST") {
    const b = (await readBody(req)) || {};
    const issuePair = (cid, scope, gen) => json(res, 200, {
      access_token: sign({ t: "at", cid, scope, gen, iat: now(), exp: now() + ACCESS_TTL_S }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: sign({ t: "rt", cid, scope, gen, iat: now(), exp: now() + REFRESH_TTL_S }),
      scope,
    });
    if (b.grant_type === "authorization_code") {
      const code = verify(b.code);
      if (!code || code.t !== "code") return json(res, 400, { error: "invalid_grant", error_description: "bad or expired code" });
      if (sha256b64u(b.code_verifier || "") !== code.ch) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (b.client_id && sha256b64u(b.client_id) !== code.cid) return json(res, 400, { error: "invalid_grant", error_description: "client mismatch" });
      console.log("[spike] token issued gen=1 (authorization_code)");
      return issuePair(code.cid, code.scope, 1);
    }
    if (b.grant_type === "refresh_token") {
      const rt = verify(b.refresh_token);
      if (!rt || rt.t !== "rt") return json(res, 400, { error: "invalid_grant", error_description: "bad or expired refresh token" });
      console.log(`[spike] token refreshed gen=${rt.gen} -> ${rt.gen + 1}`);
      return issuePair(rt.cid, rt.scope, rt.gen + 1);
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }

  if (path === "/mcp") {
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method === "GET" || req.method === "DELETE") {
      // A human in a browser gets the info page; an MCP client (Accept: text/event-stream)
      // gets the spec-required 405 (no server-initiated stream on this stateless server).
      const accept = req.headers.accept || "";
      if (req.method === "GET" && accept.includes("text/html") && !accept.includes("text/event-stream"))
        return html(res, 200,
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:34rem;margin:4rem auto">
           <h1 style="font-size:1.3rem">headless-auth spike — MCP endpoint ✓</h1>
           <p>This URL is alive. It speaks MCP over <b>POST</b> (JSON-RPC), so browsers can't drive it —
           add it as a custom connector in Claude instead:</p>
           <p><code>${base}/mcp</code></p>
           <p>Setup steps: <code>spike/headless-auth/README.md</code> (branch <code>005-human-not-present</code>).</p></body>`);
      res.statusCode = 405; res.setHeader("allow", "POST"); return res.end();
    }
    const auth = req.headers.authorization || "";
    const tok = auth.startsWith("Bearer ") ? verify(auth.slice(7)) : null;
    if (!tok || tok.t !== "at") {
      console.log("[spike] /mcp 401 (missing/expired token) — expect a refresh next");
      return json(res, 401, { error: "unauthorized" }, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
    }
    const body = await readBody(req);
    if (Array.isArray(body)) {
      const replies = body.map((m) => handleMcpMessage(m, tok)).filter(Boolean);
      return replies.length ? json(res, 200, replies) : (res.statusCode = 202, res.end());
    }
    const reply = handleMcpMessage(body, tok);
    if (!reply) { res.statusCode = 202; return res.end(); }
    return json(res, 200, reply);
  }

  if (path === "/") return html(res, 200,
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:34rem;margin:4rem auto">
     <h1 style="font-size:1.3rem">headless-auth spike</h1>
     <p>MCP connector for the AttestoMCP HNP §12.2 experiment: can a Claude scheduled routine
     refresh its OAuth token unattended for 3 days? Add <code>${base}/mcp</code> as a custom
     connector in Claude. See <code>spike/headless-auth/README.md</code> on branch
     <code>005-human-not-present</code>.</p></body>`);

  return json(res, 404, { error: "not_found", path });
};
