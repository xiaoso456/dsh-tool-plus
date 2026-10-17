/**
 * 测试侧读「启动接线发布了什么」的唯一入口。
 *
 * 被测应用（dsh web）的地址带着一个**进程级随机**的启动令牌，配置期无从得知，
 * 所以由 `support/start-app.mjs` 起来之后写进运行时文件，测试从这里取。
 * 测试和启动接线各写一遍这个约定，迟早会漂移——所以两边都 import 这一个模块。
 *
 * @module e2e/support/app-endpoint
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 `start-app.mjs` 共用的运行时目录。 */
const RUNTIME_ROOT = path.join(os.tmpdir(), 'dsh-tool-plus-e2e')

/** 从 `app.baseUrl` 里取端口——文件名按端口区分，并行跑不会互相盖。 */
export function portOf(baseUrl) {
  const url = new URL(baseUrl)
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * 等启动接线把地址发布出来。就绪探针（401 也算就绪）可能略早于令牌行被解析到，所以这里要轮询而不是读一次。
 * @param baseUrl - `app.baseUrl`
 * @param timeoutMs - 等多久，超时抛错而不是把 undefined 交给调用方
 * @returns `{ url, port, mockUrl }`
 */
export async function waitForAppEndpoint(baseUrl, timeoutMs = 120_000) {
  const file = path.join(RUNTIME_ROOT, `app-endpoint-${portOf(baseUrl)}.txt`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof parsed.url === 'string' && parsed.url !== '') return parsed
    } catch {
      /* 还没写出来或者正在写；继续等 */
    }
    if (Date.now() > deadline) {
      throw new Error(`等启动接线发布地址超时（${String(timeoutMs)}ms）：${file}`)
    }
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}
