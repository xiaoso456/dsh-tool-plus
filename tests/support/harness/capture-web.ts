/**
 * 端到端驱动（GUI 截图版）：起一个**真的 web 实例**，用同一份场景让假供应商驱动宿主把插件
 * 8 个工具跑一遍，然后把「对话」与「轨迹」两处拍下来。
 *
 * 与 headless 版共用 `mock-openai/scenarios/tool-plus-all-tools.json`，所以截出来的图和断言的是同一件事。
 *
 * 用法：`pnpm e2e:web`（`E2E_WEB_PORT` 覆盖端口，默认 3087；`PW_ROOT` 覆盖 Playwright 全局根）。
 * 会新建 profile `$DSH_HOME/profiles/tool-plus-e2e-web`（不动任何既有 profile），跑完关掉实例。
 *
 * @module tests/support/harness
 */

import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Browser, Page } from 'playwright'
import { loadScenarioFile, startMockOpenAI } from '../mock-openai/index.ts'
import {
  killTree,
  mockProfilePatch,
  prepareProfile,
  REPO_ROOT,
  resetScratch,
  SCENARIO_PATH,
  SCENARIO_TOKENS,
  SCRATCH,
  startDshWeb,
  TASK_MARKER,
  TOOL_NAMES,
} from './support.ts'

const require = createRequire(import.meta.url)
const PROFILE = 'tool-plus-e2e-web'
// 默认让系统分配端口：写死端口会被上一轮没退干净的实例占住（EADDRINUSE 起不来）。
const PORT = Number(process.env.E2E_WEB_PORT ?? '0')
// 截图落在仓库的 docs/plan/upgrade-0.2.0/（docs 整体 gitignore：不进 git、不进 npm 包）。
const OUT_DIR = process.env.E2E_WEB_OUT ?? path.join(REPO_ROOT, 'docs', 'plan', 'upgrade-0.2.0')
const TOP_SHOT = path.join(OUT_DIR, 'e2e-web-tool-calls.png')
const BOTTOM_SHOT = path.join(OUT_DIR, 'e2e-web-tool-calls-result.png')
const TRACE_SHOT = path.join(OUT_DIR, 'e2e-web-tool-calls-trace.png')
const FINAL_MARKER = 'MOCK_E2E_FINAL'
const PROMPT = `${TASK_MARKER} 端到端验证：按剧本把 tool-plus 的工具依次跑一遍`
  + '（bash / write / read / edit / grep / glob / ast_grep / ast_edit），这是渲染验证，不要自由发挥。'

/** Playwright 是全局装的；按需解析它的根目录。 */
function loadChromium(): { launch: (options: Record<string, unknown>) => Promise<Browser> } {
  const root = process.env.PW_ROOT ?? execSync('npm root -g', { encoding: 'utf8' }).trim()
  return require(path.join(root, 'playwright')).chromium
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 作曲区中心点被谁接着——`null` 才说明没被遮罩吃掉。 */
function composerBlockedBy(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const box = document.querySelector('div[role="textbox"]')
    if (box === null) return 'no-composer'
    const rect = box.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    if (hit === null || box.contains(hit)) return null
    return `${hit.tagName}.${String(hit.className).slice(0, 60)}`
  })
}

/**
 * 新 profile 首次打开会弹欢迎层，遮罩会吃掉指针事件；它可能晚于首屏出现，所以反复检查并逐招关闭：
 * 点文案按钮 → 点遮罩本身 → 最后摘掉 fixed 的 presentation 容器。
 */
