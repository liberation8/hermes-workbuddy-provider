/**
 * plugin.js 桩测试 —— 用本地 stub 顶替 @hermes/plugin-sdk 与 react/jsx-runtime，
 * 验证真实 plugin.js 的注册形状与渲染行为。
 *
 *   node test/run.mjs            # 跑全部断言
 *   node test/run.mjs --dump     # 附带打印渲染出的元素树
 *
 * 裸说明符由 Node 自己解析：test/node_modules/{@hermes/plugin-sdk,react} 是桩，
 * 被测文件是 ../plugin.js 的原样拷贝（一字未改）。
 */

import assert from 'node:assert/strict'

import { StatusDot, Tip } from '@hermes/plugin-sdk'
import { createRoot } from 'react'
import { jsx } from 'react/jsx-runtime'

import plugin from './plugin.under-test.mjs'

const DUMP = process.argv.includes('--dump')

let pass = 0

function check(name, fn) {
  fn()
  pass += 1
  console.log('PASS  ' + name)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function withTimeout(promise, label) {
  let timer = null

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout: ' + label)), 2000)
    })
  ]).finally(() => clearTimeout(timer))
}

const isElement = value => Boolean(value) && typeof value === 'object' && 'props' in value

/** 深度遍历元素树，函数组件就地展开（受控递归，不依赖 React 调度器）。 */
function walk(node, depth = 0) {
  if (Array.isArray(node)) {
    return node.flatMap(child => walk(child, depth))
  }

  if (!isElement(node)) {
    return []
  }

  if (typeof node.type === 'function') {
    return [{ depth, node }, ...walk(node.type(node.props), depth + 1)]
  }

  return [{ depth, node }, ...walk(node.props.children, depth + 1)]
}

const flatten = node => walk(node).map(entry => entry.node)
const findAll = (tree, type) => flatten(tree).filter(node => node.type === type)
const findOne = (tree, type) => findAll(tree, type)[0]
const buttonOf = tree => findOne(tree, 'button')

function textOf(tree) {
  return flatten(tree)
    .map(node => node.props.children)
    .filter(child => typeof child === 'string')
    .join('|')
}

function stubStatus(overrides = {}) {
  return {
    error: null,
    logPath: 'C:/logs/workbuddy-proxy.log',
    nodePath: 'C:/Program Files/nodejs/node.exe',
    ok: true,
    pid: 4321,
    port: 8787,
    proxyScript: 'C:/plugins/workbuddy-switch/proxy.mjs',
    running: true,
    uptimeS: 3725,
    ...overrides
  }
}

/** 按路径返回预置响应的 ctx.rest 桩，并记录每一次调用。 */
function stubRest(routes) {
  const rest = (path, opts) => {
    rest.calls.push({ opts, path })
    const handler = routes[path]

    if (!handler) {
      return Promise.reject(new Error('unexpected rest path ' + path))
    }

    return handler(opts)
  }

  rest.calls = []

  return rest
}

const mount = (element, rest) => {
  const instance = createRoot(jsx(element.type, { ...element.props, rest }))
  return withTimeout(tick(), 'mount status').then(() => {
    instance.rerender()
    return instance
  })
}

// ---------------------------------------------------------------------------
// 1. 默认导出形状
// ---------------------------------------------------------------------------

check('默认导出是 HermesPlugin（id / name / register）', () => {
  assert.equal(plugin.id, 'workbuddy-switch')
  assert.equal(plugin.name, 'WorkBuddy 反代开关')
  assert.equal(typeof plugin.register, 'function')
})

// ---------------------------------------------------------------------------
// 2. register(ctx) 只登记一条 statusBar.right 贡献
// ---------------------------------------------------------------------------

const registered = []
plugin.register({
  register: c => {
    registered.push(c)
    return () => undefined
  },
  rest: () => Promise.reject(new Error('rest 不应在 register 阶段被调用'))
})

check('register(ctx) 向 ctx.register 传入且仅传入一条贡献', () => {
  assert.equal(registered.length, 1)
})

check("area === 'statusBar.right'", () => {
  assert.equal(registered[0].area, 'statusBar.right')
})

check('贡献形状完整（id / order / render）', () => {
  assert.equal(registered[0].id, 'toggle')
  assert.equal(typeof registered[0].order, 'number')
  assert.equal(typeof registered[0].render, 'function')
})

// ---------------------------------------------------------------------------
// 3. render() 同步返回元素、不抛异常
// ---------------------------------------------------------------------------

const element = registered[0].render()

check('render() 返回元素对象且不抛异常', () => {
  assert.ok(isElement(element), 'render() 未返回元素对象')
  assert.equal(typeof element.type, 'function')
})

// ---------------------------------------------------------------------------
// 4. 挂载：立刻取一次 /status，并挂上 10s 轮询
// ---------------------------------------------------------------------------

const realSetInterval = globalThis.setInterval
const intervals = []

globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms })
  // 真实 id 但永不触发 —— 轮询节奏由测试手动驱动；
  // unref 让这个占位 timer 不把 Node 的事件循环钉住（否则脚本跑完不退出）。
  const id = realSetInterval(() => undefined, 2 ** 30)
  id.unref?.()
  return id
}

