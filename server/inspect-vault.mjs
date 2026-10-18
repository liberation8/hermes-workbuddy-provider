#!/usr/bin/env node
// 只读诊断：报告每个凭证来源是否存在、是什么形态、能否解出 accessToken。
// 绝不打印 token 全文（只给长度、前 4 位、剩余有效期）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const JSON_MODE = process.argv.includes('--json');
const ENC_MARKER = '$wbEncrypted';

function descriptorOf(value) {
  if (typeof value === 'string') return { kind: 'plaintext' };
  if (value && typeof value === 'object' && Number(value[ENC_MARKER]) === 1) {
    let suite = null;
    let keyId = null;
    try {
      const inner = JSON.parse(Buffer.from(String(value.envelope || ''), 'base64').toString('utf8'));
      suite = inner.suite ?? null;
      keyId = inner.keyId ?? null;
    } catch {}
    return { kind: 'encrypted-envelope-version', suite, keyId };
  }
  if (value == null) return { kind: 'absent' };
  return { kind: 'unrecognized' };
}

// ---------- 与 provider 完全一致的 AAD 与解密 ----------
const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');
const u32beLen = (s) => {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return [h, b];
};
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
function buildAad(keyId, suite) {
  const parts = [AAD_PREFIX, Buffer.from([1])];
  for (const k of ['WBEV1', 'sym-v1']) parts.push(...u32beLen(k));
  parts.push(u32be(suite));
  parts.push(...u32beLen(keyId));
  parts.push(Buffer.from([2]), Buffer.from([0]), Buffer.from([0]));
  return Buffer.concat(parts);
}

function b64Exact(str, bytes) {
  if (typeof str !== 'string' || !str) return null;
  let buf;
  try {
    buf = Buffer.from(str, 'base64');
  } catch {
    return null;
  }
  if (buf.length !== bytes) return null;
  const norm = (s) => s.replace(/=+$/, '');
  return norm(buf.toString('base64')) === norm(str) ? buf : null;
}

function findWorkBuddyExe() {
  const out = [];
  const blocked = [];
  const push = (p) => p && !out.includes(p) && out.push(p);
  // 显式覆盖优先：沙箱/非标准安装位置下 reg.exe 探测可能不可用，
  // 用户可直接指定可执行文件，跳过全部注册表与静态候选探测。
  const explicit = process.env.WORKBUDDY_EXE;
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.R_OK);
      return { exe: explicit, checked: [explicit], blocked, explicit: true };
    } catch {
      return { exe: null, checked: [explicit], blocked, explicit: true, explicitUnreadable: true };
    }
  }
  // reg.exe 在受限沙箱下会 spawnSync EPERM。此时"没找到"是探测失败而非不存在，
  // 必须单独记下来，否则会把"查不了"误报成"没装"。
  const regQuery = (args) => {
    try {
      return execFileSync('reg.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) blocked.push(err.code);
      return null;
    }
  };
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const keys = [];
  for (const root of roots) {
    const listing = regQuery(['query', root]);
    if (!listing) continue;
    for (const line of listing.split(/\r?\n/)) {
      const m = line.match(/^\s*(HKEY_[A-Z_]+\\[^\s].*)$/);
      if (m && !keys.includes(m[1])) keys.push(m[1]);
    }
  }
  for (const key of keys) {
    const dn = regQuery(['query', key, '/v', 'DisplayName']);
    if (!dn || !/workbuddy/i.test(dn)) continue;
    for (const field of ['DisplayIcon', 'InstallLocation']) {
      const v = regQuery(['query', key, '/v', field]);
      if (!v) continue;
      const m = v.match(new RegExp(`${field}\\s+REG_[A-Z_]+\\s+(.+)$`, 'm'));
      if (!m) continue;
      const val = m[1].trim().replace(/^"|"$/g, '');
      if (field === 'DisplayIcon') push(val.split(',')[0]);
      else for (const n of ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'WorkBuddy AI.exe']) push(path.join(val, n));
    }
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  push(path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
  push(path.join(local, 'Programs', 'WorkBuddy AI', 'WorkBuddy AI.exe'));
  for (const p of out) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return { exe: p, checked: out, blocked };
    } catch {}
  }
  return { exe: null, checked: out, blocked: [...new Set(blocked)] };
}

