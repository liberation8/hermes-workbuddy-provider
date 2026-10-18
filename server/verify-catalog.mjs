import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const PROXY = path.join(__dirname, 'workbuddy-proxy.mjs');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbcat-'));
const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch {}
  }
}

// 可切换模式的假上游：normal / empty / broken / flaky
function startMock(modeRef) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/v3/config')) {
        const mode = modeRef.value;
        if (mode === 'broken') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { note: 'no models field' } }));
          return;
        }
        if (mode === 'empty') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { models: [], agents: [] } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            models: [
              { id: 'm-a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 100 },
              { id: 'm-b', name: 'B', maxInputTokens: 2000, maxOutputTokens: 200 },
            ],
            agents: [{ name: 'cli', models: ['m-a', 'm-b'] }],
          },
        }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function startProxy(upstreamPort, catalogPath) {
  const port = 20000 + crypto.randomInt(20000);
  const cfgPath = path.join(TMP, `cfg-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    port,
    bearerToken: 'test-bearer',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    catalogPath,
  }), 'utf8');
  const child = spawn(NODE, [PROXY], {
    env: {
      ...process.env,
      WORKBUDDY_PROXY_CONFIG: cfgPath,
      WORKBUDDY_PROXY_TOKEN: 'tok',
      NO_PROXY: '127.0.0.1,localhost',
      // 隔离状态文件：不隔离会把生产环境的 bearer 覆盖成测试值
      DSH_HOME: path.join(TMP, 'home-' + port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (out.includes('"event":"listening"')) break;
  }
  return { port, child, getOut: () => out };
}

async function getModels(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { Authorization: 'Bearer test-bearer' },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function main() {
  const modeRef = { value: 'normal' };
  const mock = await startMock(modeRef);
  const upstreamPort = mock.address().port;
  const catalogPath = path.join(TMP, 'catalog.json');

  // ---- 用例 1：正常路径 ----
  {
    const { port } = await startProxy(upstreamPort, catalogPath);
    const r = await getModels(port);
    record('正常路径返回 2 个模型', r.status === 200 && r.json?.data?.length === 2, `status=${r.status} body=${r.text.slice(0, 200)}`);
  }

  // ---- 用例 2：缓存里 models 为空数组 → 必须重新拉上游，不能回 200 空列表 ----
  {
    const uid = 'tok';
    // 写一个「有条目但 models 空」的缓存，并让 fetchedAtMs 是新鲜的（最恶劣情况）
    fs.writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      entries: {
        ':': { account: '', source: 'workbuddy-ai:app', fetchedAtMs: Date.now(), appVersion: '5.5.2', models: [] },
      },
    }), 'utf8');
    const { port } = await startProxy(upstreamPort, catalogPath);
    const r = await getModels(port);
    record('空缓存不被当成有效缓存（仍返回真实模型）', r.status === 200 && r.json?.data?.length === 2, `status=${r.status} body=${r.text.slice(0, 200)}`);
  }

  // ---- 用例 3：上游返回缺 models 字段 → 不得回 200 空列表 ----
  {
    modeRef.value = 'broken';
    const emptyCatalog = path.join(TMP, 'catalog-none.json');
    const { port } = await startProxy(upstreamPort, emptyCatalog);
    const r = await getModels(port);
    const empty200 = r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length === 0;
    record('上游字段缺失时不以 200+空列表糊弄客户端', !empty200, `status=${r.status} body=${r.text.slice(0, 200)}`);
    modeRef.value = 'normal';
  }

  // ---- 用例 4：上游返回空目录，但本地有旧缓存 → 回退旧缓存 ----
  {
    const staleCatalog = path.join(TMP, 'catalog-stale.json');
    fs.writeFileSync(staleCatalog, JSON.stringify({
      version: 1,
      entries: {
        ':': { account: '', source: 'workbuddy-ai:app', fetchedAtMs: Date.now() - 7 * 3600 * 1000, appVersion: '5.5.2', models: [{ id: 'stale-1', name: 'S', maxInputTokens: 10, maxOutputTokens: 1 }] },
      },
    }), 'utf8');
    modeRef.value = 'empty';
    const { port } = await startProxy(upstreamPort, staleCatalog);
    const r = await getModels(port);
    record('上游空目录时回退旧缓存', r.status === 200 && r.json?.data?.[0]?.id === 'stale-1', `status=${r.status} body=${r.text.slice(0, 200)}`);
    modeRef.value = 'normal';
  }
}

let exitCode = 1;
try {
  await main();
} catch (e) {
  record('测试流程异常', false, e?.message || String(e));
} finally {
  killAll();
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(`\nPASS ${pass}/${results.length}  FAIL ${fail}\n`);
  for (const r of results.filter((x) => !x.ok)) process.stdout.write(`  - ${r.name} → ${r.detail}\n`);
  exitCode = fail === 0 ? 0 : 1;
  process.stdout.write(`退出码 ${exitCode}\n`);
  process.exit(exitCode);
}
