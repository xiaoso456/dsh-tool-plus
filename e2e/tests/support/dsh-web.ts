/**
 * 这个应用特有的管道：把测试带进「能输入」的状态，以及从**假供应商侧**读证据。
 *
 * 单独放，不塞进用例正文：这类管道不该交给模型，也不该在每条用例里抄一遍。
 *
 * @module e2e/tests/support/dsh-web
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type App, type Screen } from 'e2e'
import type { Browser } from '@e2e-dev/web'
import { waitForAppEndpoint } from '../../support/app-endpoint.mjs'

/** 本插件承诺挂进会话的工具名（`ast_*` 默认关闭，由测试 profile 的补丁层显式打开）。 */
export const PLUGIN_TOOLS = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ast_grep', 'ast_edit']

/** 假供应商服务端记录的一条请求。 */
export interface MockRequestRow {
  readonly seq: number
  readonly body: unknown
  readonly turn?: string
}

/**
 * 打开被测应用。
 *
 * 地址带着**进程级随机**的启动令牌，dsh 用它换一枚签名 cookie——这是「注入令牌」而不是
 * 「填凭据表单」：没有密钥被填进任何输入框，所以框架不会因此扣留截图与模型视觉输入。
 *
 * @returns `{ url, mockUrl }`：`url` 是带令牌的地址，`mockUrl` 是假供应商的 OpenAI 兼容根。
 */
export async function openApp(app: App): Promise<{ url: string; mockUrl: string; scratch: string }> {
  if (app.baseUrl === undefined) throw new Error('target 没有声明 app.url，取不到端口')
  const endpoint = await waitForAppEndpoint(app.baseUrl)
  await app.open(endpoint.url)
  return { url: endpoint.url, mockUrl: endpoint.mockUrl, scratch: String(endpoint.scratch ?? '') }
}

/**
 * 一条用例的开场：打开应用 → 关欢迎层（含兜底）→ 确保会话挂的是本插件的预设 → 交出三样端点。
 *
 * 每条用例都走这里，各写一遍迟早会漏掉某一步（漏掉预设那一步就会静默跑成宿主的工具）。
 */
export async function openReady(
  app: App,
  screen: Screen,
  browser: Browser,
): Promise<{ url: string; mockUrl: string; scratch: string }> {
  const endpoints = await openApp(app)
  await dismissPreviewNotice(screen)
  await ensureComposerUsable(browser, screen)
  await selectPreset(screen)
  return endpoints
}

/**
 * 「预览版说明」浮层的兜底。
 *
 * 启动接线已经在测试 profile 里预置了确认状态，正常情况下它**不会**出现；这里只给它
 * 一秒：宿主哪天改了公告版本号，确认状态就对不上、浮层又回来了，此时关掉它，而不是让
 * 后面点发送键时以「element is not enabled」超时告终。
 *
 * 早先这里等 15 秒。那个浮层每个浏览器上下文只在首条用例里出现，后面的用例纯白等。
 */
export async function dismissPreviewNotice(screen: Screen): Promise<void> {
  const cont = screen.getByRole('button', '继续')
  const appeared = await cont.first()
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true, () => false)
  if (!appeared) return
  await cont.first().tap()
  await expect(cont.first()).toBeHidden({ timeout: 10_000 })
}

/**
 * 在作曲区发一条消息。
 *
 * 选择器认的是占位文案里那段**不变**的后缀「/ 调用指令」：空会话时它前面是「描述你想要构建的内容」，
 * 会话一有消息就换成「发消息或创建任务」——拿前半段当锚，第二条消息起就找不到了。
 * 侧栏的会话搜索框不含这段字，不会撞。
 *
 * `fill` 不敲键盘：宿主不靠按键事件做事，敲一遍只会让用例慢。
 */
export async function sendPrompt(screen: Screen, text: string): Promise<void> {
  await screen.getByRole('textbox', /调用指令/).fill(text)
  await screen.getByRole('button', '发送消息').tap()
}

/**
 * 开一个新会话。
 *
 * 用例里只要不止发一轮，就得先换会话：转录是**只有当前会话才渲染**的，同一个会话里跑两遍
 * 剧本，屏幕上会出现两个一样的收尾文本，后面 `getByText` 就撞成 `LOCATOR_AMBIGUOUS`。
 * 侧栏顶部有两个叫「新建会话」的按钮（工具栏一个、空态一个），取第一个。
 */
export async function newSession(screen: Screen): Promise<void> {
  await screen.getByRole('button', '新建会话').first().tap()
  await expect(screen.getByRole('button', '发送消息')).toBeDisabled()
}