function getProtectorKey() {
  const found = findWorkBuddyExe();
  if (!found.exe) {
    if (found.explicit) {
      return { error: `WORKBUDDY_EXE 指向的文件不可读：${found.checked[0]}` };
    }
    return {
      error: found.checked.length
        ? found.blocked.length
          ? `无法探测 WorkBuddy 可执行文件：reg.exe 被沙箱拒绝（${found.blocked.join('/')}），` +
            `已排除 ${found.checked.length} 个静态候选。请换到可访问注册表的环境重跑，或设 WORKBUDDY_EXE 直接指定可执行文件。`
          : `找不到/不可读的 WorkBuddy 可执行文件（已探测 ${found.checked.length} 个候选）`
        : '找不到 Electron 可执行文件',
    };
  }
  const script =
    'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
  let stdout;
  try {
    stdout = execFileSync(found.exe, ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return { error: `Electron 进程执行失败（exit ${typeof err?.status === 'number' ? err.status : -1}）`, exe: found.exe };
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { error: 'binding 输出不是 JSON 对象', exe: found.exe };
  }
  if (!payload || typeof payload !== 'object') return { error: 'binding 不为对象', exe: found.exe };
  if (payload.version !== 1) return { error: 'payload 校验失败：version 不是 1', exe: found.exe };
  const raw = payload.atRestSecretKey;
  const decoded = b64Exact(raw, 32);
  if (!decoded) return { error: 'payload 校验失败：atRestSecretKey 不是规范 32 字节 base64', exe: found.exe };
  if (decoded.every((b) => b === 0)) return { error: 'payload 校验失败：atRestSecretKey 全零', exe: found.exe };
  return {
    key: crypto.createHash('sha256').update(raw, 'utf8').digest(),
    exe: found.exe,
  };
}

function decryptEnvelope(value) {
  let inner;
  try {
    inner = JSON.parse(Buffer.from(String(value.envelope || ''), 'base64').toString('utf8'));
  } catch {
    return { error: '信封 base64 无法解析为 JSON' };
  }
  if (!inner || inner.suite !== 1) return { error: '不认识的格式：suite 不是 1' };
  const keyId = inner.keyId;
  if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId)) return { error: '不认识的格式：keyId 不匹配 /^[0-9a-f]{16}$/' };
  const nonce = b64Exact(inner.nonce, 12);
  const authTag = b64Exact(inner.authTag, 16);
  if (!nonce || !authTag) return { error: `不认识的格式：nonce/authTag 尺寸不对（keyId=${keyId}）` };
  const ciphertext = Buffer.from(String(inner.ciphertext || ''), 'base64');
  if (ciphertext.length === 0) return { error: '不认识的格式：ciphertext 为空' };

  const pk = getProtectorKey();
  if (!pk.key) return { error: pk.error, exe: pk.exe, stage: 'protectorKey', keyId };

  try {
    const d = crypto.createDecipheriv('aes-256-gcm', pk.key, nonce, { authTagLength: 16 });
    d.setAAD(buildAad(keyId, 1));
    d.setAuthTag(authTag);
    const plain = Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
    return { plain, exe: pk.exe, keyId };
  } catch {
    return {
      error: `AES-GCM 认证失败（不是这个格式或密钥不对；keyId=${keyId}, ciphertext ${ciphertext.length} 字节）`,
      stage: 'aes-gcm',
      keyId,
      exe: pk.exe,
    };
  }
}

function extractToken(value) {
  if (typeof value === 'string') return { token: value, decrypted: false };
  const r = decryptEnvelope(value);
  if (r.error) return r;
  let token = r.plain;
  try {
    const j = JSON.parse(r.plain);
    if (typeof j === 'string') token = j;
    else if (j && typeof j === 'object') token = j.accessToken || j.token || r.plain;
  } catch {}
  if (typeof token !== 'string' || !token) return { error: '信封明文里没有 token' };
  return { token, decrypted: true, keyId: r.keyId };
}

function normalizeExpiry(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 0xe8d4a51000 ? Math.round(n) : Math.round(n * 1000);
}