async function ensureComposerUsable(page: Page, log: (line: string) => void): Promise<boolean> {
  const pattern = /开始|继续|知道了|跳过|关闭|完成|下一步|不再提示|同意|体验|Get started|Continue|Skip|Close|Done|Next|Got it/i
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const blockedBy = await composerBlockedBy(page)
    if (blockedBy === null) {
      log(`作曲区可用（第 ${String(attempt)} 次检查）`)
      return true
    }
    log(`第 ${String(attempt)} 次：作曲区被 ${blockedBy} 挡住`)
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role="button"],a')]
        .filter((node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
        .map((node) => (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 40))
        .filter((text) => text !== ''))
    if (attempt === 1) log(`可见按钮 = ${JSON.stringify([...new Set(labels)].slice(0, 40))}`)
    for (const label of [...new Set(labels.filter((text) => pattern.test(text)))]) {
      await page.getByRole('button', { name: label, exact: true }).first()
        .click({ timeout: 4_000, force: true }).catch(() => {})
      await sleepMs(600)
    }
    await page.evaluate(() => {
      document.querySelector('[class*="_mask_"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }).catch(() => {})
    await sleepMs(900)
    if (attempt >= 4) {
      const removed = await page.evaluate(() => {
        let count = 0
        for (const node of document.querySelectorAll('div[role="presentation"]')) {
          if (getComputedStyle(node).position === 'fixed') { node.remove(); count += 1 }
        }
        return count
      })
      log(`移除了 ${String(removed)} 个 fixed 浮层容器`)
    }
  }
  return (await composerBlockedBy(page)) === null
}

/**
 * 把作曲区的预设显式切到本插件的那个。profile 里的 `selectedDefault` 只是默认值，GUI 会记住这个
 * 工作区上次用过的预设——不显式切，同一条命令会一会儿跑我们的工具、一会儿跑宿主的。
 */
async function selectPreset(page: Page, log: (line: string) => void, wanted = /Tool Plus 标准增强版/u): Promise<boolean> {
  const trigger = page.getByRole('button').filter({ hasText: /标准模式|增强版|PTC 模式/u }).first()
  if ((await trigger.count()) === 0) {
    log('没找到预设选择器')
    return false
  }
  const read = async (): Promise<string> => (await trigger.innerText()).trim().replace(/\s+/g, ' ')
  const current = await read()
  log(`当前预设 = ${JSON.stringify(current)}`)
  if (wanted.test(current)) return true
  await trigger.click({ force: true, timeout: 10_000 }).catch(() => {})
  await sleepMs(1_200)
  const item = page.getByRole('menuitem').filter({ hasText: wanted }).first()
  if ((await item.count()) === 0) {
    const labels = await page.getByRole('menuitem').allInnerTexts().catch(() => [])
    log(`没找到目标预设；菜单项 = ${JSON.stringify(labels.slice(0, 20))}`)
    await page.keyboard.press('Escape').catch(() => {})
    return false
  }
  await item.click({ force: true, timeout: 10_000 }).catch(() => {})
  await sleepMs(1_500)
  const after = await read()
  log(`切换后预设 = ${JSON.stringify(after)}`)
  return wanted.test(after)
}

/** 等这一轮跑完：假供应商的收尾文本里带着标记，出现即代表场景走完了。 */
async function settle(page: Page, log: (line: string) => void): Promise<boolean> {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await sleepMs(2_000)
    const seen = await page.evaluate((marker) => document.body.innerText.includes(marker), FINAL_MARKER)
    const running = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => /停止|取消生成|Stop/u.test(b.getAttribute('aria-label') ?? '')))
    log(`settle: final=${String(seen)} running=${String(running)}`)
    if (seen && !running) return true
  }
  return false
}

