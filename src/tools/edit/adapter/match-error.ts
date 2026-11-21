/**
 * 详细匹配失败提示（实验性，`detailedMatchFailure` 开关，默认开启）。
 *
 * 引擎的 `EditMatchError` 只打印「第一处不同行」和相似度，模型往往还得重新读一遍
 * 文件才能拿到可以当 old_string 的整段实际文本。这里在适配层把 closest 块原样附上，
 * 不改上游 verbatim 的错误构造；块过大或相似度过低时不附，避免给出一段截断后
 * 根本匹配不上的文本。
 */
import { EditMatchError } from '../../omp/edit/modes/replace.ts'

/** 低于该相似度的候选不作为可用文本附上（引擎自身仍会把它写进报错）。 */
const MIN_CONFIDENCE = 0.8
/** 超过任一上限就不附：截断的块不能直接当 old_string，反而误导。 */
const MAX_LINES = 40
const MAX_BYTES = 4096

/**
 * closest 块的附加文案；不满足条件时返回 null（调用方保持原错误不变）。
 */
export function describeClosestMatch(error: EditMatchError): string | null {
  const closest = error.closest
  if (closest === undefined || closest.confidence < MIN_CONFIDENCE) return null
  // 多个高置信候选时引擎已经要求「补上下文去重」，附其中一块只会暗示错的那个。
  if (error.options.fuzzyMatches !== undefined && error.options.fuzzyMatches > 1) return null

  const text = closest.actualText
  const lines = text.split('\n').length
  const bytes = new TextEncoder().encode(text).length
  if (lines > MAX_LINES || bytes > MAX_BYTES) {
    return `Closest match starts at line ${closest.startLine} but is too large to include (${lines} lines); re-read that part of the file for the exact text.`
  }

  const similarity = Math.round(closest.confidence * 100)
  return [
    `Closest match in the file (${similarity}% similar, starting at line ${closest.startLine}). If it is the text you meant, use it as old_string:`,
    '<closest_match>',
    text,
    '</closest_match>',
  ].join('\n')
}

/**
 * 开关开启时把 closest 块接到 `EditMatchError` 的消息后面；其它错误原样返回。
 *
 * 多条目调用里 dispatch 会捕获错误并用 `err.message` 拼聚合文案，所以在这里
 * 换成一个消息更长的 Error 就能同时覆盖单条与多条路径。
 */
export function withClosestMatch(error: unknown): unknown {
  if (!(error instanceof EditMatchError)) return error
  const block = describeClosestMatch(error)
  if (block === null) return error
  const enriched = new Error(`${error.message}\n\n${block}`)
  enriched.name = error.name
  return enriched
}
