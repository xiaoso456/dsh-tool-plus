/**
 * Wiring guard for the card-head facts: each row must actually draw the fact
 * its helper computes.
 *
 * A helper nothing calls is a green test over a card that still hides the
 * fact, and this change is spread over three helper modules and four rows. The
 * check is deliberately about the call, not the shape of the JSX: what the
 * card looks like is pinned by the real-machine screenshots, not by this file.
 * @module tests
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Source text of one row component. */
function rowSource(file: string): string {
  return readFileSync(new URL(`../../src/web/client/rows/${file}`, import.meta.url), 'utf8')
}

describe('card head wiring', () => {
  it.each([
    ['ReadRow.tsx', 'readCardSummary'],
    ['SearchRow.tsx', 'searchCardSuffix'],
    ['TerminalRow.tsx', 'bashCardSummary'],
    ['AstEditRow.tsx', 'astEditRuleLine'],
  ])('%s draws %s', (file, helper) => {
    const source = rowSource(file)
    expect(source, `${file} must call ${helper}`).toContain(`${helper}(`)
    expect(source, `${file} must import ${helper}`).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${helper}\\b[^}]*\\}`))
  })

  it('leaves the write and edit card heads alone: they already state their facts', () => {
    // Both heads show the path and the size of the change, and both were
    // audited as complete; a change here would be a regression by definition.
    // The assertion names the helper they actually use — `not.toContain` on a
    // module name would stay green even if a head called the count instead.
    for (const file of ['WriteRow.tsx', 'FileMutationRow.tsx']) {
      expect(rowSource(file), file).not.toContain('card-facts')
      expect(rowSource(file), file).toMatch(/displayPath\(/)
    }
  })

  it('states a fact, never an argument count, on the generic fallback head', () => {
    // Every row's degradation path goes through here, so a generic shell that
    // prints "N 个参数" hides the path/command for a running call, a directory
    // read, and a session-window-truncated one alike.
    const shell = readFileSync(new URL('../../src/web/client/ToolCardShell.tsx', import.meta.url), 'utf8')
    expect(shell).toMatch(
      /import\s*\{[^}]*\bfallbackCardSummary\b[^}]*\}\s*from\s*'\.\/rows\/fallback-card-facts\.ts'/,
    )
    expect(shell).toMatch(/summary=\{failure === '' \? fallbackCardSummary\(/)
    // The raw argument text is the only thing that exists for a call still
    // streaming its arguments: dropping it must not stay green.
    expect(shell).toContain('fallbackCardSummary(toolName, args, cwd, t, cardArgsRaw(block))')
    // The degraded file-backed row offers the same openable path the real card
    // does — and only when the head IS the call's fact, never on a failure line.
    expect(shell).toContain('const link = failure === \'\' ? fallbackCardLink(toolName, args) : null')
    expect(shell).toMatch(/filePath=\{link\}[\s\S]{0,80}?openFile=\{link === null \? undefined : openFile\}/)
    // A linked failure line must keep the error tone: the link branch carries it.
    expect(shell).toContain("className={errorTone ? 'twc-fileLink twc-errorSummary' : 'twc-fileLink'}")
    // The count is one branch inside the dispatcher, not the shell's own
    // fallback: a shell that keeps calling it hides the fact again.
    expect(shell, 'the shell must not fall back to the argument count itself').not.toContain('argsSummary')
  })
})
