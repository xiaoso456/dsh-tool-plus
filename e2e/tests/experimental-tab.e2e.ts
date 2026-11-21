/**
 * 设置页「实验性」tab：常驻显示，开关按各自默认值渲染。
 *
 * 用户定下的口径（2026-11-21）：这个 tab 一直显示，不受当前有没有开启的实验功能影响；
 * 实验开关默认关闭，例外是「详细匹配失败提示」只加报错信息、默认开启。这条用例走真实界面
 * 断这两件事，并留亮暗两套配色截图。
 *
 * 只断「在不在、默认值对不对」——功能本身的行为由 `tests/unit/edit-preflight.spec.ts` 与
 * `tests/unit/edit-match-error.spec.ts` 覆盖。
 *
 * @module e2e/tests/experimental-tab
 */

import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import {
  closeSettings,
  currentTheme,
  expectNoPageErrors,
  openReady,
  openSettings,
  setTheme,
} from './support/dsh-web'

/** 开关的无障碍名（`src/client/locales.ts` 的字段文案）。 */
const PREFLIGHT_TOGGLE = '多条目编辑预检'
const DETAILED_TOGGLE = '详细匹配失败提示'

test('设置页有常驻的「实验性」tab，开关按各自默认值渲染', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await openReady(app, screen, browser)

  /** 进来先记下当前配色，跑完还原，别给后面的用例留下一套不是它预期的主题。 */
  const initial = await currentTheme(browser)

  try {
    for (const theme of ['light', 'dark'] as const) {
      await openSettings(screen)
      await setTheme(screen, browser, theme)
      await screen.getByRole('button', { name: 'Tool Plus', exact: true }).tap()

      // 常驻：不管有没有开启的实验功能，这个页签都在。
      const tab = screen.getByRole('tab', { name: '实验性', exact: true })
      await expect(tab).toBeVisible()
      await tab.tap()

      // 默认值按设计：预检改行为，默认关；详细失败提示只加报错信息，默认开。
      const preflight = screen.getByRole('checkbox', PREFLIGHT_TOGGLE)
      await expect(preflight).toBeVisible()
      await expect(preflight).not.toBeChecked()

      const detailed = screen.getByRole('checkbox', DETAILED_TOGGLE)
      await expect(detailed).toBeVisible()
      await expect(detailed).toBeChecked()

      // 文件名用 ASCII：非 ASCII 标签会被产物命名规则折成一串下划线。
      await app.screenshot(`experimental-tab-${theme}`)
      await closeSettings(screen)
    }
  } finally {
    await openSettings(screen)
    await setTheme(screen, browser, initial)
    await closeSettings(screen)
  }

  await expectNoPageErrors(browser)
})
