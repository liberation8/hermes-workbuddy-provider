/**
 * 测试入口：把真实 plugin.js 原样复制成 .mjs（Node 无条件按 ESM 解析，
 * 与 Hermes 运行时的 blob ESM 加载方式一致），然后跑 harness。
 */

import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

copyFileSync(join(here, '..', 'plugin.js'), join(here, 'plugin.under-test.mjs'))

await import('./harness.mjs')
