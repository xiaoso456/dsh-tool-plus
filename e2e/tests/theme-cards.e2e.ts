/**
 * 亮暗双主题的界面证据。
 *
 * 用户定的准则：任何界面改动都要同时兼容亮色与暗色。这条用例把它变成可复跑的东西——
 * 同一份剧本在两套配色下各跑一遍，各自留一张卡片截图；主题**真的切过去了**这件事由
 * 宿主落在 `<html data-ds-theme-source>` 上的标记来断，而不是靠人眼看图。
 *
 * 断不了「配色好不好看」：那是设计评审的事。这里能断的是**卡片在两套配色下都渲染出来**，
 * 且切主题这件事在界面上确实生效了。
 *
 * @module e2e/tests/theme-cards
 */

import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import {
  closeSettings,
  currentTheme,
  expectNoPageErrors,
  newSession,
  openReady,
  openSettings,
  screenshotTallPage,
  screenshotTraceTab,
  sendPrompt,
  setTheme,
} from './support/dsh-web'

test('插件的工具卡片在亮色与暗色下都渲染得出来', { tags: ['theme'] }, async ({ app, screen, browser }) => {
  await openReady(app, screen, browser)

  /** 进来先记下当时是哪一档：跑完要还原，别给后面的用例留下一套不是它预期的配色。 */
  const initial = await currentTheme(browser)

  try {
    for (const theme of ['dark', 'light'] as const) {
      // 换会话：转录只渲染当前会话，同一个会话里跑两遍剧本会出现两个收尾文本、把断言撞成歧义。
      await newSession(screen)
      await openSettings(screen)
      await setTheme(screen, browser, theme)
      await closeSettings(screen)

      const nonce = `E2E-RUN-THEME-${theme}-${String(Date.now())}`
      await sendPrompt(screen, `${nonce} 端到端验收：按剧本把 tool-plus 的工具依次跑一遍。这一段只为看卡片。`)

      // 剧本走完 = 卡片（bash / write / read / edit / grep / glob / AST 两件）都渲染过了。
      await expect(screen.getByText('MOCK_E2E_FINAL')).toBeVisible({ timeout: 120_000 })
      // 文件名用 ASCII：非 ASCII 标签会被产物命名规则折成一串下划线，图就没法按名字分辨了。
      // 拉高视口再拍：框架不做整页截图，长转录只能靠这一招看全。
      await screenshotTallPage(app, browser, theme === 'dark' ? 'cards-dark' : 'cards-light')
    }
  } finally {
    await openSettings(screen)
    await setTheme(screen, browser, initial)
    await closeSettings(screen)
  }

  await expectNoPageErrors(browser)
  // 轨迹页签放最后（切过去就停在那一页）：老 GUI 驱动那三张截图里有一张就是它。
  await screenshotTraceTab(app, screen, 'trace-tab')
})
