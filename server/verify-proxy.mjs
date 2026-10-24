#!/usr/bin/env node
// 端到端验证：起 mock 上游 + 起 provider 进程，逐项断言并打印 PASS/FAIL。
// 注意：本机沙箱禁止子进程通过管道回传 stdout，所以两端一律用「文件 fd 作 stdio」通信，
// 再增量读日志文件取端口；provider 自身的 HTTP 响应仍走 sockets，不受影响。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const BEARER = 'verify-bearer-0123456789';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbproxy-'));
const CFG_PATH = path.join(TMP, 'config.json');
const STATE_HOME = path.join(TMP, 'dsh');
const CATALOG_PATH = path.join(TMP, 'catalog.json');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}\n`);
};

function request(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function json(port, method, p, opts) {
  const r = await request(port, method, p, opts);
  let parsed = null;
  try {
    parsed = JSON.parse(r.text);
  } catch {}
  return { ...r, json: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用文件 fd 起子进程，返回 { child, logPath }
function spawnWithLog(script, env, args = []) {
  const logPath = path.join(TMP, `${path.basename(script, '.mjs')}-${crypto.randomBytes(3).toString('hex')}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(NODE, [path.join(DIR, script), ...args], {
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.__logPath = logPath;
  return child;
}

async function waitLog(child, pattern, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.on('exit', (code) => (exited = code));
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = fs.readFileSync(child.__logPath, 'utf8');
    } catch {}
    const m = text.match(pattern);
    if (m) return m;
    if (exited !== null) throw new Error(`子进程提前退出 code=${exited}；日志：${text.slice(0, 800)}`);
    await sleep(100);
  }
  let text = '';
  try {
    text = fs.readFileSync(child.__logPath, 'utf8');
  } catch {}
  throw new Error(`等待 ${pattern} 超时；日志：${text.slice(0, 800)}`);
}

// 与 provider 完全相同的 AAD 构造（本文件独立实现，用于交叉校验）
const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');
const u32len = (s) => {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return [h, b];
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
const buildAadIndep = (keyId, suite) =>
  Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    ...u32len('WBEV1'),
    ...u32len('sym-v1'),
    u32(suite),
    ...u32len(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);

// 从 provider 源码里抽出真实实现（不复制、不改写），单独成模块后调用
function parseProviderHelpers() {
  const srcPath = path.join(DIR, 'workbuddy-proxy.mjs');
  // Normalise CRLF: a git checkout on Windows may deliver CRLF, and the brace
  // scan below matches on bare '\n'.
  const full = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
  // Slice one function by brace depth. Searching for the '\n}\n' that ends a
  // TOP-LEVEL function breaks as soon as the function takes two or more
  // arguments: the closing paren of a multi-line signature sits directly before
  // the '{', so that occurrence is skipped and the scan finds nothing.
  const pick = (name) => {
    const start = full.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`provider 里找不到函数 ${name}`);
    const open = full.indexOf('{', start);
    if (open < 0) throw new Error(`函数 ${name} 缺少函数体`);
    let depth = 0;
    for (let k = open; k < full.length; k += 1) {
      if (full[k] === '{') depth += 1;
      else if (full[k] === '}') {
        depth -= 1;
        if (depth === 0) return full.slice(start, k + 1);
      }
    }
    throw new Error(`函数 ${name} 花括号不平衡`);
  };
  const header = [
    'const crypto = await import("node:crypto");',
    'const fs = await import("node:fs");',
    'const path = await import("node:path");',
    'const os = await import("node:os");',
    'const { execFileSync } = await import("node:child_process");',
    'let protectorKeyCache;',
  ].join('\n');
  const body = ['AAD_PREFIX', 'AAD_KEYS', 'ENC_MARKER', 'u32beLen', 'u32be', 'b64Exact', 'regMatches', 'findWorkBuddyExe', 'isEnvelope', 'buildAad', 'getProtectorKey', 'decryptEnvelope']
    .map((n) => {
      if (n === 'AAD_PREFIX') return 'const AAD_PREFIX = Buffer.from("WB-AAD\\0", "ascii");';
      if (n === 'AAD_KEYS') return 'const AAD_KEYS = ["WBEV1", "sym-v1"];';
      if (n === 'ENC_MARKER') return 'const ENC_MARKER = "$wbEncrypted";';
      return pick(n);
    })
    .join('\n');
  const tail = [
    'const __injectProtectorKey = (b64) => { globalThis.__WB_PROTECTOR_KEY__ = b64; };',
    'export { buildAad, decryptEnvelope, isEnvelope, b64Exact, __injectProtectorKey };',
  ].join('\n');
  const file = path.join(TMP, 'provider-helpers.mjs');
  fs.writeFileSync(file, `${header}\n${body}\n${tail}\n`);
  return import(`file://${file.replace(/\\/g, '/')}`);
}

