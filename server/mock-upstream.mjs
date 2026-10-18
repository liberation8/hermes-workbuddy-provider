#!/usr/bin/env node
// WorkBuddy 上游 mock：OpenAI 形状的假上游，用于无网络下的端到端自测。
import http from 'node:http';

const port = Number(process.argv[2] || 0);

function fail(res, status, code, zh) {
  const body = JSON.stringify({ code, msg: 'conversation id missing', displayMsg: { zh, en: 'request blocked' } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function badRequest(res, reason) {
  fail(res, 400, 11128, `请求被拦截，请重新发送（${reason}）`);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const state = {
  chatCalls: [],
  lastAuth: null,
  refreshCalls: 0,
  tokenAfterRefresh: null,
};

function assertUpstreamHeaders(headers, required) {
  const h = { ...headers };
  const missing = [];
  if (required.refresh) {
    // refresh 按任务书只带 X-Refresh-Token、X-Auth-Refresh-Source 与 common headers，
    // 这里跳过对话/目录专属的断言，避免把正确实现误判成缺头。
    delete h['x-product'];
    delete h['x-requested-with'];
    delete h['x-conversation-id'];
    delete h['x-conversation-request-id'];
    delete h['x-conversation-message-id'];
    delete h['x-ide-type'];
    h['x-user-id'] = h['x-user-id'] || 'refresh-ok';
  }
  const auth = String(h.authorization || '');
  // refresh 上游按任务书只要求 X-Refresh-Token + X-Auth-Refresh-Source + common headers，不带 Authorization
  if (!required.refresh && !/^Bearer\s+\S+$/.test(auth)) missing.push('authorization');
  if (required.refresh && auth && !/^Bearer\s+\S+$/.test(auth)) missing.push('authorization-format');
  // 模型目录（/v3/config）上游只要求 Authorization/Accept/Origin/Referer/X-Requested-With/X-Product/UA，
  // 不要求对话那套 X-Conversation-*/X-IDE-*，这里分档校验，否则会把正确实现误判成缺头。
  if (!required.catalog && !required.refresh) {
    for (const k of ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']) {
      if (!h[k]) missing.push(k);
    }
    if (!h['x-user-id'] && !h['x-no-user-id']) missing.push('x-user-id|x-no-user-id');
    if (h['x-ide-type'] !== 'WorkBuddy') missing.push('x-ide-type');
  }
  if (h['x-product'] !== 'SaaS' && !required.refresh) missing.push('x-product');
  if (required.behavior && !/^WorkBuddy\/[\d.]+\s+WorkBuddy AI\/[\d.]+$/.test(String(h['user-agent'] || ''))) {
    missing.push('user-agent');
  }
  if (required.catalogUA && !/^WorkBuddyAI\/[\d.]+$/.test(String(h['user-agent'] || ''))) {
    missing.push('user-agent');
  }
  if (required.refresh && h['x-auth-refresh-source'] !== 'workbuddy') missing.push('x-auth-refresh-source');
  if (required.refresh && !h['x-refresh-token']) missing.push('x-refresh-token');
  return missing;
}

function assertUpstreamBody(body) {
  if (body.stream !== true) return 'stream-not-true';
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (msgs.some((m) => m && m.role === 'developer')) return 'developer-role';
  if (body.reasoning_effort === 'off') return 'reasoning-effort-off';
  if (body.__expectNoTools && (body.tools || body.functions)) return 'tools-not-stripped';
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // mock 自省：供 verify 脚本查询是否发生过刷新
  if (url === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ refreshCalls: state.refreshCalls, lastAuth: state.lastAuth, chatCalls: state.chatCalls.length }));
    return;
  }

  if (url === '/v2/plugin/auth/token/refresh') {
    const miss = assertUpstreamHeaders(req.headers, { refresh: true });
    if (miss.length) {
      badRequest(res, `refresh-headers:${miss.join(',')}`);
      return;
    }
    await readBody(req);
    state.refreshCalls += 1;
    state.tokenAfterRefresh = 'refreshed-token';
    const body = JSON.stringify({ code: 0, data: { accessToken: 'refreshed-token', expiresIn: 3600 } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (url === '/v3/config') {
    const miss = assertUpstreamHeaders(req.headers, { catalog: true, catalogUA: true });
    if (miss.length) {
      badRequest(res, `catalog-headers:${miss.join(',')}`);
      return;
    }
    const payload = {
      code: 0,
      msg: 'ok',
      data: {
        models: [
          { id: 'mock-fast', name: 'Mock Fast', maxInputTokens: 200000, maxOutputTokens: 32000, contextWindow: 200000, supportsImages: true },
          { id: 'mock-balanced', name: 'Mock Balanced', maxInputTokens: 256000, maxOutputTokens: 32000, contextWindow: 256000, supportsImages: true },
          { id: 'mock-disabled', name: 'Mock Disabled', disabled: true, maxInputTokens: 128000, maxOutputTokens: 8000 },
          { id: 'mock-zero-out', name: 'Mock Zero Out', maxInputTokens: 128000, maxOutputTokens: 0 },
          { id: 'mock-not-in-cli', name: 'Mock Not In CLI', maxInputTokens: 128000, maxOutputTokens: 8000 },
        ],
        agents: [{ name: 'cli', models: ['mock-balanced', 'mock-fast'] }],
      },
    };
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (url === '/v2/chat/completions') {
    const miss = assertUpstreamHeaders(req.headers, { behavior: true });
    if (miss.length) {
      badRequest(res, `chat-headers:${miss.join(',')}`);
      return;
    }
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    state.lastAuth = String(req.headers.authorization || '');
    state.chatCalls.push({ model: body.model, auth: state.lastAuth });

    const bodyErr = assertUpstreamBody(body);
    if (bodyErr) {
      badRequest(res, `body:${bodyErr}`);
      return;
    }

    const userText = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

    if (body.model === 'mock-402') {
      const b = JSON.stringify({ code: 10110, msg: 'insufficient credit', displayMsg: { zh: '积分不足，请充值' } });
      res.writeHead(402, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
      return;
    }
    if (userText.includes('[ERR]')) {
      const b = JSON.stringify({ code: 401, msg: 'Offline user session not found' });
      res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
      return;
    }
    if (userText.includes('[RATE]')) {
      const b = JSON.stringify({ code: 1429, msg: 'too many requests', displayMsg: { zh: '请求过于频繁' } });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': ping\n\n');
    const base = { id: 'chatcmpl-mock', model: body.model || 'mock-balanced', object: 'chat.completion.chunk' };
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] });
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'get_time', arguments: '{"' } }] }, finish_reason: null }],
    });
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'tz":"UTC"}' } }] }, finish_reason: null }],
    });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404, msg: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`MOCK_PORT=${addr.port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
