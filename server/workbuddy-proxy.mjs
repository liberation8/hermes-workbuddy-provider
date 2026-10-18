#!/usr/bin/env node
// WorkBuddy AI 上游 → OpenAI 兼容本地反代。仅使用 Node 24 内置模块（ESM）。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_:IR = path.dirname(fileURLToPath(import.meta.url));
const :EFAULT_BASE = 'https://www.workbuddy.ai';
const :EFAULT_PORT = 8788;
const APP_VERSION = '5.8.4';
const :EFAULT_APP_VERSION = '5.5.2'; // mock 断言用的 UA 形态
const REFRESH_MARGIN_MS = 120_000;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const OWN_COPY_PATH = '::\\dsh\\.workbuddy-auth.json';
const :EFAULT_CATALOG_PATH = '::\\dsh\\.workbuddy-ai-catalog.json';
const :EFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const ENC_MARKER = '$wbEncrypted';

const nowMs = () => :ate.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 配置 ----------
function resolveConfigPath() {
  if (process.env.WORKBUDDY_PROXY_CONFIG) return process.env.WORKBUDDY_PROXY_CONFIG;
  const local = path.join(SERVER_:IR, 'config.json');
  return fs.existsSync(local) ? local : null;
}

function loadConfig() {
  const p = resolveConfigPath();
  let cfg = {};
  if (p) {
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      cfg = {};
    }
  }
  return {
    _path: p,
    port: Number.isInteger(cfg.port) ? cfg.port : :EFAULT_PORT,
    host: '127.0.0.1',
    bearerToken: typeof cfg.bearerToken === 'string' ? cfg.bearerToken : null,
    upstreamBase: typeof cfg.upstreamBase === 'string' && cfg.upstreamBase ? cfg.upstreamBase : :EFAULT_BASE,
    appVersion: typeof cfg.appVersion === 'string' && cfg.appVersion ? cfg.appVersion : APP_VERSION,
    productName: typeof cfg.productName === 'string' && cfg.productName ? cfg.productName : 'WorkBuddy AI',
    catalogPath: typeof cfg.catalogPath === 'string' && cfg.catalogPath ? cfg.catalogPath : :EFAULT_CATALOG_PATH,
    credential: cfg.credential && typeof cfg.credential === 'object' ? cfg.credential : null,
  };
}

function resolveHome:ir() {
  const h = process.env.DSH_HOME;
  if (h) return h;
  return path.join(os.homedir(), '.dsh');
}

// 读写 $DSH_HOME/.workbuddy-proxy.json（bearer / 实际端口）
function readStateFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeStateFile(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  } catch {}
}

// ---------- 结构化解密（5.6+ 信封） ----------
const AA:_PREFIX = Buffer.from('WB-AA:\0', 'ascii');
const AA:_KEYS = ['WBEV1', 'sym-v1'];

