/**
 * Unit tests for the truncation utilities, TailBuffer, and OutputSink ported
 * from the pi-gateway bash-runtime.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { sanitizeText } from '../../src/tools/bash/sanitize-text.ts'
import { TailBuffer, truncateHead, truncateMiddle, truncateTail } from '../../src/tools/bash/streaming-output.ts'

describe('truncateHead', () => {
  it('keeps the leading window and reports the elided tail', () => {
    const result = truncateHead('a\nb\nc\nd\n', { maxLines: 2 })
    expect(result.content).toBe('a\nb')
    expect(result.truncated).toBe(true)
    expect(result.truncatedBy).toBe('lines')
  })

  it('returns the input untouched under the limits', () => {
    const result = truncateHead('one line', { maxLines: 10 })
    expect(result.truncated).toBeUndefined()
    expect(result.content).toBe('one line')
  })
})

describe('truncateTail', () => {
  it('keeps the trailing window', () => {
    const result = truncateTail('1\n2\n3\n4\n5\n', { maxLines: 2 })
    // The trailing newline counts as the final (empty) line.
    expect(result.content).toBe('5\n')
    expect(result.truncated).toBe(true)
  })
})

describe('truncateMiddle', () => {
  it('elides the middle and keeps head plus tail', () => {
    const result = truncateMiddle('1\n2\n3\n4\n5\n6\n', { maxLines: 4, maxHeadLines: 2 })
    expect(result.content).toContain('1\n2')
    expect(result.content).toContain('6\n')
    expect(result.elidedLines).toBe(3)
    expect(result.truncated).toBe(true)
  })
})

describe('TailBuffer', () => {
  it('holds a rolling byte budget', () => {
    const buffer = new TailBuffer(10)
    buffer.append('hello ')
    buffer.append('world this is long')
    const text = buffer.text()
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(10)
    expect(text).toBe('is is long')
  })

  it('reset drops all held output', () => {
    const buffer = new TailBuffer(100)
    buffer.append('some output')
    buffer.reset()
    expect(buffer.text()).toBe('')
    buffer.append('next')
    expect(buffer.text()).toBe('next')
  })
})

describe('sanitizeText', () => {
  it('strips ANSI escapes and control characters while keeping tabs and newlines', () => {
    const raw = '\x1b[31mred\x1b[0m\tline\nnext\x00'
    expect(sanitizeText(raw)).toBe('red\tline\nnext')
  })
})
