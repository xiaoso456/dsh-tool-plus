/**
 * `edit` 卡片 diff 解析对拍（计划 §4.2 / §8.2 #1）。
 *
 * 引擎把 diff 算好放在 `details.diff` 里，行的形态是 `<sign><行号>|<内容>`
 * （`omp/edit/diff.ts:54` `formatNumberedDiffLine`）：
 *  - replace / hashline → `generateDiffString`：只有编号行，没有 `@@` 头；
 *  - patch / apply_patch → `generateUnifiedDiffString`：`@@ -x,y +a,b @@` 头 +
 *    同样的编号行。
 *
 * 仓库现成的 `parseDiffHunks` 是给 apply_patch **应用补丁**用的：它按"行内容
 * 不带行号栏"的输入格式工作，`stripLineNumberPrefixes` 只认 `12 内容`
 * （空格分隔）不认引擎输出的 `12|内容`（竖线分隔），所以纯展示场景会把行号
 * 栏整条留在内容里。本文件把这条结论钉死（对拍），再验证展示用最小解析器
 * `parseNumberedDiffHunks`：剥掉行号栏、按 `@@` 头 / 空行 / 行号断裂切 hunk，
 * 行内容一字不改。
 */
import { describe, expect, it } from 'vitest'
import {
  generateDiffString,
  generateUnifiedDiffString,
  parseDiffHunks,
} from '../../src/tools/omp/edit/diff.ts'
import { parseNumberedDiffHunks } from '../../src/web/host/edit.ts'

const BEFORE = 'alpha\nbeta\ngamma\n'
const AFTER = 'alpha\nBETA\ngamma\n'

/** 任何 hunk 的行内容都不该再带 `<数字>|` 行号栏。 */
function expectNoLineNumberGutter(hunks: ReturnType<typeof parseNumberedDiffHunks>): void {
  for (const hunk of hunks) {
    for (const line of [...hunk.oldLines, ...hunk.newLines]) {
      expect(line).not.toMatch(/^\d+\|/)
    }
  }
}

describe('edit diff 对拍：引擎形态与 parseDiffHunks 的边界', () => {
  it('replace 形态：引擎输出带行号栏、没有 @@ 头', () => {
    const numbered = generateDiffString(BEFORE, AFTER).diff
    expect(numbered.split('\n')).toEqual([' 1|alpha', '-2|beta', '+2|BETA', ' 3|gamma'])
  })

  it('patch 形态：引擎输出 @@ 头 + 同一套行号栏', () => {
    const unified = generateUnifiedDiffString(BEFORE, AFTER).diff
    expect(unified.split('\n')).toEqual([
      '@@ -1,3 +1,3 @@',
      ' 1|alpha',
      '-2|beta',
      '+2|BETA',
      ' 3|gamma',
    ])
  })

  it('对拍结论：parseDiffHunks 把 `N|` 行号栏留在内容里 → 不能用于展示', () => {
    const unified = generateUnifiedDiffString(BEFORE, AFTER).diff
    const hunks = parseDiffHunks(unified)
    expect(hunks).toHaveLength(1)
    // stripLineNumberPrefixes 只认 `12 内容`（空格），`2|beta` 原样留下。
    expect(hunks[0].oldLines).toEqual(['1|alpha', '2|beta', '3|gamma'])
    expect(hunks[0].newLines).toEqual(['1|alpha', '2|BETA', '3|gamma'])
  })
})

describe('parseNumberedDiffHunks：展示用最小解析器', () => {
  it('replace 形态：剥行号栏，上下文两侧都有', () => {
    const hunks = parseNumberedDiffHunks(generateDiffString(BEFORE, AFTER).diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].changed).toBe(true)
    expect(hunks[0].oldLines).toEqual(['alpha', 'beta', 'gamma'])
    expect(hunks[0].newLines).toEqual(['alpha', 'BETA', 'gamma'])
    expectNoLineNumberGutter(hunks)
  })

  it('patch 形态：@@ 头被丢掉，内容与 replace 形态一致', () => {
    const hunks = parseNumberedDiffHunks(generateUnifiedDiffString(BEFORE, AFTER).diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldLines).toEqual(['alpha', 'beta', 'gamma'])
    expect(hunks[0].newLines).toEqual(['alpha', 'BETA', 'gamma'])
  })

  it('接受无行号栏的普通 unified 行（模型自撰补丁的输入形态）', () => {
    const hunks = parseNumberedDiffHunks('@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldLines).toEqual(['alpha', 'beta', 'gamma'])
    expect(hunks[0].newLines).toEqual(['alpha', 'BETA', 'gamma'])
  })

  it('行号断裂处切 hunk：两处相隔较远的编辑各自成段', () => {
    const oldText = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    const changed = oldText.split('\n')
    changed[1] = 'LINE 2'
    changed[9] = 'LINE 10'
    const newText = changed.join('\n')

    const hunks = parseNumberedDiffHunks(generateDiffString(oldText, newText).diff)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    expect(hunks.every(hunk => hunk.changed)).toBe(true)
    expectNoLineNumberGutter(hunks)

    const withFirst = hunks.filter(hunk => hunk.newLines.includes('LINE 2'))
    const withSecond = hunks.filter(hunk => hunk.newLines.includes('LINE 10'))
    expect(withFirst).toHaveLength(1)
    expect(withSecond).toHaveLength(1)
    // 两处改动落在不同 hunk：边界确实被切开，不是拼成一段。
    expect(withFirst[0]).not.toBe(withSecond[0])
  })

  it('纯新增（新建文件）：oldLines 为空 —— 投影层据此给 oldText:null', () => {
    const hunks = parseNumberedDiffHunks(generateUnifiedDiffString('', 'x\ny\n').diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldLines).toEqual([])
    expect(hunks[0].newLines).toEqual(['x', 'y'])
  })

  it('空 diff / 非 diff 文本不产 hunk，也不抛异常', () => {
    expect(parseNumberedDiffHunks('')).toEqual([])
    expect(parseNumberedDiffHunks('not a diff at all')).toEqual([])
    expect(parseNumberedDiffHunks('@@ -1,3 +1,3 @@')).toEqual([])
  })

  it('跳过换行/元数据行（`*** End of File`、`diff --git`、文件头）', () => {
    const hunks = parseNumberedDiffHunks(
      ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', ' 1|alpha', '-2|beta', '+2|BETA', '*** End of File'].join('\n'),
    )
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldLines).toEqual(['alpha', 'beta'])
    expect(hunks[0].newLines).toEqual(['alpha', 'BETA'])
  })

  it('只含上下文的碎片被丢弃（不产空 hunk）', () => {
    const hunks = parseNumberedDiffHunks([' 1|alpha', ' 2|beta'].join('\n'))
    expect(hunks).toEqual([])
  })
})
