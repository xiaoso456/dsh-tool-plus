/**
 * 移植缺陷回归：normalizeForFuzzy 的引号字符类把 ASCII 引号写了两遍，漏掉最常见的
 * 弯双引号 U+201C/U+201D（单引号同理漏 U+2018/U+2019）。上游 17.3.5 原样如此，
 * Rust 重写版 crates/pi-edit/src/text.rs 也保留了同一缺陷，照抄过来后默认 replace
 * 模式的模糊匹配对「弯引号 vs 直引号」完全失灵。
 *
 * 另：同文件的 UNICODE_REPLACEMENTS 表（normalizeUnicode 用）范围是全的，
 * 修复方式是让 normalizeForFuzzy 复用它，避免两份表再次漂移。
 */
import { describe, expect, it } from 'vitest'
import { normalizeForFuzzy, normalizeUnicode } from '../../src/tools/omp/edit/normalize.ts'
import { findMatch } from '../../src/tools/omp/edit/modes/replace.ts'
import { replaceText } from '../../src/tools/omp/edit/diff.ts'

describe('normalizeForFuzzy：弯引号', () => {
  it('弯双引号折叠成 ASCII 双引号', () => {
    expect(normalizeForFuzzy('说 “你好”')).toBe('说 "你好"')
  })

  it('左右单引号折叠成 ASCII 撇号', () => {
    expect(normalizeForFuzzy('it’s ‘ok’')).toBe("it's 'ok'")
  })

  it('德式低引号与法式引号同样折叠', () => {
    expect(normalizeForFuzzy('„a“ «b»')).toBe('"a" "b"')
  })

  it('反引号与重音符折叠成撇号（旧实现就有的行为，复用替换表时不能丢）', () => {
    expect(normalizeForFuzzy('a`b´c')).toBe("a'b'c")
  })
})

describe('normalizeForFuzzy：其余归一化', () => {
  it('各种破折号折叠成 -', () => {
    expect(normalizeForFuzzy('a–b—c−d‐e')).toBe('a-b-c-d-e')
  })

  it('制表符与连续空格折叠成一个空格并去首尾空白', () => {
    expect(normalizeForFuzzy('  a\t\tb  c  ')).toBe('a b c')
  })

  it('空白行归一化为空串', () => {
    expect(normalizeForFuzzy(' \t ')).toBe('')
  })

  it('不换行空格折叠成普通空格', () => {
    expect(normalizeForFuzzy('a\u00A0b')).toBe('a b')
  })

  it('零宽字符被移除', () => {
    expect(normalizeForFuzzy('a\u200Bb')).toBe('ab')
  })
})

describe('模糊匹配回归：文件是直引号、请求是弯引号', () => {
  const content = 'const label = "后写胜"\nconst other = 1\n'

  it('findMatch 在 0.95 阈值下应命中（修复前这里返回未匹配）', () => {
    const outcome = findMatch(content, 'const label = “后写胜”', { allowFuzzy: true, threshold: 0.95 })
    expect(outcome.match).toBeDefined()
    expect(outcome.match?.confidence).toBe(1)
  })

  it('替换结果落到文件里，其余行不动', () => {
    const result = replaceText(content, 'const label = “后写胜”', 'const label = "新值"', { fuzzy: true, all: false })
    expect(result.content).toContain('const label = "新值"')
    expect(result.content).toContain('const other = 1')
  })

  it('真正不同的文本仍然不匹配，归一化不能放水', () => {
    const outcome = findMatch(content, 'const label = “完全不同的一句话”', { allowFuzzy: true, threshold: 0.95 })
    expect(outcome.match).toBeUndefined()
  })
})

describe('纯 ASCII 快路径与慢路径等价', () => {
  /** 慢路径的参考实现：与 normalizeForFuzzy 的非 ASCII 分支逐字一致。 */
  function slowPath(line: string): string {
    const trimmed = line.trim()
    if (trimmed.length === 0) return ''
    const normalized = normalizeUnicode(trimmed)
      .replace(/[\u00AB\u00BB]/g, '"')
      .replace(/[\u0060\u00B4]/g, "'")
    if (normalized.length === 0) return ''
    return normalized.replace(/[ \t]+/g, ' ')
  }

  it('反引号在纯 ASCII 分支里也要折叠', () => {
    expect(normalizeForFuzzy('a`b')).toBe("a'b")
  })

  it('制表符与连续空格在纯 ASCII 分支里折叠并去首尾空白', () => {
    expect(normalizeForFuzzy('\ta  \t\tb ')).toBe('a b')
  })

  it('纯 ASCII 行原样保留内容', () => {
    expect(normalizeForFuzzy('  const x = 1  ')).toBe('const x = 1')
  })

  it('非 ASCII 行同时含反引号与弯引号时两条替换都生效', () => {
    expect(normalizeForFuzzy('a`“x”')).toBe("a'\"x\"")
  })

  it('只有零宽字符的行归一化为空串', () => {
    expect(normalizeForFuzzy('\u200B\u200B')).toBe('')
  })

  it('随机串对照慢路径，结果必须逐字节一致', () => {
    const alphabet = ['a', 'Z', ' ', '\t', '"', "'", '“', '”', '‘', '’', '„', '‟', '«', '»', '–', '—', '−', '‐', '\u00A0', '\u3000', '\u200B', '\uFEFF', '≠', '½', '中', 'é', 'e', '\u0301', '\n', '\u201A', '\u201B', '´', '`']
    let seed = 20261121
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    let mismatches = 0
    for (let n = 0; n < 5000; n++) {
      let sample = ''
      const length = 1 + (rand() % 16)
      for (let i = 0; i < length; i++) sample += alphabet[rand() % alphabet.length]
      if (normalizeForFuzzy(sample) !== slowPath(sample)) mismatches += 1
    }
    expect(mismatches).toBe(0)
  })
})