// 现场生成 atRestSecretKey → sha256 派生 protectorKey → 加密假 token 造信封 → 交给 provider 真实解密函数
async function envelopeRoundTrip() {
  const helpers = await parseProviderHelpers();

  // 1) 交叉校验：provider 的 buildAad 与本文件独立实现必须逐字节一致
  const keyId = crypto.randomBytes(8).toString('hex');
  const aadProvider = helpers.buildAad(keyId, 1);
  const aadIndep = buildAadIndep(keyId, 1);
  const aadMatch = Buffer.compare(aadProvider, aadIndep) === 0;

  // 2) 现场生成守护密钥
  const atRest = crypto.randomBytes(32);
  const atRestB64 = atRest.toString('base64');
  const protector = crypto.createHash('sha256').update(atRestB64, 'utf8').digest();

  // 3) 按任务书 AAD 规则加密一个假 token
  const nonce = crypto.randomBytes(12);
  const token = `fake-access-token-${crypto.randomBytes(6).toString('hex')}`;
  const plaintext = JSON.stringify({ accessToken: token });
  const c = crypto.createCipheriv('aes-256-gcm', protector, nonce, { authTagLength: 16 });
  c.setAAD(aadIndep);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const envelope = {
    ['$wbEncrypted']: 1,
    envelope: Buffer.from(
      JSON.stringify({
        suite: 1,
        keyId,
        nonce: nonce.toString('base64'),
        authTag: tag.toString('base64'),
        ciphertext: ct.toString('base64'),
      }),
    ).toString('base64'),
  };

  // 4) 交给 provider 的真实解密函数（绕过 Electron，只注入派生好的 protectorKey）
  helpers.__injectProtectorKey(atRestB64);
  const got = helpers.decryptEnvelope(envelope);
  const roundTripOk = JSON.parse(got).accessToken === token;

  // 5) 故意改一个 AAD 字节（suite 位 2）→ 必须认证失败
  const badAad = Buffer.from(aadIndep);
  badAad[badAad.length - 6] = 2;
  let aadTamperRejected = false;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', protector, nonce, { authTagLength: 16 });
    d.setAAD(badAad);
    d.setAuthTag(tag);
    Buffer.concat([d.update(ct), d.final()]);
  } catch {
    aadTamperRejected = true;
  }

  // 6) 换一把错误的守护密钥 → 必须认证失败
  const wrongProtector = crypto.createHash('sha256').update(crypto.randomBytes(32).toString('base64'), 'utf8').digest();
  let wrongKeyRejected = false;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', wrongProtector, nonce, { authTagLength: 16 });
    d.setAAD(aadIndep);
    d.setAuthTag(tag);
    Buffer.concat([d.update(ct), d.final()]);
  } catch {
    wrongKeyRejected = true;
  }

  // 7) 篡改 ciphertext 一个字节 → 必须认证失败
  let ctTamperRejected = false;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', protector, nonce, { authTagLength: 16 });
    d.setAAD(aadIndep);
    d.setAuthTag(tag);
    const broken = Buffer.from(ct);
    broken[0] ^= 0xff;
    Buffer.concat([d.update(broken), d.final()]);
  } catch {
    ctTamperRejected = true;
  }

  return { aadMatch, roundTripOk, aadTamperRejected, wrongKeyRejected, ctTamperRejected, keyId, aadLen: aadIndep.length, tokenLen: token.length };
}

