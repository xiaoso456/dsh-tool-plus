/**
 * 工具**结果**这一面的两条：失败怎么交回来、图像怎么进上下文。
 *
 * 断言仍然落在两手证据上：界面上必须出现的收尾文本（剧本自己带着前置条件，对不上就根本
 * 走不到那一步），以及假供应商侧收到的请求里真实存在的工具结果内容。
 *
 * 两条都不用 `agent.*`：它们验的是工具的返回路径，不是模型会不会用工具。
 *
 * @module e2e/tests/tool-results
 */

import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { expectNoPageErrors, openReady, sendPrompt, toolTextOf, waitForModelRequest } from './support/dsh-web'

test('工具失败会被如实交回，会话也不会被打断', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  /**
   * 剧本的第二步要求「失败原文出现在这一轮的工具结果里」才匹配得上——匹配不上就只有兜底文本，
   * 屏幕上永远等不到 `MOCK_E2E_ERR_FINAL`。所以这一条断言本身就含着「失败被交回」。
   */
  const nonce = `E2E-ERR-${String(Date.now())}`

  const { mockUrl } = await openReady(app, screen, browser)

  await sendPrompt(screen, `${nonce} 端到端验收：跑一条不存在的命令，看失败怎么回来。`)

  await expect(screen.getByText('MOCK_E2E_ERR_FINAL')).toBeVisible({ timeout: 120_000 })

  // 从假供应商那侧再核一次：那条失败命令的名字确实以工具结果的形式回到了上下文里。
  const row = await waitForModelRequest(
    mockUrl,
    (candidate) => JSON.stringify(candidate.body).includes('definitely-not-a-command-e2e'),
  )
  expect(row.turn).toBe('err-02-final')
  await expectNoPageErrors(browser)

  await app.screenshot('failure-returned')
})

test('read 一张真图会走图像路径，而不是降级成一段元数据', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  const nonce = `E2E-IMG-${String(Date.now())}`

  const { mockUrl } = await openReady(app, screen, browser)

  await sendPrompt(screen, `${nonce} 端到端验收：读一张图，看它是不是真的作为图像进了上下文。`)

  await expect(screen.getByText('MOCK_E2E_IMG_FINAL')).toBeVisible({ timeout: 120_000 })

  /**
   * 关键断言落在**信封文本**上，三个针各有分工：
   *
   * - 夹具路径：读的确实是我让它读的那张图；
   * - `original 16x16`：那 84 个字节真的被解码了（这是夹具的真实尺寸，不是缓存的或别的图）；
   * - `image/webp` + 附件引用：图像进了附件库，走的是图像路径。
   *
   * 为什么不断「图像块」：OpenAI 兼容面的 `role: "tool"` 消息**塞不进图片**，宿主会把图像块
   * 渲染成这段信封文本再发出去——所以在这条协议上，图像到达模型的形式本来就是文本。
   * 能断、也值得断的是「插件有没有把它当图处理」：非视觉路由会 soft-refuse 成一段说明文字
   * （用户拍板 2026-08-28），那时既不会有归一化尺寸、也不会有附件引用。
   */
  const row = await waitForModelRequest(mockUrl, (candidate) => toolTextOf(candidate).includes('tiny.png'))
  const text = toolTextOf(row)
  expect(text).toContain('e2e/fixtures/tiny.png')
  expect(text).toContain('original 16x16')
  expect(text).toContain('image/webp')
  expect(text).toContain('sha256:')
  await expectNoPageErrors(browser)

  await app.screenshot('image-path')
})