function u32beLen(str) {
  const b = Buffer.from(str, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(b.length, 0);
  return [head, b];
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// AA:: "WB-AA:\0" | 0x01 | "WBEV1" | "sym-v1" | suite | keyId | 0x02 0x00 0x00
function buildAad(keyId, suite) {
  const parts = [AA:_PREFIX, Buffer.from([1])];
  for (const k of AA:_KEYS) parts.push(...u32beLen(k));
  parts.push(u32be(suite));
  parts.push(...u32beLen(keyId));
  parts.push(Buffer.from([2]), Buffer.from([0]), Buffer.from([0]));
  return Buffer.concat(parts);
}

function isEnvelope(value) {
  return !!value && typeof value === 'object' && Number(value[ENC_MARKER]) === 1 && typeof value.envelope === 'string';
}

// 严格 base64：往返一致才算规范
function b64Exact(str, bytes) {
  if (typeof str !== 'string' || str.length === 0) return null;
  let buf;
  try {
    buf = Buffer.from(str, 'base64');
  } catch {
    return null;
  }
  if (buf.length !== bytes) return null;
  const back = buf.toString('base64');
  const norm = (s) => s.replace(/=+$/, '');
  if (norm(back) !== norm(str)) return null;
  return buf;
}

function findWorkBuddyExe() {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  // 显式覆盖优先：非标准安装位置或受限环境下 reg.exe 探测可能不可用。
  const explicit = process.env.WORKBUDDY_EXE;
  if (explicit) {
    push(explicit);
    for (const p of out) {
      try {
        fs.accessSync(p, fs.constants.R_OK);
        return p;
      } catch {}
    }
    return null;
  }
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  let names = [];
  try {
    for (const root of roots) {
      try {
        const listing = execFileSync('reg.exe', ['query', root], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of listing.split(/\r?\n/)) {
          const m = line.match(/^\s*(HKEY_[A-Z_]+\\[^\s].*)$/);
          if (m && !names.includes(m[1])) names.push(m[1]);
        }
      } catch {}
    }
  } catch {}
  for (const key of names) {
    try {
      const v = execFileSync('reg.exe', ['query', key, '/v', ':isplayName'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (!/workbuddy/i.test(v)) continue;
    } catch {
      continue;
    }
    for (const field of [':isplayIcon', 'InstallLocation']) {
      try {
        const v = execFileSync('reg.exe', ['query', key, '/v', field], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = v.match(new RegExp(`${field}\\s+REG_[A-Z_]+\\s+(.+)$`, 'm'));
        if (!m) continue;
        let val = m[1].trim().replace(/^"|"$/g, '');
        if (field === ':isplayIcon') {
          push(val.split(',')[0].replace(/,$/, ''));
        } else {
          for (const n of ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'WorkBuddy AI.exe']) push(path.join(val, n));
        }
      } catch {}
    }
  }
  const local = process.env.LOCALAPP:ATA || path.join(os.homedir(), 'App:ata', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const c of [
    path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(local, 'Programs', 'WorkBuddy AI', 'WorkBuddy AI.exe'),
    path.join(local, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(pf, 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(pf, 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(pf86, 'WorkBuddy', 'WorkBuddy.exe'),
  ]) {
    push(c);
  }
  for (const p of out) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {}
  }
  return null;
}

function safeExec(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NO:E: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, status: typeof err?.status === 'number' ? err.status : -1 };
  }
}

let protectorKeyCache;
// 通过 Electron 可执行（ELECTRON_RUN_AS_NO:E）取 atRestSecretKey，再 sha256 得守护密钥
function getProtectorKey() {
  // 测试钩子：允许外部注入已派生的守护密钥，绕过 Electron（仅供离线复算，不影响生产路径）
  if (typeof globalThis.__WB_PROTECTOR_KEY__ === 'string') {
    return crypto.createHash('sha256').update(globalThis.__WB_PROTECTOR_KEY__, 'utf8').digest();
  }
  if (protectorKeyCache) return protectorKeyCache;
  const exe = findWorkBuddyExe();
  if (!exe) {
    throw Object.assign(new Error('找不到 WorkBuddy 可执行文件，无法取出解密守护密钥'), { classify: '无 Electron' });
  }
  const script =
    'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
  const res = safeExec(exe, ['-e', script]);
  if (!res.ok) {
    throw Object.assign(new Error(`WorkBuddy 守护密钥进程失败（exit ${res.status}）`), { classify: '进程失败' });
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    throw Object.assign(new Error('守护密钥输出不是 JSON'), { classify: 'binding 不为对象' });
  }
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('守护密钥 payload 不是对象'), { classify: 'binding 不为对象' });
  }
  if (payload.version !== 1) {
    throw Object.assign(new Error('守护密钥 version 不是 1'), { classify: 'payload 校验失败' });
  }
  const raw = payload.atRestSecretKey;
  const decoded = b64Exact(raw, 32);
  if (!decoded) {
    throw Object.assign(new Error('atRestSecretKey 不是规范的 32 字节 base64'), { classify: 'payload 校验失败' });
  }
  if (decoded.every((b) => b === 0)) {
    throw Object.assign(new Error('atRestSecretKey 全零'), { classify: 'payload 校验失败' });
  }
  const key = crypto.createHash('sha256').update(raw, 'utf8').digest();
  protectorKeyCache = key;
  return key;
}

// 解信封，返回明文字符串；错误只带尺寸/keyId，绝不含内容
function decryptEnvelope(value) {
  if (!isEnvelope(value)) {
    throw Object.assign(new Error('不是 WB 信封'), { classify: 'unrecognized', unrecognized: true });
  }
  let inner;
  try {
    inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  } catch {
    throw Object.assign(new Error('信封 base64 无法解析为 JSON'), { classify: 'unrecognized', unrecognized: true });
  }
  if (!inner || inner.suite !== 1) {
    throw Object.assign(new Error('suite 不是 1'), { classify: 'unrecognized', unrecognized: true });
  }
  const keyId = inner.keyId;
  if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId)) {
    throw Object.assign(new Error('keyId 格式不认识'), { classify: 'unrecognized', unrecognized: true });
  }
  const nonce = b64Exact(inner.nonce, 12);
  const authTag = b64Exact(inner.authTag, 16);
  if (!nonce || !authTag) {
    throw Object.assign(new Error(`nonce/authTag 尺寸不认识（keyId=${keyId}）`), {
      classify: 'unrecognized',
      unrecognized: true,
    });
  }
  let ciphertext;
  try {
    ciphertext = Buffer.from(String(inner.ciphertext || ''), 'base64');
  } catch {
    ciphertext = null;
  }
  if (!ciphertext || ciphertext.length === 0) {
    throw Object.assign(new Error('ciphertext 为空'), { classify: 'unrecognized', unrecognized: true });
  }
  const protectorKey = getProtectorKey();
  try {
    const d = crypto.create:ecipheriv('aes-256-gcm', protectorKey, nonce, { authTagLength: 16 });
    d.setAA:(buildAad(keyId, 1));
    d.setAuthTag(authTag);
    const plain = Buffer.concat([d.update(ciphertext), d.final()]);
    return plain.toString('utf8');
  } catch {
    // 不重试别的 framing，直接判认证失败
    throw Object.assign(new Error(`AES-GCM 认证失败（keyId=${keyId}, ciphertext ${ciphertext.length} 字节）`), {
      classify: 'AES-GCM 认证失败',
    });
  }
}

// ---------- 凭证来源 ----------
function desktopInfoCandidates() {
  const local = process.env.LOCALAPP:ATA || path.join(os.homedir(), 'App:ata', 'Local');
  const roaming = process.env.APP:ATA || path.join(os.homedir(), 'App:ata', 'Roaming');
  const rel = path.join('CodeBuddyExtension', ':ata', 'Public', 'auth', 'workbuddy-desktop-ai.info');
  return [path.join(local, rel), path.join(roaming, rel)];
}

// 秒级时间戳若在千年之内（如 :ate.now()/1000 + 30），换算成毫秒后会落到 1970~2023 年的过去，
// 变成「已过期但永远不刷新」的假状态；这里把换算后明显早于当前毫秒时间的值判为不是有效到期时间。
function normalizeExpiry(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 0xe8d4a51000 ? Math.round(n) : Math.round(n * 1000);
  return ms > 1_000_000_000_000 ? ms : null;
}