/**
 * 打开设置面板。它盖住作曲区——改完设置必须先关掉，否则点发送会打在遮罩上。
 *
 * 设置入口不是一颗固定的按钮：宿主把 `settings.launcher` 槽位交给账号菜单
 * （`dsh-client-ui-settings-account` 的 `AccountMenu`，trigger 的 aria-label 是「账号菜单」，
 * 界面上就是侧栏底部那颗「更多」），「设置」是这张菜单里的一项；只有槽位空着时，
 * 宿主才回退渲染名为「设置」的按钮（`dsh-client-ui-settings-general/lib/client.js` 里
 * `renderSlot("settings.launcher", …, { fallback })` 的那条路）。所以这里走用户真走的那条：
 * 先开菜单，再点菜单项。
 */
export async function openSettings(screen: Screen): Promise<void> {
  await screen.getByRole('button', '账号菜单').tap()
  await screen.getByRole('menuitem', '设置').tap()
  await expect(screen.getByRole('button', '关闭')).toBeVisible()
}

/** 关掉设置面板，并等它真的消失。 */
export async function closeSettings(screen: Screen): Promise<void> {
  await screen.getByRole('button', '关闭').tap()
  await expect(screen.getByRole('button', '关闭')).toBeHidden()
}

/** 主题三档：界面上的按钮文案 ↔ `<html data-ds-theme-source>` 的取值。 */
export const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' } as const

/** 主题来源的三档取值。 */
export type ThemeSource = keyof typeof THEME_LABELS

/**
 * 切主题，并等 `<html data-ds-theme-source>` 真的变成目标值再返回。
 *
 * 宿主把当前主题落在这个属性上，是页面上**可断言**的那道痕迹（配色本身没法断）。
 * 不等它变就返回的话，后面的截图可能拍到上一套配色。
 * 面板得开着（调用方负责开）。
 */
export async function setTheme(screen: Screen, browser: Browser, source: ThemeSource): Promise<void> {
  await screen.getByRole('button', THEME_LABELS[source]).tap()
  await expect(browser.locator('html')).toHaveAttribute('data-ds-theme-source', source)
}

/** 读当前主题来源（还原用）。 */
export async function currentTheme(browser: Browser): Promise<ThemeSource> {
  const value = await browser.locator('html').getAttribute('data-ds-theme-source')
  return value === 'dark' || value === 'light' ? value : 'system'
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part === 'object' && part !== null && 'text' in part) return String((part as { text?: unknown }).text ?? '')
      return ''
    })
    .join('\n')
}

