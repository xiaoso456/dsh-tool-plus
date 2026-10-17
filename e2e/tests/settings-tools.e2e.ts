/**
 * 插件自己的设置页：把「启用 ast_grep」关掉再保存，**会话工具面当轮就少掉它**；拨回去又回来。
 *
 * 断言落在假供应商真实收到的请求里的 `tools` 数组——那是宿主工具注册表在那一刻的投影。
 * 比看界面上的开关更硬：开关只是草稿（这个页面是暂存式的，改完必须点「保存」），工具面才是后果。
 *
 * 本用例刻意不用 `E2E-RUN` 当标记：场景里的主轮次按那个前缀匹配，换了标记就落到 fallback
 * （只回一句话、不跑工具），正好只花一轮往返当证据。
 *
 * @module e2e/tests/settings-tools
 */

import { test } from '@e2e-dev/web'
import { expect, type Screen } from 'e2e'
import { expectNoPageErrors, openReady, openSettings, sendPrompt, toolNamesOf, userTextOf, waitForModelRequest } from './support/dsh-web'

/** 开关的无障碍名（`src/client/locales.ts` 的 `astGrepEnabled`）。 */
const AST_GREP_TOGGLE = '启用 ast_grep'

/**
 * 走界面把 ast_grep 的开关拨到想要的状态。
 *
 * 每一步都取界面上真有的字：设置入口、导航项、页签、开关的无障碍名。不碰 CSS 类名——
 * 那是宿主的构建产物。
 */
async function setAstGrep(screen: Screen, on: boolean): Promise<void> {
  // 入口只有一条实现（support/dsh-web.ts 的 openSettings）：宿主的「设置」挂在账号菜单里，
  // 不是侧栏底部一颗叫「设置」的按钮。
  await openSettings(screen)
  await screen.getByRole('button', { name: 'Tool Plus', exact: true }).tap()
  await screen.getByRole('tab', { name: 'Ast Grep', exact: true }).tap()

  const toggle = screen.getByRole('checkbox', AST_GREP_TOGGLE)
  if (on) await toggle.check()
  else await toggle.uncheck()

  // 暂存式表单：改完必须保存。已经是目标状态时（例如上一轮崩溃留下的）按钮是禁用的，
  // 此时没有草稿可存，点了会白等到动作超时。
  const save = screen.getByRole('button', { name: '保存', exact: true })
  if (await save.isEnabled()) {
    await save.tap()
    // 保存落定＝草稿归零、按钮回到禁用。保存中标签会变成「保存中…」，那一刻按钮查不到，
    // 读失败会让 poll 继续轮询而不是判负。
    await expect.poll(() => save.isEnabled(), { timeout: 15_000, message: '「保存」没有落定' }).toBe(false)
  }

  const close = screen.getByRole('button', { name: '关闭', exact: true })
  await close.tap()
  await expect(close).toBeHidden({ timeout: 10_000 })
}

test('设置页关掉 ast_grep 会当轮改变会话工具面', async ({ app, screen, browser }) => {
  const { mockUrl } = await openReady(app, screen, browser)

  /** 发一句、拿这次请求里的工具名。标记每次唯一，免得被上一轮的对话文本蒙混过去。 */
  const ask = async (stage: string): Promise<string[]> => {
    const marker = `E2E-TOGGLE-${stage}-${String(Date.now())}`
    await sendPrompt(screen, marker)
    const row = await waitForModelRequest(mockUrl, (candidate) => userTextOf(candidate).includes(marker))
    return toolNamesOf(row)
  }

  // 起点：测试 profile 的补丁层把 astGrepEnabled 打开着。
  expect(await ask('before')).toContain('ast_grep')

  await setAstGrep(screen, false)
  try {
    expect(await ask('off')).not.toContain('ast_grep')
  } finally {
    // 拨回原状：这一步同时验另一个方向——启用后当轮又挂回来。保存落在测试 profile 的
    // `cordis.patch.yml`（宿主自己的写路径），而启动接线每轮都会重写那份文件，
    // 所以即便这里中途失败，也留不下跨轮的脏状态。
    await setAstGrep(screen, true)
  }

  expect(await ask('back')).toContain('ast_grep')
  await expectNoPageErrors(browser)
  await app.screenshot('restored')
})