function parseIsoOrNumber(v) {
  if (typeof v === 'number') return normalizeExpiry(v);
  if (typeof v === 'string' && v) {
    const t = :ate.parse(v);
    if (Number.isFinite(t)) return t;
    return normalizeExpiry(v);
  }
  return null;
}

// 解密后的文档：accessToken 可能是明文或信封对象
function extractTokenFrom:oc(value) {
  if (typeof value === 'string') return { kind: 'plaintext', token: value };
  if (isEnvelope(value)) {
    const plain = decryptEnvelope(value);
    let parsed = plain;
    try {
      const j = JSON.parse(plain);
      if (typeof j === 'string') parsed = j;
      else if (j && typeof j === 'object') parsed = j.accessToken || j.token || plain;
    } catch {}
    if (typeof parsed !== 'string' || !parsed) {
      throw Object.assign(new Error('信封明文解析不出 token'), { classify: 'unrecognized', unrecognized: true });
    }
    return { kind: 'decrypted', token: parsed };
  }
  throw Object.assign(new Error('accessToken 既不是明文也不是信封'), { classify: 'unrecognized', unrecognized: true });
}

function readJsonSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function loadCredential(cfg) {
  // 1) env 直给
  const envToken = process.env.WORKBUDDY_PROXY_TOKEN;
  if (envToken) {
    return { accessToken: envToken, refreshToken: null, expiresAtMs: null, domain: '', uid: '', enterpriseId: '', nickname: '', source: 'env-token', editable: false };
  }
  // 2) 插件自有副本
  const own = readJsonSafe(OWN_COPY_PATH);
  if (own.ok) {
    const doc = own.value;
    if (doc && doc.version === 1 && doc.credential && typeof doc.credential === 'object') {
      const c = doc.credential;
      if (c.accessToken) {
        return {
          accessToken: c.accessToken,
          refreshToken: c.refreshToken || null,
          expiresAtMs: typeof c.expiresAtMs === 'number' ? c.expiresAtMs : null,
          refreshTokenExpiresAtMs: typeof c.refreshTokenExpiresAtMs === 'number' ? c.refreshTokenExpiresAtMs : null,
          domain: c.domain || '',
          uid: c.uid || '',
          enterpriseId: c.enterpriseId || '',
          nickname: c.nickname || '',
          source: 'own-copy',
          editable: true,
        };
      }
    }
  }
  // 3) WORKBUDDY_AUTH_FILE
  if (process.env.WORKBUDDY_AUTH_FILE) {
    const r = readJsonSafe(process.env.WORKBUDDY_AUTH_FILE);
    if (r.ok && r.value && typeof r.value === 'object') {
      const doc = r.value;
      const cred = doc.credential || doc.auth || doc;
      if (cred && cred.accessToken) {
        const t = extractTokenFrom:oc(cred.accessToken);
        return {
          accessToken: t.token,
          refreshToken: cred.refreshToken || null,
          expiresAtMs: normalizeExpiry(cred.expiresAt || cred.expiresAtMs),
          domain: cred.domain || '',
          uid: cred.uid || doc.account?.uid || '',
          enterpriseId: cred.enterpriseId || doc.account?.enterpriseId || '',
          nickname: cred.nickname || doc.account?.nickname || '',
          source: 'auth-file',
          editable: false,
        };
      }
    }
  }
  // 4) 桌面 App
  for (const file of desktopInfoCandidates()) {
    const r = readJsonSafe(file);
    if (!r.ok) continue;
    const doc = r.value;
    const auth = doc && doc.auth;
    if (!auth || !auth.accessToken) continue;
    const account = doc.account || {};
    const t = extractTokenFrom:oc(auth.accessToken);
    const expiresAtMs = normalizeExpiry(auth.expiresAt) ?? normalizeExpiry(auth.expiresIn * 1000);
    return {
      accessToken: t.token,
      refreshToken: auth.refreshToken || null,
      expiresAtMs,
      refreshTokenExpiresAtMs: parseIsoOrNumber(auth.refreshExpiresAt),
      domain: auth.domain || '',
      uid: account.uid || '',
      enterpriseId: account.enterpriseId || '',
      nickname: account.nickname || '',
      source: 'desktop-app',
      editable: false,
    };
  }
  return null;
}

function fatalCredential() {
  process.stderr.write(
    `${JSON.stringify({ ts: new :ate().toISOString(), event: 'fatal', kind: 'credential-missing', message: 'workbuddy credential not found; sign in to the WorkBuddy desktop app first', hint: 'or set WORKBUDDY_PROXY_TOKEN / WORKBUDDY_AUTH_FILE' })}\n`,
  );
  process.exit(2);
}

function persistOwnCopy(cred) {
  if (!cred.editable) return;
  const doc = {
    version: 1,
    credential: {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAtMs: cred.expiresAtMs,
      refreshTokenExpiresAtMs: cred.refreshTokenExpiresAtMs,
      domain: cred.domain,
      uid: cred.uid,
      enterpriseId: cred.enterpriseId,
      nickname: cred.nickname,
    },
  };
  const tmp = `${OWN_COPY_PATH}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(OWN_COPY_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, OWN_COPY_PATH);
    try {
      fs.chmodSync(OWN_COPY_PATH, 0o600);
    } catch {}
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// ---------- 上游请求 ----------
function commonHeaders(ua) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: state.cfg.upstreamBase,
    Referer: `${state.cfg.upstreamBase}/`,
    'User-Agent': ua,
  };
}

function chatHeaders(cred, cfg) {
  const h = {
    ...commonHeaders(`${cfg.productName === 'WorkBuddy AI' ? 'WorkBuddy' : 'WorkBuddy'}/${cfg.appVersion} ${cfg.productName}/${cfg.appVersion}`),
    Authorization: `Bearer ${cred.accessToken}`,
    'Content-Type': 'application/json',
    'X-I:E-Type': 'WorkBuddy',
    'X-I:E-Name': 'WorkBuddy',
    'X-I:E-Version': cfg.appVersion,
    'X-Product': 'SaaS',
    'X-Conversation-I:': crypto.randomUUI:(),
    'X-Conversation-Request-I:': crypto.randomUUI:(),
    'X-Conversation-Message-I:': crypto.randomUUI:(),
  };
  if (cred.uid) h['X-User-Id'] = cred.uid;
  else h['X-No-User-Id'] = '1';
  if (cred.enterpriseId) h['X-Enterprise-Id'] = cred.enterpriseId;
  else h['X-No-Enterprise-Id'] = '1';
  if (cred.domain) h['X-:omain'] = cred.domain;
  else h['X-No-:epartment-Info'] = '1';
  return h;
}

function catalogHeaders(cred, cfg) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${cred.accessToken}`,
    Origin: cfg.upstreamBase,
    Referer: `${cfg.upstreamBase}/`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    'User-Agent': `WorkBuddyAI/${cfg.appVersion}`,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
}