/** 一条请求里全部 user 消息的文本。 */
export function userTextOf(row: MockRequestRow): string {
  const messages = (row.body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((message) => (message as { role?: string }).role === 'user')
    .map((message) => partsText((message as { content?: unknown }).content))
    .join('\n')
}

/** 一条请求里会话暴露给模型的工具名。 */
export function toolNamesOf(row: MockRequestRow): string[] {
  const tools = (row.body as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) return []
  return tools
    .map((tool) => (tool as { function?: { name?: unknown } }).function?.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * 一条请求里**全部 tool 消息的文本**。
 *
 * 图像也走这里：OpenAI 兼容面的 `role: "tool"` 消息塞不进图片，宿主会把图像块渲染成
 * 一段信封文本（`<path>/<type>/<content>` 加附件引用与原始尺寸提示），所以断图像只能断文本。
 */
export function toolTextOf(row: MockRequestRow): string {
  const messages = (row.body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((message) => (message as { role?: string }).role === 'tool')
    .map((message) => partsText((message as { content?: unknown }).content))
    .join('\n')
}

/**
 * 轮询假供应商，等一条满足谓词的请求。
 *
 * 断言从**假供应商侧收到的请求记录**里取：那是宿主真实发出的东西，比解析界面或 stdout 可靠。
 * 用轮询而不是读一次——请求是宿主跑到那一步才出现的。
 */
export async function waitForModelRequest(
  mockUrl: string,
  predicate: (row: MockRequestRow) => boolean,
  timeoutMs = 60_000,
): Promise<MockRequestRow> {
  const base = mockUrl.replace(/\/v1$/u, '')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`${base}/__mock/requests`)
    const payload = (await response.json()) as { requests?: MockRequestRow[] }
    const hit = (payload.requests ?? []).find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等模型请求超时（${String(timeoutMs)}ms）：${base}/__mock/requests`)
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

/** 假供应商记录的全部请求，按 seq 升序。 */
export async function allModelRequests(mockUrl: string): Promise<MockRequestRow[]> {
  const base = mockUrl.replace(/\/v1$/u, '')
  const response = await fetch(`${base}/__mock/requests`)
  const payload = (await response.json()) as { requests?: MockRequestRow[] }
  return [...(payload.requests ?? [])].sort((left, right) => left.seq - right.seq)
}

/** 一条请求里**最后一个**工具结果——「这一步干了什么」在下一轮请求里就是它。 */
export function lastToolTextOf(row: MockRequestRow | undefined): string {
  const messages = (row?.body as { messages?: unknown } | undefined)?.messages
  if (!Array.isArray(messages)) return ''
  const tools = messages.filter((message) => (message as { role?: string }).role === 'tool')
  const last = tools.at(-1)
  return last === undefined ? '' : partsText((last as { content?: unknown }).content)
}

/**
 * 整轮剧本每一步的期望，抄自仓库自带的 headless 驱动（`tests/support/harness/dsh-e2e.ts::EXPECTATIONS`）。
 * 断的是**效果**（文件真被写了、真被改了），不是工具的措辞。第 N 步的工具结果在第 N+1 次请求里。
 */
export const TOOL_SCRIPT: ReadonlyArray<{ turn: string; tool: string; expect?: RegExp }> = [
  { turn: '01-bash', tool: 'bash', expect: /MOCK_E2E_BASH_OK/u },
  { turn: '02-write', tool: 'write' },
  { turn: '03-read', tool: 'read', expect: /GREETING/u },
  { turn: '04-edit', tool: 'edit' },
  { turn: '05-read-after-edit', tool: 'read', expect: /'HELLO'/u },
  { turn: '06-grep', tool: 'grep', expect: /GREETING/u },
  { turn: '07-glob', tool: 'glob', expect: /fixture\.ts/u },
  { turn: '08-ast-grep', tool: 'ast_grep', expect: /greet/u },
  { turn: '09-ast-edit', tool: 'ast_edit' },
  { turn: '10-read-after-ast-edit', tool: 'read', expect: /name \+ GREETING/u },
  { turn: '11-final', tool: '(final)' },
]

/**
 * 等整轮剧本跑完，然后**逐步**核：轮次名一一对上、每步工具结果里该出现的东西出现。
 *
 * 只断「收尾文本上屏」是不够的——中间某一步悄悄坏掉（写盘没落、报错被吞）时，收尾文本照样会出现。
 * 这层断言与 headless 驱动同源，也是新通道补齐后能独立发现回归的关键。
 */
export async function expectToolScript(mockUrl: string, nonce: string, timeoutMs = 180_000): Promise<void> {
  const mine = (rows: MockRequestRow[]): MockRequestRow[] => rows
    .filter((row) => row.turn !== undefined && row.turn !== '00-title' && row.turn !== 'unexpected-extra-request')
    .filter((row) => userTextOf(row).includes(nonce))
  const deadline = Date.now() + timeoutMs
  let rows = mine(await allModelRequests(mockUrl))
  while (rows.length < TOOL_SCRIPT.length && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 500) })
    rows = mine(await allModelRequests(mockUrl))
  }
  expect(rows.map((row) => row.turn)).toEqual(TOOL_SCRIPT.map((step) => step.turn))
  for (const [index, step] of TOOL_SCRIPT.entries()) {
    if (step.expect === undefined) continue
    // 断的是**整段**结果：grep 这类工具的首行是搜索根路径，命中内容在后面几行。
    const result = lastToolTextOf(rows[index + 1])
    const line = result.split('\n').find((candidate) => candidate.trim() !== '')?.slice(0, 200) ?? '(空)'
    expect(
      step.expect.test(result),
      `步骤 ${step.turn}（${step.tool}）的工具结果里没找到 ${String(step.expect)}；首个非空行：${line}`,
    ).toBe(true)
  }
}

/** 夹具最终态**从磁盘独立核验**：不信界面、也不信工具回执，直接读文件（headless 驱动同款）。 */
export function readFixture(scratch: string): string {
  return readFileSync(path.join(scratch, 'fixture.ts'), 'utf8')
}

/**
 * 页面自己抛的错必须为空。
 *
 * 框架**不提供** `page.on('pageerror')`（迁移文档把 console/pageerror 监听列为 missing），只把未捕获
 * 异常记进 appLog 与 trace 页、不据此判失败。所以由配置里的 `initScripts` 挂一对监听器，这里读回来。
 * 没有这条，新通道会把「界面报错但看起来跑完了」当成通过——老 GUI 驱动是靠 pageerror 直接判失败的。
 */
export async function expectNoPageErrors(browser: Browser): Promise<void> {
  const errors = await browser.evaluate('globalThis.__dshE2ePageErrors || []')
  expect(errors).toEqual([])
}

/** 本插件那个预设在界面上的名字。 */
export const TOOL_PLUS_PRESET = 'Tool Plus 标准增强版'

/** 浮层按钮的关键词：宿主改了公告版本号、浮层又回来时，靠这些字把它点掉。 */
const OVERLAY_HINTS = /开始|继续|知道了|跳过|关闭|完成|下一步|不再提示|同意|体验|Get started|Continue|Skip|Close|Done|Next|Got it/iu

/**
 * 作曲区中心点被谁接着——`null` 才说明没被遮罩吃掉。
 *
 * 判据是**指针事件命中**，不是「某个元素在不在」：浮层可能没盖住 DOM 却盖住了指针。
 */
async function composerBlockedBy(browser: Browser): Promise<string | null> {
  const hit = await browser.evaluate(() => {
    const box = document.querySelector('div[role="textbox"]')
    if (box === null) return 'no-composer'
    const rect = box.getBoundingClientRect()
    const node = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    if (node === null || box.contains(node)) return null
    return node.tagName + '.' + String(node.className).slice(0, 60)
  })
  return typeof hit === 'string' ? hit : null
}

/**
 * 欢迎层兜底。
 *
 * 启动接线已在测试 profile 里预置了确认状态，正常情况下浮层不出现、这里零成本返回；
 * 宿主哪天改公告版本号，就按「命中测试 → 点掉关键词按钮 → 最后摘掉 fixed 的 presentation 容器」
 * 硬打过去。这套招式抄自仓库自带的 GUI 驱动（`tests/support/harness/capture-web.ts`）。
 */
export async function ensureComposerUsable(browser: Browser, screen: Screen): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (await composerBlockedBy(browser) === null) return
    if (attempt >= 3) {
      await browser.evaluate(() => {
        let removed = 0
        for (const node of document.querySelectorAll('div[role="presentation"]')) {
          if (getComputedStyle(node).position === 'fixed') { node.remove(); removed += 1 }
        }
        return removed
      })
    }
    const labels = await screen.getByRole('button').allTextContents()
    const wanted = [...new Set(labels.map((text) => text.trim()).filter((text) => OVERLAY_HINTS.test(text)))]
    for (const label of wanted) {
      await screen.getByRole('button', label, { exact: true }).first().tap({ timeout: 3_000 }).catch(() => {})
    }
    await new Promise((resolve) => { setTimeout(resolve, 800) })
  }
  const blocked = await composerBlockedBy(browser)
  if (blocked !== null) throw new Error(`作曲区被 ${blocked} 挡住，浮层兜底没打过去`)
}

/**
 * 把会话显式切到本插件的预设。
 *
 * profile 里的 `selectedDefault` 只是**默认值**，GUI 会记住这个工作区上次用过的预设；不切的话，
 * 同一份剧本可能一会儿跑我们的工具、一会儿跑宿主的（老 GUI 驱动踩过这个坑）。已在目标预设上就返回。
 */
export async function selectPreset(screen: Screen, wanted = TOOL_PLUS_PRESET): Promise<void> {
  if (await screen.getByRole('button', wanted).count() > 0) return
  await screen.getByRole('button').filter({ hasText: '模式' }).first().tap()
  await screen.getByRole('menuitem').filter({ hasText: wanted }).first().tap({ timeout: 10_000 })
  await expect(screen.getByRole('button', wanted)).toBeVisible()
}

/**
 * 视口拉高再拍 —— 框架明确不做整页截图（`app.screenshot` 只有视口，`toHaveScreenshot({ fullPage })`
 * 是 `INVALID_ARGUMENT`），拉高视口是等价招。拍完恢复，免得影响后面的步。
 */
export async function screenshotTallPage(app: App, browser: Browser, label: string): Promise<void> {
  await browser.setViewport({ width: 1280, height: 4000 })
  await app.screenshot(label)
  await browser.setViewport({ width: 1280, height: 720 })
}

/** 切到宿主的「轨迹」页签再拍一张（老 GUI 驱动那三张截图里，有一张就是它）。用完不切回来。 */
export async function screenshotTraceTab(app: App, screen: Screen, label: string): Promise<void> {
  const tab = screen.getByRole('tab', '轨迹')
  if (await tab.count() === 0) return
  await tab.tap()
  await app.screenshot(label)
}