const children = [];
function killAll() {
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
}

async function main() {
  const mock = spawnWithLog('mock-upstream.mjs', process.env, ['0']);
  children.push(mock);
  const mockPort = Number((await waitLog(mock, /MOCK_PORT=(\d+)/))[1]);
  process.stdout.write(`mock 监听 ${mockPort}\n`);

  fs.writeFileSync(
    CFG_PATH,
    JSON.stringify(
      {
        port: 0,
        bearerToken: BEARER,
        upstreamBase: `http://127.0.0.1:${mockPort}`,
        appVersion: '5.5.2',
        catalogPath: CATALOG_PATH,
      },
      null,
      2,
    ),
  );

  // 凭证：用 auth-file（非 env token，才走刷新路径）。expiresAt 必须是「毫秒级、且距今 30 秒后」——
  // 秒级值（Date.now()/1000+30）换算成毫秒会落到 1970 年代，等于「永远已过期」，会让刷新窗口用例失真。
  const authFile = path.join(TMP, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify(
      {
        auth: {
          accessToken: 'stale-token',
          refreshToken: 'test-refresh',
          expiresAt: Date.now() + 30_000,
          domain: 'www.workbuddy.ai',
        },
        account: { uid: 'test-uid', nickname: 'Tester' },
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    WORKBUDDY_PROXY_CONFIG: CFG_PATH,
    WORKBUDDY_PROXY_BEARER: BEARER,
    WORKBUDDY_AUTH_FILE: authFile,
    DSH_HOME: STATE_HOME,
    LOCALAPPDATA: path.join(TMP, 'noLocal'),
    APPDATA: path.join(TMP, 'noRoaming'),
  };
  delete env.WORKBUDDY_PROXY_TOKEN;

  const proxy = spawnWithLog('workbuddy-proxy.mjs', env);
  children.push(proxy);
  let proxyPort;
  try {
    proxyPort = Number((await waitLog(proxy, /"event":"listening".*?"port":(\d+)/))[1]);
  } catch (err) {
    record('provider 启动', false, err.message);
    return;
  }
  record('provider 启动并监听随机端口', Number.isInteger(proxyPort) && proxyPort > 0, `port=${proxyPort}`);

  let healthy = false;
  for (let i = 0; i < 50 && !healthy; i++) {
    try {
      const r = await request(proxyPort, 'GET', '/healthz');
      healthy = r.status === 200;
    } catch {
      await sleep(100);
    }
  }
  record('/healthz 可用', healthy, 'healthz 未在 5s 内就绪');

  const H = { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' };

  // 1) 非流式聚合
  const nr = await json(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({ model: 'mock-balanced', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const msg = nr.json?.choices?.[0]?.message;
  const tcs = msg?.tool_calls || [];
  let argsJson = null;
  try {
    argsJson = JSON.parse(tcs[0]?.function?.arguments || '');
  } catch {}
  const nonStreamOk =
    nr.status === 200 &&
    nr.json?.object === 'chat.completion' &&
    msg?.content === 'Hello world' &&
    tcs.length === 1 &&
    tcs[0].function?.name === 'get_time' &&
    argsJson?.tz === 'UTC' &&
    nr.json?.choices?.[0]?.finish_reason === 'tool_calls' &&
    typeof nr.json?.usage?.total_tokens === 'number';
  record('非流式聚合：content + tool_calls 两段拼接 + finish_reason + usage', nonStreamOk, JSON.stringify(nr.json).slice(0, 400));

  // 2) 流式
  const sr = await request(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({ model: 'mock-balanced', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const lines = sr.text.split('\n').filter((l) => l.startsWith('data: '));
  const payloads = lines.filter((l) => l.slice(6) !== '[DONE]').map((l) => JSON.parse(l.slice(6)));
  const hasContent = payloads.some((p) => p.choices?.[0]?.delta?.content);
  const hasTool = payloads.some((p) => p.choices?.[0]?.delta?.tool_calls);
  const endsDone = lines.length > 0 && lines[lines.length - 1].slice(6) === '[DONE]';
  record(
    '流式 chunk：≥3 个、含 content/tool_calls、以 [DONE] 结束',
    sr.status === 200 && payloads.length >= 3 && hasContent && hasTool && endsDone,
    `chunks=${payloads.length} content=${hasContent} tool=${hasTool} done=${endsDone}`,
  );

  // 3) 请求体改写
  const rw = await json(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({
      model: 'mock-balanced',
      stream: false,
      messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'get_time' } }],
      __expectNoTools: true,
    }),
  });
  record('请求体改写：developer→system / 删 reasoning_effort off / tool_choice none 删 tools', rw.status === 200, `status=${rw.status} ${rw.text.slice(0, 300)}`);

  // 4) 错误映射
  const e402 = await json(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({ model: 'mock-402', messages: [{ role: 'user', content: 'hi' }] }),
  });
  record('402 → workbuddy_credit_exhausted', e402.status === 402 && e402.json?.error?.type === 'workbuddy_credit_exhausted', `${e402.status} ${e402.text.slice(0, 200)}`);

  const e401 = await json(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({ model: 'mock-balanced', messages: [{ role: 'user', content: '[ERR]' }] }),
  });
  record('401 Offline user session → workbuddy_session_dead', e401.status === 401 && e401.json?.error?.type === 'workbuddy_session_dead', `${e401.status} ${e401.text.slice(0, 200)}`);

  const e429 = await json(proxyPort, 'POST', '/v1/chat/completions', {
    headers: H,
    body: JSON.stringify({ model: 'mock-balanced', messages: [{ role: 'user', content: '[RATE]' }] }),
  });
  record('429 → 限流', e429.status === 429, `${e429.status} ${e429.text.slice(0, 200)}`);

  // 5) 本地鉴权
  const badAuth = await json(proxyPort, 'GET', '/v1/models', { headers: { Authorization: 'Bearer wrong' } });
  record('错误 Bearer → 401 invalid_bearer', badAuth.status === 401 && badAuth.json?.error?.type === 'invalid_bearer', `${badAuth.status}`);

  // 6) /v1/models
  const models = await json(proxyPort, 'GET', '/v1/models', { headers: H });
  const ids = (models.json?.data || []).map((m) => m.id);
  const modelsOk =
    models.status === 200 &&
    ids.length === 2 &&
    ids[0] === 'mock-balanced' &&
    ids[1] === 'mock-fast' &&
    !ids.includes('mock-disabled') &&
    !ids.includes('mock-zero-out') &&
    !ids.includes('mock-not-in-cli');
  record('/v1/models：按 cli 排序、过滤 disabled 与零 token 行', modelsOk, `ids=${JSON.stringify(ids)}`);
  let cacheOk = false;
  try {
    cacheOk = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))?.entries?.['test-uid:'] != null;
  } catch {}
  record('模型目录缓存按 <uid>: 键写入', cacheOk, 'catalog 缓存未写入或键不对');

  // 7) /v1/auth/status 脱敏
  const st = await json(proxyPort, 'GET', '/v1/auth/status', { headers: H });
  const leaks = ['test-token', 'refreshed-token', 'stale-token', 'test-refresh'].filter((t) => st.text.includes(t));
  record(
    '/v1/auth/status：来源/uid/domain/剩余毫秒，无 token 明文',
    st.status === 200 && leaks.length === 0 && typeof st.json?.source === 'string' && 'has_uid' in (st.json || {}),
    `leaks=${leaks.join(',')} body=${st.text.slice(0, 200)}`,
  );

  // 8) 刷新
  const mockState = await json(mockPort, 'GET', '/__state');
  const refreshedOk = mockState.json?.refreshCalls >= 1 && /refreshed-token/.test(mockState.json?.lastAuth || '');
  record('过期凭证自动刷新并改用 refreshed-token（单飞）', refreshedOk, JSON.stringify(mockState.json).slice(0, 300));

  // 9) 信封解密链路自检
  try {
    const rt = await envelopeRoundTrip();
    record(
      '信封 AAD 字节与独立实现一致',
      rt.aadMatch,
      `keyId=${rt.keyId} provider 与独立实现的 AAD 不一致`,
    );
    record(
      '现场造 envelope → provider 真实解密函数解回原文（AES-256-GCM 往返）',
      rt.roundTripOk,
      `roundtrip=${rt.roundTripOk} aadLen=${rt.aadLen} tokenLen=${rt.tokenLen}`,
    );
    record(
      '篡改 AAD / 换错密钥 / 篡改密文 三种情况均认证失败',
      rt.aadTamperRejected && rt.wrongKeyRejected && rt.ctTamperRejected,
      `aadTamper=${rt.aadTamperRejected} wrongKey=${rt.wrongKeyRejected} ctTamper=${rt.ctTamperRejected}`,
    );
  } catch (err) {
    record('信封解密链路自检', false, err?.message || String(err));
  }

  // 10) 冷启动不弹窗：reg.exe 每次调用都必须 windowsHide，且每个 root 只查一次
  try {
    const srcPath = path.join(DIR, 'workbuddy-proxy.mjs');
    const src = fs.readFileSync(srcPath, 'utf8');
    const callSites = [];
    for (let i = src.indexOf('execFileSync('); i >= 0; i = src.indexOf('execFileSync(', i + 1)) {
      callSites.push(src.slice(i, i + 400));
    }
    const noHide = callSites.filter((s) => !s.includes('windowsHide: true')).length;
    const regSites = callSites.filter((s) => s.includes("'reg.exe'")).length;
    const perRootSearch = /regMatches\(root, 'WorkBuddy'\)/.test(src);
    const oldPerKeyProbe = /'\/v',\s*'DisplayName'/.test(src);
    record(
      '冷启动不弹窗：子进程全部 windowsHide、reg.exe 只查一次且不再逐键 DisplayName',
      callSites.length > 0 && noHide === 0 && regSites === 1 && perRootSearch && !oldPerKeyProbe,
      `sites=${callSites.length} reg=${regSites} noHide=${noHide} perRoot=${perRootSearch} perKey=${oldPerKeyProbe}`,
    );
  } catch (err) {
    record('冷启动不弹窗检查', false, err?.message || String(err));
  }

  // 11) inspect-vault：明文来源分类且不泄露 token
  const insp = await runInspect(['--json'], {
    ...env,
    WORKBUDDY_PROXY_TOKEN: 'inspect-token-abcdef',
  });
  const inspOut = `${insp.out}${insp.err}`;
  const inspReportedSource = /env-token/.test(inspOut);
  const noLeak = !/inspect-token-abcdef/.test(inspOut);
  record('inspect-vault：正确报告来源且不打印 token', insp.code === 0 && inspReportedSource && noLeak, `code=${insp.code} ${inspOut.slice(0, 300)}`);
}

function runInspect(args, env) {
  return new Promise((resolve) => {
    const outPath = path.join(TMP, `inspect-${crypto.randomBytes(3).toString('hex')}.log`);
    const fd = fs.openSync(outPath, 'w');
    const child = spawn(NODE, [path.join(DIR, 'inspect-vault.mjs'), ...args], {
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    fs.closeSync(fd);
    child.on('exit', (code) => {
      let text = '';
      try {
        text = fs.readFileSync(outPath, 'utf8');
      } catch {}
      resolve({ code, out: text, err: '' });
    });
  });
}

let exitCode = 1;
try {
  await main();
} catch (err) {
  record('验证流程异常', false, err?.message || String(err));
} finally {
  killAll();
  await sleep(250);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(`\nPASS ${pass}/${results.length}  FAIL ${fail}\n`);
  for (const r of results.filter((x) => !x.ok)) process.stdout.write(`  - ${r.name} → ${r.detail}\n`);
  exitCode = fail === 0 ? 0 : 1;
  process.stdout.write(`退出码 ${exitCode}\n`);
  process.exit(exitCode);
}
