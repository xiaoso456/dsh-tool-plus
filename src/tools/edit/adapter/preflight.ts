/**
 * 多条目 replace 预检（实验性，对应设置页 `multiEditPreflight` 开关）。
 *
 * 上游 `executeSinglePathEntries` 是逐条应用逐条写盘：第 2 条失败时第 1 条
 * 已经落到文件里。本模块用纯匹配函数 `replaceText` 在内存里按顺序跑一遍，
 * 先把所有会失败的条目找出来，让 adapter 在写盘前整体拒绝。开关关闭时
 * 本模块不会被调用，默认行为与上游一致。
 *
 * 设计文档：docs/experimental/multi-edit-preflight.md
 */
import { replaceText } from '../../omp/edit/diff.ts'
import { findMatch, type MatchOutcome } from '../../omp/edit/modes/replace.ts'

export interface PreflightEntry {
  oldText: string
  newText: string
}

export interface PreflightOptions {
  allowFuzzy: boolean
  threshold: number
  replaceAll?: boolean
}

export interface PreflightFailure {
  /** 条目的序号（从 1 开始，与上游 `Entry N of M` 同一口径）。 */
  entry: number
  /** 面向模型的失败原因，不含序号前缀。 */
  detail: string
}

export interface PreflightResult {
  failures: PreflightFailure[]
}

/**
 * 在内存里按调用顺序应用每个条目：成功的条目把结果喂给下一条，保证
 * 「第 2 条依赖第 1 条改完的文本」也能预检；失败的条目保持原内容并记录。
 */
export function preflightReplaceEntries(
  content: string,
  entries: readonly PreflightEntry[],
  options: PreflightOptions,
): PreflightResult {
  let current = content
  const failures: PreflightFailure[] = []

  entries.forEach((edit, index) => {
    const entry = index + 1
    if (edit.oldText.length === 0) {
      failures.push({ entry, detail: 'old_string must not be empty.' })
      return
    }
    let result: { content: string; count: number }
    try {
      result = replaceText(current, edit.oldText, edit.newText, {
        fuzzy: options.allowFuzzy,
        all: options.replaceAll ?? false,
        threshold: options.threshold,
      })
    } catch (error) {
      // 多条相同命中时 replaceText 直接抛错，引擎同样在这里中止。
      failures.push({ entry, detail: error instanceof Error ? error.message : String(error) })
      return
    }
    if (result.count === 0) {
      failures.push({ entry, detail: describeMiss(current, edit.oldText, options) })
      return
    }
    if (result.content === current) {
      failures.push({ entry, detail: 'this entry makes no changes to the file.' })
      return
    }
    current = result.content
  })

  return { failures }
}

/** 组装整次调用的预检失败信息；任何一条失败都不会写盘。 */
export function formatPreflightError(
  path: string,
  total: number,
  failures: readonly PreflightFailure[],
): string {
  const blocks = failures.map(failure => `Entry ${failure.entry} of ${total}: ${failure.detail}`)
  return [
    `Edit preflight failed for ${path}: ${failures.length} of ${total} entries would not apply. No changes were written.`,
    '',
    blocks.join('\n\n'),
    '',
    `Re-read the file and re-issue all ${total} entries; none of them were applied.`,
  ].join('\n')
}

function describeMiss(content: string, oldText: string, options: PreflightOptions): string {
  const outcome = findMatch(content, oldText, {
    allowFuzzy: options.allowFuzzy,
    threshold: options.threshold,
  })
  return describeMatchOutcome(outcome, oldText, options)
}

function describeMatchOutcome(
  outcome: MatchOutcome,
  oldText: string,
  options: PreflightOptions,
): string {
  if (outcome.occurrences && outcome.occurrences > 1) {
    const lines = outcome.occurrenceLines?.slice(0, 5).join(', ')
    return `matched ${outcome.occurrences} times${lines ? ` (lines ${lines})` : ''}; add more context to make it unique.`
  }
  if (!outcome.closest) {
    return options.allowFuzzy
      ? 'no close enough match in the file.'
      : 'no exact match in the file (fuzzy matching is off).'
  }
  const { oldLine, newLine } = firstDifferentLine(oldText, outcome.closest.actualText)
  const similarity = Math.round(outcome.closest.confidence * 100)
  const threshold = Math.round(options.threshold * 100)
  const reason = options.allowFuzzy
    ? `${similarity}% is below the ${threshold}% similarity threshold.`
    : 'fuzzy matching is off.'
  return [
    `closest match is ${similarity}% similar at line ${outcome.closest.startLine}:`,
    `  - ${oldLine}`,
    `  + ${newLine}`,
    reason,
  ].join('\n')
}

/** 第一处不同行；`-` 是请求文本，`+` 是文件里的实际文本（与引擎报错同向）。 */
function firstDifferentLine(requested: string, actual: string): { oldLine: string; newLine: string } {
  const requestedLines = requested.split('\n')
  const actualLines = actual.split('\n')
  const length = Math.max(requestedLines.length, actualLines.length)
  for (let i = 0; i < length; i++) {
    const oldLine = requestedLines[i]
    const newLine = actualLines[i]
    if (oldLine !== newLine) return { oldLine: oldLine ?? '', newLine: newLine ?? '' }
  }
  return { oldLine: requestedLines[0] ?? '', newLine: actualLines[0] ?? '' }
}
