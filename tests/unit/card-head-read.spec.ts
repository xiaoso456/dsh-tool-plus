/**
 * Unit tests for the read card's collapsed summary: the call's own argument,
 * inline selector included, with the Host-projected path as the fallback.
 *
 * The projection deliberately strips the selector (`stripReadSelector`) because
 * the *link* must point at the file — but the row used to print that stripped
 * path as its whole summary, so a windowed read (`package.json:22-25,31-34`)
 * looked exactly like a whole-file read. The summary is the only place the
 * question the model asked is still visible.
 * @module tests
 */

import { describe, expect, it } from 'vitest'
import { readCardSummary } from '../../src/web/client/rows/read-card-facts.ts'

describe('read card summary', () => {
  it('keeps the call\'s inline selector, which the host projection strips', () => {
    expect(readCardSummary({ path: 'src/foo.ts:5-16,40-80' }, 'src/foo.ts', undefined))
      .toBe('src/foo.ts:5-16,40-80')
    expect(readCardSummary({ path: 'src/foo.ts:22-25' }, 'src/foo.ts', '/w/app'))
      .toBe('src/foo.ts:22-25')
  })

  it('keeps every selector family the read argument accepts', () => {
    for (const asked of [
      'src/foo.ts:raw',
      'src/foo.ts:raw:1-4',
      'src/foo.ts:50+150',
      'src/foo.ts:conflicts',
      'CONFLICT.md:conflicts',
      'db.sqlite:users:42',
      'bundle.tar:src/inside.ts',
      'src/foo.ts:28-',
    ]) {
      expect(readCardSummary({ path: asked }, 'src/foo.ts', '/w/app'), asked).toBe(asked)
    }
  })

  it('shortens a workspace-absolute argument without touching its selector', () => {
    expect(readCardSummary({ path: '/w/app/src/a.ts:12' }, 'src/a.ts', '/w/app')).toBe('src/a.ts:12')
    expect(readCardSummary({ path: 'D:\\w\\app\\src\\a.ts:12' }, 'src/a.ts', 'D:\\w\\app')).toBe('src/a.ts:12')
  })

  it('falls back to the projected path when the call head is gone', () => {
    // A window-truncated result carries no `tool/call`, so there is no argument
    // to show; the projection's own path is the only fact left.
    expect(readCardSummary(null, 'src/foo.ts', '/w/app')).toBe('src/foo.ts')
    expect(readCardSummary({ path: '' }, 'src/foo.ts', '/w/app')).toBe('src/foo.ts')
    expect(readCardSummary({ path: 42 }, 'src/foo.ts', '/w/app')).toBe('src/foo.ts')
  })
})