async function main(): Promise<void> {
  resetScratch()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const chromium = loadChromium()
  const scenario = loadScenarioFile(SCENARIO_PATH, { tokens: SCENARIO_TOKENS })
  const mock = await startMockOpenAI({ scenario, log: (line) => { process.stdout.write(`[e2e:web] ${line}\n`) } })
  const profileDir = prepareProfile(
    PROFILE,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xiaoso/dsh-tool-plus'],
    mockProfilePatch(mock.url, { withPreset: true, transcriptView: 'verbose' }),
  )
  process.stdout.write(`[e2e:web] mock ${mock.url}\n[e2e:web] profile ${profileDir}\n[e2e:web] scratch ${SCRATCH}\n`)

  const web = await startDshWeb(PROFILE, PORT)
  process.stdout.write(`[e2e:web] web ${web.url.replace(/token=[^&]+/u, 'token=***')}\n`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const failures: string[] = []
  const log = (line: string): void => { process.stdout.write(`[e2e:web] ${line}\n`) }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error: Error) => failures.push(`pageerror: ${String(error).slice(0, 300)}`))

    await page.goto(web.url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await sleepMs(9_000)

    if (!(await ensureComposerUsable(page, log))) failures.push('欢迎层没关掉，作曲区指针事件被吃')
    if (!(await selectPreset(page, log))) failures.push('没能把会话切到 Tool Plus 标准增强版预设')

    // 用 fill + Enter 而非 click + 点发送按钮：两者都不做命中测试，遮罩残留也能把消息发出去。
    const box = page.locator('div[role="textbox"]').first()
    await box.fill(PROMPT, { timeout: 30_000 })
    await sleepMs(800)
    log(`composer chars = ${String((await box.innerText()).length)}`)
    await box.press('Enter')
    await sleepMs(3_000)
    if ((await box.innerText().catch(() => '?')).trim().length > 20) {
      await page.locator('button[aria-label="发送消息"]').click({ timeout: 20_000, force: true }).catch(() => {})
    }
    log('sent')

    if (!(await settle(page, log))) failures.push('这一轮 300s 内没有落定')

    // 真正算数的是**会话暴露给模型的工具名**——它就在假供应商收到的请求里。
    const first = mock.requests.find((row) => row.turn?.startsWith('01-') === true) ?? mock.requests[0]
    const sessionTools = ((first?.body as { tools?: Array<{ function?: { name?: string } }> })?.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === 'string')
    log(`会话暴露的工具 = ${JSON.stringify(sessionTools)}`)
    const missing = TOOL_NAMES.filter((name) => !sessionTools.includes(name))
    if (missing.length > 0) failures.push(`会话里没有这些工具：${missing.join(', ')}`)
    if (sessionTools.includes('pwsh')) failures.push('会话里仍挂着宿主自己的 pwsh（本插件应把它关掉）')

    const labels = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('[data-tool]')].map((node) => node.getAttribute('data-tool')))])
    log(`界面可见工具行 = ${JSON.stringify(labels)}`)

    // 工具调用默认折在「用时 N 秒」这层里；点它右侧的箭头摊开（摊不开也不影响其余证据）。
    const header = page.getByText(/用时\s*\d|Worked/u).first()
    const headerBox = await header.boundingBox().catch(() => null)
    if (headerBox !== null) {
      await page.mouse.click(headerBox.x + headerBox.width + 10, headerBox.y + headerBox.height / 2)
      await sleepMs(1_500)
    }

    const scrollTranscript = (toTop: boolean): Promise<number> => page.evaluate((top) => {
      const scrollers = [...document.querySelectorAll('*')]
        .filter((node) => node.scrollHeight > node.clientHeight + 80 && node.clientHeight > 400)
      for (const node of scrollers) node.scrollTop = top ? 0 : node.scrollHeight
      return scrollers.length
    }, toTop)
    log(`滚动容器数 = ${String(await scrollTranscript(true))}`)
    await sleepMs(1_500)
    await page.screenshot({ path: TOP_SHOT, fullPage: true })
    log(`screenshot(顶) -> ${TOP_SHOT}`)
    await scrollTranscript(false)
    await sleepMs(1_500)
    await page.screenshot({ path: BOTTOM_SHOT, fullPage: true })
    log(`screenshot(底) -> ${BOTTOM_SHOT}`)

    const traceTab = page.locator('[role="tab"],button').filter({ hasText: /^轨迹$|^Trajectory$/u }).first()
    if ((await traceTab.count()) > 0) {
      await traceTab.click({ force: true, timeout: 10_000 }).catch(() => {})
      await sleepMs(2_000)
      await page.screenshot({ path: TRACE_SHOT, fullPage: true })
      log(`screenshot(轨迹) -> ${TRACE_SHOT}`)
    } else {
      log('没找到「轨迹」页签')
    }
  } finally {
    await browser.close()
    killTree(web.child)
    await mock.close()
  }

  if (failures.length > 0) {
    process.stdout.write(`\n[e2e:web] 未通过：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`\n[e2e:web] OK：截图写到 ${OUT_DIR}\n`)
}

await main()