function summarize(value, expiresAtMs) {
  const d = descriptorOf(value);
  const out = { ...d, ...(path.basename ? {} : {}) };
  if (d.kind !== 'plaintext' && d.kind !== 'encrypted-envelope-version') return out;
  const t = extractToken(value);
  if (t.error) {
    out.decrypt = { ok: false, reason: t.error, stage: t.stage || null };
    return out;
  }
  out.decrypt = {
    ok: true,
    // 只给长度与前 4 位，绝不打印全文
    tokenLength: t.token.length,
    tokenPrefix4: t.token.slice(0, 4),
    envelopeDecrypted: !!t.decrypted,
  };
  if (expiresAtMs != null) {
    const remainMin = Math.round((expiresAtMs - Date.now()) / 60000);
    out.expiresInMinutes = remainMin;
  }
  return out;
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

function collect() {
  const sources = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const rel = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info');

  // 1) env token
  const envToken = process.env.WORKBUDDY_PROXY_TOKEN;
  sources.push({
    name: 'env-token',
    priority: 1,
    path: 'WORKBUDDY_PROXY_TOKEN',
    present: !!envToken,
    ...(envToken
      ? {
          kind: 'plaintext',
          decrypt: { ok: true, tokenLength: envToken.length, tokenPrefix4: envToken.slice(0, 4), envelopeDecrypted: false },
        }
      : { kind: 'absent' }),
  });

  // 2) 插件自有副本
  const own = 'D:\\dsh\\.workbuddy-auth.json';
  const ownRead = readJson(own);
  sources.push({
    name: 'own-copy',
    priority: 2,
    path: own,
    present: ownRead.ok,
    ...(ownRead.ok
      ? ownRead.value?.version !== 1
        ? { kind: 'unrecognized', note: 'version 不是 1' }
        : summarize(ownRead.value?.credential?.accessToken, ownRead.value?.credential?.expiresAtMs)
      : { kind: 'absent', note: ownRead.error }),
  });

  // 3) WORKBUDDY_AUTH_FILE
  const envFile = process.env.WORKBUDDY_AUTH_FILE;
  if (envFile) {
    const r = readJson(envFile);
    sources.push({
      name: 'env-auth-file',
      priority: 3,
      path: envFile,
      present: r.ok,
      ...(r.ok
        ? summarize(r.value?.credential?.accessToken ?? r.value?.auth?.accessToken, normalizeExpiry(r.value?.auth?.expiresAt ?? r.value?.credential?.expiresAtMs))
        : { kind: 'absent', note: r.error }),
    });
  } else {
    sources.push({ name: 'env-auth-file', priority: 3, path: 'WORKBUDDY_AUTH_FILE', present: false, kind: 'absent' });
  }

  // 4) 桌面 App
  for (const [idx, file] of [path.join(local, rel), path.join(roaming, rel)].entries()) {
    const r = readJson(file);
    sources.push({
      name: `desktop-app-${idx === 0 ? 'local' : 'roaming'}`,
      priority: 4,
      path: file,
      present: r.ok,
      ...(r.ok
        ? {
            ...summarize(r.value?.auth?.accessToken, normalizeExpiry(r.value?.auth?.expiresAt)),
            hasRefreshToken: !!r.value?.auth?.refreshToken,
            hasUid: !!r.value?.account?.uid,
            domain: r.value?.auth?.domain || null,
          }
        : { kind: 'absent', note: r.error }),
    });
  }

  return sources;
}

function line(s) {
  return s;
}

function main() {
  const sources = collect();
  const active = sources.find((s) => s.present && (s.kind === 'plaintext' || s.kind === 'encrypted-envelope-version'));

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ active: active?.name || null, sources }, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(line('WorkBuddy 凭证来源诊断（只读，不打印 token 全文）\n'));
  for (const s of sources) {
    const head = `[${s.present ? '存在' : '缺失'}] #${s.priority} ${s.name}  ${s.path}`;
    process.stdout.write(`${head}\n`);
    process.stdout.write(`    分类：${s.kind}${s.note ? `（${s.note}）` : ''}\n`);
    if (s.suite != null) process.stdout.write(`    信封 suite=${s.suite} keyId=${s.keyId ?? 'n/a'}\n`);
    if (s.decrypt) {
      if (s.decrypt.ok) {
        process.stdout.write(
          `    解出成功：长度 ${s.decrypt.tokenLength}，前缀前 4 位 "${s.decrypt.tokenPrefix4}"，` +
            `信封解密=${s.decrypt.envelopeDecrypted ? '是' : '否（明文）'}` +
            `${s.expiresInMinutes != null ? `，剩余 ${s.expiresInMinutes} 分钟` : ''}\n`,
        );
      } else {
        process.stdout.write(`    解出失败：${s.decrypt.reason}${s.decrypt.stage ? `（阶段 ${s.decrypt.stage}）` : ''}\n`);
      }
    }
    if (s.hasRefreshToken != null) process.stdout.write(`    refreshToken：${s.hasRefreshToken ? '有' : '无'}；uid：${s.hasUid ? '有' : '无'}；domain：${s.domain ?? 'n/a'}\n`);
  }
  process.stdout.write(`\n生效来源：${active ? active.name : '无（代理会以退出码 2 结束）'}\n`);

  if (!active) {
    process.stdout.write('提示：请先在 WorkBuddy App 里登录，或设置 WORKBUDDY_PROXY_TOKEN / WORKBUDDY_AUTH_FILE。\n');
  }
  process.exit(0);
}

main();