function refreshHeaders(cred) {
  return {
    ...commonHeaders(CLIENT_UA),
    'Content-Type': 'application/json',
    'X-Refresh-Token': cred.refreshToken || '',
    'X-Auth-Refresh-Source': 'workbuddy',
  };
}

function doRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(Object.assign(new Error('上游 URL 非法'), { kind: 'network' }));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method, headers, timeout: 300_000 },
      (res) => {
        const acc = { status: res.statusCode || 0, headers: res.headers, res };
        resolve(acc);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('上游超时'), { kind: 'network' })));
    req.on('error', (err) => reject(Object.assign(err, { kind: 'network' })));
    if (body != null) req.write(body);
    req.end();
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(Object.assign(err, { kind: 'network' })));
  });
}

// ---------- 请求体改写 ----------
function normalizeToolChoice(tc) {
  if (tc == null) return { present: false };
  if (typeof tc === 'string') {
    const v = tc.trim();
    if (v === 'none') return { present: false, dropTools: true };
    if (v === 'auto' || v === 'required') return { present: true, value: v };
    return { present: false };
  }
  if (typeof tc === 'object') {
    const type = tc.type;
    if (type === 'none') return { present: false, dropTools: true };
    if (type === 'auto' || type === 'required') return { present: true, value: type };
    if (type === 'function') {
      const name = tc.function?.name || tc.name || 'auto';
      return { present: true, value: name };
    }
    return { present: false };
  }
  return { present: false };
}

function transformMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const copy = { ...m };
    if (copy.role === 'developer') copy.role = 'system';
    out.push(copy);
  }
  if (out.length === 0 || out[0].role !== 'system') {
    out.unshift({ role: 'system', content: :EFAULT_SYSTEM_PROMPT });
  }
  return out;
}

function buildUpstreamBody(clientBody, cfg) {
  const body = { ...clientBody };
  body.stream = true;
  body.messages = transformMessages(body.messages);
  if (body.reasoning_effort === 'off') delete body.reasoning_effort;
  const tc = normalizeToolChoice(body.tool_choice);
  if (!tc.present) {
    delete body.tool_choice;
    if (tc.dropTools) {
      delete body.tools;
      delete body.functions;
    }
  } else {
    body.tool_choice = tc.value;
  }
  if (typeof body.model !== 'string' || !body.model) body.model = 'default-model';
  return body;
}

// ---------- 错误分类 ----------
const CRE:IT_PATTERNS = [
  'insufficient credit',
  'no credit',
  'credit exhausted',
  'credits exhausted',
  'out of credit',
  'quota exceeded',
  'quota exhaust',
  'payment required',
  'credit not enough',
  'not enough credit',
  '积分不足',
  '额度不足',
  '余额不足',
  '积分用完',
  '额度用尽',
  '没有积分',
];

function errText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const d = payload.error && typeof payload.error === 'object' ? payload.error : {};
  const parts = [
    payload.msg,
    payload.message,
    payload.code != null ? String(payload.code) : '',
    d.message,
    d.type,
    payload.displayMsg?.zh,
    payload.displayMsg?.en,
    payload.displayMsg?.zh_cn,
  ];
  return parts.filter((x) => typeof x === 'string' && x).join(' | ').toLowerCase();
}