const rest = stubRest({
  '/status': () => Promise.resolve(stubStatus()),
  '/toggle': () => Promise.resolve(stubStatus({ pid: null, running: false, uptimeS: null }))
})

const running = await mount(element, rest)

check('挂载后立刻调用一次 ctx.rest(/status)', () => {
  assert.deepEqual(
    rest.calls.map(c => c.path),
    ['/status']
  )
})

check('挂载后注册 10s 轮询', () => {
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 10000)
})

check('运行中显示「反代 开」+ 绿点', () => {
  assert.match(textOf(running.output), /反代 开/)

  const dot = findOne(running.output, StatusDot)
  assert.ok(dot, '没有 StatusDot')
  assert.equal(dot.props.tone, 'good')
})

check('Tip 里给出 运行中 / pid / 端口 / uptime', () => {
  const tip = findOne(running.output, Tip)
  assert.ok(tip, '没有 Tip 包裹')
  assert.match(tip.props.label, /运行中/)
  assert.match(tip.props.label, /pid 4321/)
  assert.match(tip.props.label, /端口 8787/)
  assert.match(tip.props.label, /已运行 1 小时 2 分/)
})

check('按钮 chrome 类名与状态栏一致、且初始可用', () => {
  const button = buttonOf(running.output)
  assert.ok(button, '没有 button')
  assert.match(button.props.className, /inline-flex h-full items-center gap-1/)
  assert.match(button.props.className, /px-1\.5 text-\[0\.6875rem\]/)
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.disabled, false)
})

// ---------------------------------------------------------------------------
// 5. 点击：POST /toggle，期间 loading 且不重复触发，完成后刷新状态
// ---------------------------------------------------------------------------

let resolveToggle = null
const pendingToggle = new Promise(resolve => {
  resolveToggle = resolve
})

const togglingRest = stubRest({
  '/status': () => Promise.resolve(stubStatus()),
  '/toggle': () => pendingToggle
})

const switching = await mount(element, togglingRest)

buttonOf(switching.output).props.onClick()
switching.rerender()

check('点击后立即以 POST 调用 /toggle', () => {
  const call = togglingRest.calls.find(c => c.path === '/toggle')
  assert.ok(call, '没有调用 /toggle')
  assert.equal(call.opts.method, 'POST')
})

check('调用期间按钮 disabled（loading）', () => {
  assert.equal(buttonOf(switching.output).props.disabled, true)
})

check('调用期间重复点击不再发 /toggle（同步闸门）', () => {
  buttonOf(switching.output).props.onClick()
  buttonOf(switching.output).props.onClick()
  assert.equal(togglingRest.calls.filter(c => c.path === '/toggle').length, 1)
})

resolveToggle(stubStatus({ pid: null, running: false, uptimeS: null }))
await withTimeout(tick(), 'toggle settle')
switching.rerender()

check('完成后按 /toggle 返回刷新为「反代 关」', () => {
  assert.match(textOf(switching.output), /反代 关/)
  assert.equal(findOne(switching.output, StatusDot).props.tone, 'muted')
  assert.match(findOne(switching.output, Tip).props.label, /已停止/)
  assert.equal(buttonOf(switching.output).props.disabled, false)
})

// ---------------------------------------------------------------------------
// 6. 失败态：红点 + Tip 带 error 文本
// ---------------------------------------------------------------------------

const failingRest = stubRest({
  '/status': () => Promise.resolve(stubStatus()),
  '/toggle': () => Promise.reject(new Error('proxy spawn failed: EADDRINUSE'))
})

const failing = await mount(element, failingRest)

buttonOf(failing.output).props.onClick()
await withTimeout(tick(), 'failure settle')
failing.rerender()

check('失败后 Tip 显示 error 文本、按钮恢复可用', () => {
  const tip = findOne(failing.output, Tip)
  assert.match(tip.props.label, /出错/)
  assert.match(tip.props.label, /EADDRINUSE/)
  assert.equal(buttonOf(failing.output).props.disabled, false)
})

check('失败后状态点转红（tone bad）', () => {
  assert.equal(findOne(failing.output, StatusDot).props.tone, 'bad')
})

// ---------------------------------------------------------------------------
// 7. 卸载清理 interval
// ---------------------------------------------------------------------------

check('卸载时 clearInterval 被调用一次（10s 轮询已清理）', () => {
  const cleared = []
  const realClear = globalThis.clearInterval

  globalThis.clearInterval = id => {
    cleared.push(id)
    realClear(id)
  }

  try {
    running.unmount()
  } finally {
    globalThis.clearInterval = realClear
  }

  assert.equal(cleared.length, 1)
})

// ---------------------------------------------------------------------------

if (DUMP) {
  console.log('\n--- 运行中渲染树 ---')
  console.log(
    JSON.stringify(running.output, (key, value) => (typeof value === 'function' ? '[fn ' + value.name + ']' : value), 2)
  )
}

console.log('\n' + pass + ' checks passed')
