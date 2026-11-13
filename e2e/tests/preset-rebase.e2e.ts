/**
 * 「跟随官方」真界面验收：在隔离的 Web 实例里走真按钮，断言结论来自宿主真实的官方声明。
 *
 * 钉住：点按钮 → 确认 → 结果文案必须是"已按当前官方预设重新派生"或"已经与当前官方预设一致"之一，
 * 绝不能是"官方 ... is not declared"这类失败——那说明宿主没有把官方 preset-standard 行交给我们。
 *
 * @module e2e/tests/preset-rebase.e2e
 */
import { test } from '@e2e-dev/web'
import { expect, type Screen } from 'e2e'
import { expectNoPageErrors, openReady, openSettings } from './support/dsh-web'

const REBASE_BUTTON = '跟随官方'
const CONFIRM = '确认'
const RESULT_OK = /已按当前官方预设重新派生|已经与当前官方预设一致/

/** 点「跟随官方」，再在二次确认里点确认。 */
async function followOfficial(screen: Screen): Promise<void> {
  await screen.getByRole('button', { name: REBASE_BUTTON, exact: true }).first().tap()
  await screen.getByRole('button', { name: CONFIRM, exact: true }).tap()
}

test('跟随官方：走真界面点一次，结论来自宿主里真实的官方声明', async ({ app, screen, browser }) => {
  await openReady(app, screen, browser)
  await openSettings(screen)
  await screen.getByRole('button', { name: 'Tool Plus', exact: true }).tap()

  await followOfficial(screen)

  await expect(screen.getByText(RESULT_OK)).toBeVisible({ timeout: 30_000 })
  await app.screenshot('rebase-result')
  await expectNoPageErrors(browser)
})

/**
 * 陈旧时的完整体验（需 E2E_SEED_STALE=1，启动接线会把 standard 覆盖成缺文档行的旧版本）：
 * 出现「推荐」标签 → 点击后确认框出现并滚入视口 → 确认后结果出现、标签消失。
 */
// 只在陈旧数据开关打开时注册：默认运行的 profile 没有陈旧覆盖，这条用例没有前提。
if (process.env.E2E_SEED_STALE === '1') test('跟随官方：陈旧时显示推荐，确认框与结果出现在视口内', async ({ app, screen, browser }) => {
  await openReady(app, screen, browser)
  await openSettings(screen)
  await screen.getByRole('button', { name: 'Tool Plus', exact: true }).tap()

  await expect(screen.getByText('推荐', { exact: true })).toBeVisible({ timeout: 30_000 })
  await app.screenshot('stale-recommend')

  // 陈旧时按钮的无障碍名是「跟随官方 推荐」，精确名匹配不上，按文字过滤。
  await screen.getByRole('button').filter({ hasText: REBASE_BUTTON }).first().tap()
  await expect(screen.getByRole('button', { name: CONFIRM, exact: true })).toBeVisible()
  await app.screenshot('stale-confirm')

  await screen.getByRole('button', { name: CONFIRM, exact: true }).tap()
  await expect(screen.getByText(RESULT_OK)).toBeVisible({ timeout: 30_000 })
  await app.screenshot('stale-rebased')
  await expect(screen.getByText('推荐', { exact: true })).toBeHidden()
  await expectNoPageErrors(browser)
})