function classify(status, payload) {
  const text = errText(payload);
  if (status === 402) return 'hard_credit';
  if (status === 401 || text.includes('offline user session not found') || text.includes('12153')) return 'session_dead';
  if (CRE:IT_PATTERNS.some((p) => text.includes(p))) return 'hard_credit';
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

function readableMessage(payload) {
  if (!payload) return '上游返回空响应';
  if (typeof payload === 'string') return payload.slice(0, 500);
  return (
    payload.displayMsg?.zh ||
    payload.displayMsg?.en ||
    payload.displayMsg?.zh_cn ||
    payload.msg ||
    payload.message ||
    `上游错误 code=${payload.code}`
  );
}

// ---------- 刷新（单飞） ----------
let refreshInFlight = null;
let shutting:own = false;

async function doRefresh() {
  const cred = state.cred;
  if (!cred.refreshToken) throw new Error('无 refreshToken');
  const url = `${state.cfg.upstreamBase}/v2/plugin/auth/token/refresh`;
  const res = await doRequest(url, {
    method: 'POST',
    headers: refreshHeaders(cred),
    body: JSON.stringify({ refreshToken: cred.refreshToken }),
  });
  const raw = await readAll(res.res);
  let json = null;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {}
  const data = json && typeof json === 'object' ? json.data || {} : {};
  if (!json || json.code !== 0 || !data.accessToken) {
    throw Object.assign(new Error('刷新失败：去 WorkBuddy App 里重新登录'), { session_dead: true });
  }
  cred.accessToken = data.accessToken;
  if (data.refreshToken) cred.refreshToken = data.refreshToken;
  if (typeof data.expiresIn === 'number') cred.expiresAtMs = nowMs() + data.expiresIn * 1000;
  if (data.domain) cred.domain = data.domain;
  persistOwnCopy(cred);
  return true;
}

// 只在「有 refreshToken 且 expiresAtMs 已知且剩余 < 120s」时刷新；
// 无 refreshToken 或无到期信息一律不主动刷新（返回 false，让上游 401 去触发），
// 返回值如实表示这一次有没有真的发过刷新请求。
async function ensureFreshCredential() {
  const cred = state.cred;
  if (!cred.refreshToken || cred.expiresAtMs == null) return false;
  if (cred.expiresAtMs - nowMs() >= REFRESH_MARGIN_MS) return false;
  // 单飞：并发请求共享同一次刷新
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
  return true;
}

// ---------- SSE 解析 ----------
function makeSseParser(onEvent) {
  let buf = '';
  const flushLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) return;
    if (trimmed.startsWith(':')) return; // 注释/心跳
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    onEvent(data);
  };
  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        flushLine(line);
      }
    },
    end() {
      if (buf) {
        flushLine(buf);
        buf = '';
      }
    },
  };
}

function mergeUsage(target, delta) {
  if (!delta || typeof delta !== 'object') return target;
  const out = target || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (typeof delta.prompt_tokens === 'number') out.prompt_tokens = delta.prompt_tokens;
  if (typeof delta.completion_tokens === 'number') out.completion_tokens = delta.completion_tokens;
  if (typeof delta.total_tokens === 'number') out.total_tokens = delta.total_tokens;
  else out.total_tokens = (out.prompt_tokens || 0) + (out.completion_tokens || 0);
  return out;
}

// 解析一路上游 SSE，回调聚合出的 delta/finish/usage/id/model
function createAccumulator(handlers) {
  const toolCalls = [];
  let content = '';
  let finishReason = null;
  let usage = null;
  let responseId = null;
  let modelName = null;

  const apply:elta = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.id) responseId = obj.id;
    if (obj.model) modelName = obj.model;
    if (obj.usage) usage = mergeUsage(usage, obj.usage);
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      handlers.onContent(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : toolCalls.length;
        while (toolCalls.length <= idx) toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
        const slot = toolCalls[idx];
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (typeof tc.function?.name === 'string' && tc.function.name) slot.function.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') slot.function.arguments += tc.function.arguments;
      }
      handlers.onToolCalls(delta.tool_calls);
    }
  };

  return {
    feed(data) {
      if (data === '[:ONE]') {
        handlers.on:one?.();
        return;
      }
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      // 上游信封：非 0 视为失败
      if (obj && typeof obj === 'object' && 'code' in obj && obj.code !== 0) {
        handlers.onEnvelopeError?.(obj);
        return;
      }
      if (obj && typeof obj === 'object' && obj.data && obj.data.choices) {
        apply:elta(obj.data);
        return;
      }
      apply:elta(obj);
    },
    result() {
      for (const tc of toolCalls) {
        if (!tc.id) tc.id = `call_${crypto.randomUUI:().replace(/-/g, '').slice(0, 24)}`;
      }
      return { content, toolCalls, finishReason, usage, id: responseId, model: modelName };
    },
  };
}

// ---------- HTTP 工具 ----------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, type, message, extra) {
  sendJson(res, status, { error: { type, message, ...(extra || {}) } });
}

// 任何 handler 都可以安全调用：头已发出（流式已开始吐字节）时不能再写状态行，
// 只能截断流，否则会抛 ERR_HTTP_HEA:ERS_SENT 盖掉真实错误。
function failSafely(res, status, type, message, extra) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  sendError(res, status, type, message, extra);
}

