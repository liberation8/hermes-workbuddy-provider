/**
 * WorkBuddy 反代开关 —— 状态栏右侧常驻的启停按钮。
 *
 * 运行时插件：纯 ESM js，jsx()/jsxs() 调用，不含 JSX 语法。
 * 只允许从 @hermes/plugin-sdk 与 react* 裸导入 —— 加载器
 * apps/desktop/src/contrib/runtime-loader.ts:55 rewriteSpecifiers() 只重写这两类
 * 说明符，其它裸导入会在 unsupportedImports() 处直接失败。
 *
 * 后端由同一插件的 plugin_api.py 提供，经 ctx.rest 访问，路径相对
 * /api/plugins/workbuddy-switch（contrib/plugin.ts:51、hermes.ts:293）。
 */

import { cn, StatusDot, Tip } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

/** 慢轮询：状态栏控件不该有存在感（与 gateway-pill 同频）。 */
const POLL_MS = 10_000

/** statusbar-controls.tsx:23 的同一串 chrome class，让插件按钮长得像核心项。 */
const CHIP_CLASS =
  'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground disabled:cursor-default disabled:opacity-45'

const messageOf = error => (error instanceof Error ? error.message : String(error))

/** 秒 -> 中文时长。未知值给 null，绝不让 tip 里出现 "null"。 */
function formatUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }

  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`
  }

  if (minutes > 0) {
    return `${minutes} 分 ${rest} 秒`
  }

  return `${rest} 秒`
}

/** 圆点配色：运行中绿、停止灰、出错红（StatusTone 见 components/status-dot.tsx:6）。 */
function toneOf(status, error) {
  if (error) {
    return 'bad'
  }

  if (!status) {
    return 'muted'
  }

  if (status.running === true) {
    return 'good'
  }

  return status.error ? 'bad' : 'muted'
}

/** Tip 文案：单行，' · ' 分隔 —— tooltip 的装饰 span 只适合纯文本行。 */
function buildTip(status, busy, error) {
  const parts = []

  if (error) {
    parts.push(`反代开关出错：${error}`)
  } else if (!status) {
    parts.push('反代状态：读取中…')
  } else {
    parts.push(status.running ? '反代：运行中' : '反代：已停止')

    if (status.running && typeof status.pid === 'number') {
      parts.push(`pid ${status.pid}`)
    }

    if (typeof status.port === 'number') {
      parts.push(`端口 ${status.port}`)
    }

    const uptime = status.running ? formatUptime(status.uptimeS) : null

    if (uptime) {
      parts.push(`已运行 ${uptime}`)
    }

    if (!status.running && status.error) {
      parts.push(status.error)
    }
  }

  if (busy) {
    parts.push('切换中…')
  } else if (!error) {
    parts.push('点击切换')
  }

  return parts.join(' · ')
}

function WorkBuddySwitch({ rest }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // 同步闸门：disabled 要等下一次渲染才生效，连点仍会打两次 /toggle。
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false

    const load = () => {
      rest('/status')
        .then(next => {
          if (cancelled) {
            return
          }

          setStatus(next)
          setError(null)
        })
        .catch(err => {
          if (!cancelled) {
            setError(messageOf(err))
          }
        })
    }

    load()
    const timer = setInterval(load, POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [rest])

  const toggle = () => {
    if (inFlight.current) {
      return
    }

    inFlight.current = true
    setBusy(true)
    setError(null)

    const settle = () => {
      inFlight.current = false
      setBusy(false)
    }

    rest('/toggle', { method: 'POST' })
      .then(next => {
        setStatus(next)
        settle()
      })
      .catch(err => {
        setError(messageOf(err))
        settle()
      })
  }

  const running = status ? status.running === true : false
  const tip = buildTip(status, busy, error)

  return jsx(Tip, {
    label: tip,
    children: jsxs('button', {
      'aria-label': tip,
      className: cn(CHIP_CLASS),
      disabled: busy,
      onClick: toggle,
      type: 'button',
      children: [
        jsx(StatusDot, { tone: toneOf(status, error) }),
        jsx('span', { children: running ? '反代 开' : '反代 关' })
      ]
    })
  })
}

const plugin = {
  id: 'workbuddy-switch',
  name: 'WorkBuddy 反代开关',
  register(ctx) {
    ctx.register({
      id: 'toggle',
      area: 'statusBar.right',
      order: 95,
      // rest 直接传 ctx 上的那个箭头函数：身份稳定，effect 依赖 [rest] 才不会每渲染重订阅。
      render: () => jsx(WorkBuddySwitch, { rest: ctx.rest })
    })
  }
}

export default plugin
