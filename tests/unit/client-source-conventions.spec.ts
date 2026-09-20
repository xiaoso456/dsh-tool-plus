/**
 * 客户端**源码级约定**守卫（设置页 + 预设面板）。
 *
 * 为什么这层需要源码级断言：仓库里没有任何 spec 渲染 `.tsx` 组件（客户端测试全是
 * 纯函数或源码形状），所以"设置页控件必须长成宿主那样"这类约定，只能在这一层证明。
 *
 * 两条互不重叠的约定：
 *  1. **设计 token 必须真实存在**（跨模块，没有单一模块拥有它）。2026-09-20 踩到的真
 *     bug：`--dsw-alias-label-error` 在宿主调色板里根本不存在（只有
 *     `state-error-primary/secondary`），而它在 4 个客户端文件里被当成"错误色"用了很久
 *     ——变量取不到值会让**整条声明在计算值阶段失效**，颜色静默回落继承色。清单快照自
 *     `@deepseek-ai/dsh-client-ui-theme` 0.1.5-rc.1 的调色板定义（79 个 alias + 我们用到
 *     的 static 中性色）；宿主以后新增 token 时这里要跟着改一次，那一步是**故意**的：
 *     改它就是承认"我核对过它确实存在"。
 *  2. **按钮与悬浮说明的形态约定**（照宿主自己的写法）：次级按钮＝透明底 + 细描边 +
 *     主文字色；危险按钮静止态与邻居同款、只在悬停变危险色；说明卡必须 portal + fixed
 *     + z-index 高于抽屉遮罩，且用不会随主题翻转的静态前景色。
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** 宿主真实存在的 `--dsw-alias-*` 快照（79 个，勿凭感觉加）。 */
const OFFICIAL_TOKENS = new Set<string>([
  '--dsw-static-neutral-bluish-00',
  '--dsw-static-neutral-bluish-50',
  '--dsw-static-neutral-bluish-850',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-toast-bg',
  '--dsw-alias-tooltip-bg',
])

/** 本包客户端源码里出现过的所有 `--dsw-alias-*`（含文件名，便于定位）。 */
function usedTokens(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(target)
    return /\.(ts|tsx)$/.test(entry.name) ? [target] : []
  })
  for (const file of walk(path.join(import.meta.dirname, '..', '..', 'src', 'client'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/--dsw-(?:alias|static)-[a-z0-9-]+/g)) {
      const name = match[0]
      // 文档里写 `state-{success,warn,error}-primary` 这类模板串不算用法
      if (name.endsWith('-')) continue
      found.set(name, [...(found.get(name) ?? []), path.relative(process.cwd(), file)])
    }
  }
  return found
}

describe('设计 token 必须真实存在（跨模块约定）', () => {
  it('只使用宿主真实存在的 alias token', () => {
    const unknown = [...usedTokens().entries()]
      .filter(([name]) => !OFFICIAL_TOKENS.has(name))
      .map(([name, files]) => `${name} (${[...new Set(files)].join(', ')})`)
    expect(unknown, '这些 token 在宿主调色板里不存在，整条声明会静默失效').toEqual([])
  })

  it('不再出现曾经的假 token（错误色走 state-error-primary）', () => {
    const text = [...usedTokens().values()].flat().length > 0
    expect(text).toBe(true) // 保证扫描真的扫到了文件，避免"空跑恒真"
    expect(usedTokens().has('--dsw-alias-label-error')).toBe(false)
  })
})

describe('按钮与悬浮说明形态（照宿主自己的写法）', () => {
  const rowsCss = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'client', 'rows.tsx'), 'utf8')
  const panelCss = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'client', 'PresetPanel.tsx'), 'utf8')

  it('次级按钮：透明底 + 细描边 + 主文字色，而不是和卡片同色的填充', () => {
    const rule = /\.tp-actionButton\{([^}]*)\}/.exec(rowsCss)?.[1] ?? ''
    expect(rule).toContain('background:transparent')
    expect(rule).toContain('border:.5px solid var(--dsw-alias-border-l3)')
    expect(rule).toContain('color:var(--dsw-alias-label-primary)')
    // 曾经的错法：填充色用卡片自己的底色，看着像糊了一块
    expect(rule).not.toContain('background:var(--dsw-alias-bg-layer-1)')
  })

  it('危险按钮静止态与邻居同款，只在悬停时变危险色', () => {
    // 宿主的 reject：静止态是次级按钮，hover 才 bg-danger + 错误色文字 + 去描边。
    expect(panelCss).toContain('.tpp-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}')
    // 静止态不许自己上红字/去描边（那会显得和整排按钮不是一套）
    expect(panelCss).not.toMatch(/\.tpp-danger\{[^}]*color:var\(--dsw-alias-state-error-primary\)\}/)
  })

  it('悬浮说明：一行两按钮不动，说明卡浮在上层且不被面板裁切', () => {
    // 原始排布：左侧说明与按钮同一行、按钮靠右对齐
    expect(panelCss).toContain('.tpp-actions{position:relative;display:inline-flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}')
    // 说明卡必须是 fixed 浮层：设置面板的滚动容器是 overflow-y:auto，挂在卡片里做绝对
    // 定位，长文案换行后会超出可视区被**裁掉**（用户实测"被遮挡、看不全"）；z-index
    // 1100 要压过抽屉遮罩层（1000）。
    expect(panelCss).toContain('.tpp-tip{position:fixed;z-index:1100;')
    // 坐标按按钮矩形实时算，且 portal 到 body，任何祖先的裁切都够不着
    expect(panelCss).toContain('const showHint = (action: PresetAction, target: HTMLElement)')
    expect(panelCss).toContain("from 'react-dom'")
    expect(panelCss).toContain('createPortal(')
    expect(panelCss).toContain('document.body,')
    // 外观照宿主 tooltip：底色 + 固定浅色前景（两套主题的 tooltip 底都是深色，
    // 会翻转的别名前景在浅色主题下只有约 2:1 对比度）
    expect(panelCss).toContain('background:var(--dsw-alias-tooltip-bg)')
    expect(panelCss).toContain('color:var(--dsw-static-neutral-bluish-50)')
    // 不用宿主悬浮卡：它只会开在锚点右侧，而这行动作贴面板右缘
    expect(panelCss).not.toContain('HoverCard')
  })
})