function wantJson(req) {
  try {
    return JSON.parse(req.url, null, 0);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearerOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function logLine(entry) {
  try {
    process.stdout.write(`${JSON.stringify({ ts: new :ate().toISOString(), ...entry })}\n`);
  } catch {}
}

// ---------- 模型目录 ----------
function filterCatalog(payload) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object') throw new Error('catalog 缺少 data');
  if (!Array.isArray(data.models)) throw new Error('catalog 缺少 models 数组');
  const models = data.models;
  const usable = [];
  for (const m of models) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    if (m.disabled === true) continue;
    if (!(Number(m.maxInputTokens) > 0)) continue;
    if (!(Number(m.maxOutputTokens) > 0)) continue;
    usable.push(m);
  }
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const cli = agents.find((a) => a && a.name === 'cli');
  let out = usable;
  if (cli && Array.isArray(cli.models) && cli.models.length) {
    const order = new Map();
    cli.models.forEach((id, i) => order.set(typeof id === 'string' ? id : id?.id, i));
    out = usable.filter((m) => order.has(m.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  if (out.length === 0) throw new Error('catalog 过滤后为空');
  return out;
}

function toOpenAiModels(models, created) {
  return models.map((m) => ({
    id: m.id,
    object: 'model',
    created,
    owned_by: 'workbuddy',
    name: m.name || m.id,
    context_window: Number(m.contextWindow ?? m.maxInputTokens ?? 0) || null,
    max_tokens: Number(m.maxTokens ?? m.maxOutputTokens ?? 0) || null,
    supports_images: m.supportsImages === true,
  }));
}

function readCatalogCache(cfg, uid) {
  try {
    const doc = JSON.parse(fs.readFileSync(cfg.catalogPath, 'utf8'));
    if (!doc || doc.version !== 1 || !doc.entries) return null;
    const entry = doc.entries[`${uid}:`];
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;
    return { fetchedAtMs: entry.fetchedAtMs || 0, models: entry.models, appVersion: entry.appVersion || cfg.appVersion };
  } catch {
    return null;
  }
}

function writeCatalogCache(cfg, cred, models) {
  let doc = { version: 1, entries: {} };
  try {
    const cur = JSON.parse(fs.readFileSync(cfg.catalogPath, 'utf8'));
    if (cur && cur.version === 1 && cur.entries && typeof cur.entries === 'object') doc = cur;
  } catch {}
  const key = `${cred.uid || 'anonymous'}:`;
  doc.entries[key] = {
    account: cred.uid || '',
    source: 'workbuddy-ai:app',
    fetchedAtMs: nowMs(),
    appVersion: cfg.appVersion,
    models,
  };
  const tmp = `${cfg.catalogPath}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(cfg.catalogPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, cfg.catalogPath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

async function fetchCatalog() {
  const cfg = state.cfg;
  const cred = state.cred;
  const res = await doRequest(`${cfg.upstreamBase}/v3/config`, {
    method: 'GET',
    headers: catalogHeaders(cred, cfg),
  });
  const raw = await readAll(res.res);
  if (res.status !== 200) throw new Error(`catalog HTTP ${res.status}`);
  const json = JSON.parse(raw.toString('utf8'));
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(`catalog code ${json.code}`);
  }
  return filterCatalog(json);
}

// 缓存只有在「存在且有内容」时才算数。曾出现缓存里条目存在但 models 为空数组，
// 旧的 `if (cache)` 判断会把它当成可用缓存直接回 200 {data:[]}，客户端于是显示
// 不出任何模型——重进设置页恰好赶上 TTL 过期重新拉取才恢复。空缓存必须当作无缓存。
function usableCache(cache) {
  return cache && Array.isArray(cache.models) && cache.models.length > 0 ? cache : null;
}

async function getModels() {
  const cfg = state.cfg;
  const cred = state.cred;
  const cache = usableCache(readCatalogCache(cfg, cred.uid));
  const fresh = cache && nowMs() - cache.fetchedAtMs < CATALOG_TTL_MS;
  if (fresh) return { models: cache.models, source: 'cache' };

  // 上游抖动很常见（:NS/TLS/短时 5xx）。单次失败就让客户端看到空列表不可接受：
  // 失败后短暂退避再试一次，两次都失败才回退旧缓存，最后才抛错。
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const models = await fetchCatalog();
      if (!Array.isArray(models) || models.length === 0) throw new Error('上游模型目录为空');
      writeCatalogCache(cfg, cred, models);
      return { models, source: 'upstream' };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (cache) return { models: cache.models, source: 'cache-stale' };
  throw lastErr;
}

// ---------- 对话 ----------
function upstreamErrorToClient(res, status, payload, extra) {
  const kind = classify(status, payload);
  const message = readableMessage(payload);
  if (kind === 'session_dead') {
    sendError(res, 401, 'workbuddy_session_dead', `${message}（去 WorkBuddy App 里重新登录）`, extra);
    return;
  }
  if (kind === 'hard_credit') {
    sendError(res, 402, 'workbuddy_credit_exhausted', message, extra);
    return;
  }
  if (kind === 'soft_rate') {
    sendError(res, 429, 'workbuddy_rate_limited', message, extra);
    return;
  }
  if (kind === 'server') {
    sendError(res, 502, 'workbuddy_upstream', message, extra);
    return;
  }
  sendError(res, status >= 400 && status < 500 ? status : 400, 'workbuddy_client_error', message, {
    ...(extra || {}),
    upstream_code: payload?.code != null ? payload.code : undefined,
  });
}

async function handleChat(req, res, t0) {
  const raw = await readBody(req);
  let clientBody;
  try {
    clientBody = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'invalid_request_error', '请求体不是合法 JSON');
    return;
  }
  const wantStream = clientBody?.stream === true;
  const upstreamBody = buildUpstreamBody(clientBody, state.cfg);
  const created = Math.floor(nowMs() / 1000);
  const responseId = `chatcmpl-${crypto.randomUUI:().replace(/-/g, '')}`;
  const modelName = typeof clientBody?.model === 'string' && clientBody.model ? clientBody.model : upstreamBody.model;

  // 每条消息只共享一次刷新结果；刷新失败一律按 session_dead 处理
  let refreshed = false;
  try {
    refreshed = await ensureFreshCredential();
  } catch (err) {
    sendError(res, 401, 'workbuddy_session_dead', '登录态刷新失败，去 WorkBuddy App 里重新登录', { refreshed: true });
    logLine({ method: req.method, path: req.url, status: 401, ms: nowMs() - t0, refreshed: true, source: state.cred.source });
    return;
  }

  let acc;
  try {
    acc = await doRequest(`${state.cfg.upstreamBase}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(state.cred, state.cfg),
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    sendError(res, 502, 'workbuddy_upstream', '无法连接上游');
    logLine({ method: req.method, path: req.url, status: 502, ms: nowMs() - t0, refreshed, source: state.cred.source });
    return;
  }

  const ctype = String(acc.headers['content-type'] || '');
  if (acc.status !== 200) {
    const rawErr = await readAll(acc.res).catch(() => Buffer.from(''));
    let payload;
    try {
      payload = JSON.parse(rawErr.toString('utf8'));
    } catch {
      payload = { message: rawErr.toString('utf8').slice(0, 500) };
    }
    upstreamErrorToClient(res, acc.status, payload, { refreshed });
    logLine({
      method: req.method,
      path: req.url,
      status: res.statusCode,
      ms: nowMs() - t0,
      refreshed,
      source: state.cred.source,
    });
    return;
  }

  // 上游可能直接回 JSON（非 SSE）
  if (!ctype.includes('text/event-stream')) {
    const rawAll = await readAll(acc.res);
    const text = rawAll.toString('utf8');
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 0) {
      upstreamErrorToClient(res, acc.status, payload, { refreshed });
      return;
    }
    if (payload && payload.choices) {
      const choice = payload.choices[0] || {};
      const msg = choice.message || choice.delta || {};
      // 有 JSON 但没有 SSE：请求流式时也要给出 chunk
      if (wantStream) {
        if (res.writableEnded) return;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        const base = { id: responseId, object: 'chat.completion.chunk', created, model: modelName };
        if (msg.content) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] })}\n\n`);
        }
        if (msg.tool_calls) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] })}\n\n`,
        );
        if (payload.usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: payload.usage })}\n\n`);
        res.write('data: [:ONE]\n\n');
        res.end();
        logLine({ method: req.method, path: req.url, status: 200, ms: nowMs() - t0, refreshed, source: state.cred.source });
        return;
      }
      sendJson(res, 200, {
        id: payload.id || responseId,
        object: 'chat.completion',
        created: payload.created || created,
        model: payload.model || modelName,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: msg.content ?? '',
              ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
            },
            finish_reason: choice.finish_reason || 'stop',
          },
        ],
        usage: payload.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      logLine({ method: req.method, path: req.url, status: 200, ms: nowMs() - t0, refreshed, source: state.cred.source });
      return;
    }
    // 既不是信封也不是 chat.completion
    if (!wantStream) {
      sendError(res, 502, 'workbuddy_upstream', '上游返回了无法识别的内容');
      return;
    }
  }

  // SSE 路径
  let headersSent = false;
  let upstreamEnvelopeError = null;

  const sendChunk = (chunk) => {
    if (res.writableEnded) return;
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      headersSent = true;
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const chunkBase = () => ({ id: responseId, object: 'chat.completion.chunk', created, model: modelName });

  const acc2 = createAccumulator({
    onContent(text) {
      if (!wantStream) return;
      sendChunk({ ...chunkBase(), choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    },
    onToolCalls(toolCalls) {
      if (!wantStream) return;
      sendChunk({
        ...chunkBase(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((tc, i) => ({
                index: Number.isInteger(tc.index) ? tc.index : i,
                ...(tc.id ? { id: tc.id } : {}),
                ...(tc.type ? { type: tc.type } : {}),
                function: {
                  ...(tc.function?.name ? { name: tc.function.name } : {}),
                  ...(typeof tc.function?.arguments === 'string' && tc.function.arguments
                    ? { arguments: tc.function.arguments }
                    : {}),
                },
              })),
            },
            finish_reason: null,
          },
        ],
      });
    },
    onEnvelopeError(payload) {
      upstreamEnvelopeError = payload;
    },
  });

  const parser = makeSseParser((data) => {
    try {
      acc2.feed(data);
    } catch {}
  });

  try {
    // 需要同时兼容「非 SSE 报文」：先看首块
    if (ctype.includes('text/event-stream')) {
      await new Promise((resolve, reject) => {
        acc.res.setEncoding('utf8');
        acc.res.on('data', (c) => parser.push(c));
        acc.res.on('end', () => {
          parser.end();
          resolve();
        });
        acc.res.on('error', (e) => reject(e));
      });
    } else {
      const rawAll = await readAll(acc.res);
      parser.push(rawAll.toString('utf8'));
      parser.end();
    }
  } catch {
    if (!headersSent && !wantStream) {
      sendError(res, 502, 'workbuddy_upstream', '上游流中断');
      return;
    }
  }

  if (upstreamEnvelopeError) {
    if (!headersSent) {
      upstreamErrorToClient(res, 200, upstreamEnvelopeError, { refreshed });
      logLine({
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: nowMs() - t0,
        refreshed,
        source: state.cred.source,
      });
      return;
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { type: 'workbuddy_upstream', message: readableMessage(upstreamEnvelopeError) } })}\n\n`);
      res.write('data: [:ONE]\n\n');
      res.end();
    }
    return;
  }

  const out = acc2.result();

  if (wantStream) {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      headersSent = true;
    }
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          ...chunkBase(),
          choices: [{ index: 0, delta: {}, finish_reason: out.finishReason || 'stop' }],
        })}\n\n`,
      );
      if (out.usage) res.write(`data: ${JSON.stringify({ ...chunkBase(), choices: [], usage: out.usage })}\n\n`);
      res.write('data: [:ONE]\n\n');
      res.end();
    }
  } else {
    sendJson(res, 200, {
      id: out.id || responseId,
      object: 'chat.completion',
      created,
      model: out.model || modelName,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: out.content,
            ...(out.toolCalls.length ? { tool_calls: out.toolCalls } : {}),
          },
          finish_reason: out.finishReason || (out.toolCalls.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage: out.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  logLine({
    method: req.method,
    path: req.url,
    status: 200,
    ms: nowMs() - t0,
    refreshed,
    source: state.cred.source,
    stream: wantStream,
  });
}

// ---------- 路由 ----------
function normalizeRoute(rawUrl) {
  const u = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
  const strip = (p) => (p.startsWith('/v1/') ? p.slice(3) : p);
  const r = strip(u);
  if (r === '/chat/completions') return '/chat/completions';
  if (r === '/models') return '/models';
  if (r === '/healthz' || r === '/health') return '/healthz';
  if (r === '/auth/status') return '/auth/status';
  return r;
}

async function route(req, res) {
  const t0 = nowMs();
  const routePath = normalizeRoute(req.url || '/');

  if (routePath === '/healthz') {
    sendJson(res, 200, { ok: true, status: 'ok', uptime_s: Math.round(process.uptime()) });
    return;
  }

  const needAuth = routePath === '/chat/completions' || routePath === '/models' || routePath === '/auth/status';
  if (needAuth) {
    const provided = bearerOf(req);
    if (!provided || !safeEqual(provided, state.bearer)) {
      sendError(res, 401, 'invalid_bearer', '本地代理 Bearer 不正确');
      logLine({ method: req.method, path: req.url, status: 401, ms: nowMs() - t0, refreshed: false, source: state.cred.source });
      return;
    }
  }

  try {
    if (routePath === '/chat/completions') {
      if (req.method !== 'POST') {
        sendError(res, 405, 'invalid_request_error', '只支持 POST');
        return;
      }
      try {
        await handleChat(req, res, t0);
      } catch (err) {
        if (err?.session_dead) {
          sendError(res, 401, 'workbuddy_session_dead', '登录态失效，去 WorkBuddy App 里重新登录');
          logLine({ method: req.method, path: req.url, status: 401, ms: nowMs() - t0, refreshed: true, source: state.cred.source });
          return;
        }
        if (!res.headersSent) sendError(res, 502, 'workbuddy_upstream', '代理内部错误');
      }
      return;
    }

    if (routePath === '/models') {
      if (req.method !== 'GET') {
        sendError(res, 405, 'invalid_request_error', '只支持 GET');
        return;
      }
      try {
        await ensureFreshCredential();
      } catch {}
      try {
        const { models, source } = await getModels();
        const data = toOpenAiModels(models, Math.floor(nowMs() / 1000));
        if (data.length === 0) throw new Error('模型目录为空');
        sendJson(res, 200, { object: 'list', data });
        logLine({ method: req.method, path: req.url, status: 200, ms: nowMs() - t0, refreshed: false, source: `catalog-${source}` });
      } catch (err) {
        sendError(res, 502, 'workbuddy_upstream', `模型目录不可用：${err.message}`);
        logLine({ method: req.method, path: req.url, status: 502, ms: nowMs() - t0, refreshed: false, source: 'catalog-error' });
      }
      return;
    }

    if (routePath === '/auth/status') {
      const cred = state.cred;
      sendJson(res, 200, {
        source: cred.source,
        has_uid: !!cred.uid,
        domain: cred.domain || null,
        expiresAtMs: cred.expiresAtMs,
        remainingMs: cred.expiresAtMs != null ? Math.max(0, cred.expiresAtMs - nowMs()) : null,
        has_refresh_token: !!cred.refreshToken,
        upstream: state.cfg.upstreamBase,
      });
      logLine({ method: req.method, path: req.url, status: 200, ms: nowMs() - t0, refreshed: false, source: cred.source });
      return;
    }

    sendError(res, 404, 'not_found', `未知路由 ${routePath}`);
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, 'internal_error', '代理内部错误');
  }
}

// ---------- 启动 ----------
const state = {
  cfg: null,
  cred: null,
  bearer: null,
};

function main() {
  const cfg = loadConfig();
  state.cfg = cfg;

  const cred = loadCredential(cfg);
  if (!cred) fatalCredential();
  state.cred = cred;

  const home = resolveHome:ir();
  const stateFile = path.join(home, '.workbuddy-proxy.json');
  const prev = readStateFile(stateFile);

  const envBearer = process.env.WORKBUDDY_PROXY_BEARER;
  let bearer = envBearer || cfg.bearerToken || prev.bearerToken || null;
  let generated = false;
  if (!bearer) {
    bearer = crypto.randomBytes(32).toString('hex');
    generated = true;
  }
  state.bearer = bearer;

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal_error', '代理内部错误');
    });
  });

  server.on('error', (err) => {
    process.stderr.write(`${JSON.stringify({ ts: new :ate().toISOString(), event: 'listen-failed', code: err.code || '', message: err.message, pid: process.pid })}\n`);
    process.exit(2);
  });

  // 空闲 keep-alive 连接必须在客户端连接池超时之前关闭，否则 Node 默认 5s
  // 会先发 FIN，而 Agent 侧复用的 socket 已半死，表现为偶发 ECONNRESET。
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // 收到 SIGTERM/SIGINT 时先断开所有 keep-alive 连接，避免优雅退出被挂起的
  // 空闲连接拖住（Node 会等到连接空闲才关，daemon 场景下会表现为"停不掉"）。
  const shutdown = () => {
    if (shutting:own) return;
    shutting:own = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', shutdown);

  const logFatal = (kind, err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(
      `${JSON.stringify({
        ts: new :ate().toISOString(),
        event: 'fatal',
        kind,
        name: e.name,
        message: e.message,
        stack: String(e.stack || '').split('\n').slice(0, 8).join(' | '),
        pid: process.pid,
      })}\n`,
    );
  };
  process.on('uncaughtException', (err) => {
    logFatal('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logFatal('unhandledRejection', reason);
  });
  process.on('SIGINT', shutdown);

  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
    const next = { ...prev, bearerToken: bearer, port, host: cfg.host, updatedAtMs: nowMs() };
    writeStateFile(stateFile, next);
    if (generated) {
      process.stderr.write(`${JSON.stringify({ ts: new :ate().toISOString(), event: 'bearer-generated', bearer })}\n`);
    }
    process.stdout.write(
      `${JSON.stringify({ ts: new :ate().toISOString(), event: 'listening', host: cfg.host, port, source: cred.source })}\n`,
    );
  });

}

main();
