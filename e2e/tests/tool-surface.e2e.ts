/**
 * 验收这条通道还活着的那一条用例：**这个插件装上去之后，会话里的工具面到底长什么样**。
 *
 * 断言全部落在两边的一手事实上：
 * - 界面侧：预设是本插件那个、模型接的是测试 profile 里的假供应商、收尾文本落到屏幕上；
 * - 假供应商侧：它真实收到的请求里，会话暴露的工具名有哪些。
 *
 * 第一条刻意不用 `agent.*`：装配面这件事不需要模型会思考，没有密钥也该验得动。
 * 第二条才是「框架的模型能不能把这个应用驱动起来」——那才需要 `agents.default`。
 *
 * @module e2e/tests/tool-surface
 */

import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import {
  PLUGIN_TOOLS,
  expectNoPageErrors,
  expectToolScript,
  openReady,
  readFixture,
  screenshotTallPage,
  sendPrompt,
  toolNamesOf,
  userTextOf,
  waitForModelRequest,
} from './support/dsh-web'

/** 宿主自己的 pwsh 必须被本插件关掉，否则会话里会同时挂着两套 shell 工具。 */
const HOST_TOOLS_MUST_BE_ABSENT = ['pwsh']

test('会话工具面是本插件的，整轮剧本能在真宿主里跑完', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  /**
   * 每轮一个唯一串：它既让假供应商按「会话首条消息」分到新桶，也让界面断言不可能被上一轮
   * 残留的对话文本蒙混过关。前缀 `E2E-RUN` 是场景里主轮次的匹配条件。
   */
  const nonce = `E2E-RUN-${String(Date.now())}`

  const { mockUrl, scratch } = await openReady(app, screen, browser)

  /** 一进来先截一张：认证要是把截图搞污了，这一步就该暴露，而不是等后面某条用例才发现。 */
  await app.screenshot('first-screen')

  // 装配生效的两个直观证据：预设切到了本插件那个，会话背后的模型是测试 profile 里的假供应商。
  await expect(screen.getByRole('button', 'Tool Plus 标准增强版')).toBeVisible()
  await expect(screen.getByRole('button').filter({ hasText: 'mock-model' })).toBeVisible()

  await sendPrompt(
    screen,
    `${nonce} 端到端验收：按剧本把 tool-plus 的工具依次跑一遍，这是渲染验证，不要自由发挥。`,
  )

  const first = await waitForModelRequest(mockUrl, (row) => userTextOf(row).includes(nonce))
  const tools = toolNamesOf(first)
  expect(PLUGIN_TOOLS.filter((name) => !tools.includes(name))).toEqual([])
  expect(tools.filter((name) => HOST_TOOLS_MUST_BE_ABSENT.includes(name))).toEqual([])

  // 脚本最后一轮的收尾文本落到界面上：证明 8 个工具真的在宿主里执行过、结果也回了模型。
  await expect(screen.getByText('MOCK_E2E_FINAL')).toBeVisible({ timeout: 120_000 })

  /**
   * 收尾文本只说明剧本走完了。再往下一层，三样独立证据：
   * ①逐步核——轮次名一一对上、每步工具结果里该出现的东西出现（抄自 headless 驱动的那张表）；
   * ②磁盘核验——不信界面也不信工具回执，直接读夹具文件；
   * ③页面没抛错——框架不提供 pageerror 监听，靠配置里的 initScripts 收，这里读回来。
   */
  await expectToolScript(mockUrl, nonce)
  const fixture = readFixture(scratch)
  expect(fixture).toContain("'HELLO'")
  expect(fixture).toContain('name + GREETING')
  await expectNoPageErrors(browser)

  /**
   * 再往下一层：**插件接管的卡片**得把结果真的画出来——
   * 这几条断的是我们自己的渲染层（`src/web/**` 的 card-takeover），不是宿主的行为。
   * 用 `first()`：转录里的节点切分归宿主，同一个字出现两次不算错，但「一个都找不到」必须红。
   */
  for (const label of ['编辑', '读取', 'Grep', 'Glob', 'AST Grep', 'AST Edit']) {
    await expect(screen.getByText(label).first()).toBeVisible()
  }
  // 编辑卡片上的 +N -M 是插件自己算出来的卡片 meta：算错、或没画出来，这里就红。
  await expect(screen.getByText(/\+\d+ -\d+/).first()).toBeVisible()

  await screenshotTallPage(app, browser, 'script-done')
})

test('agent 能自己把消息打进去并发出', { tags: ['agent'] }, async ({ app, screen, agent, browser }) => {
  const nonce = `E2E-RUN-AGENT-${String(Date.now())}`
  const { mockUrl } = await openReady(app, screen, browser)

  /** 一句话一个目标，措辞用界面上真有的字：作曲区的占位文案与发送键的无障碍名。 */
  await agent.act(
    '在底部那个提示「描述你想要构建的内容」的输入框里输入 {prompt}，然后点「发送消息」把它发出去',
    { params: { prompt: `${nonce} 端到端验收：这一条由 agent 步骤驱动。` } },
  )

  // agent 说做完了不算数——宿主要真的把这条消息发给了模型，证据在假供应商那一侧。
  const row = await waitForModelRequest(mockUrl, (candidate) => userTextOf(candidate).includes(nonce))
  expect(toolNamesOf(row).length).toBeGreaterThan(0)
  await expectNoPageErrors(browser)
  await app.screenshot('agent-sent')
})
