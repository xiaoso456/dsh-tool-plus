/**
 * Wiring guard for the row-leading treatment.
 *
 * The shell draws a glyph in every clean state and swaps it for a state dot
 * only when the call failed or was interrupted — the shipped `ToolRow`'s rule —
 * so two things must hold in the source, neither of which a pure unit spec can
 * see: every row has to hand the shell its tool name (a row that forgets it
 * leads with the generic glyph), and the running sweep has to stay the shipped
 * one (same band, same geometry, same timing).
 *
 * Deliberately about calls and constants, not about pixels: the rendered
 * result is pinned by the real-machine screenshots.
 * @module tests
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Source text of a file under `src/web/client`. */
function clientSource(file: string): string {
  return readFileSync(new URL(`../../src/web/client/${file}`, import.meta.url), 'utf8')
}

/** The six rows that render the shared shell. */
const ROW_FILES = [
  'rows/AstEditRow.tsx',
  'rows/FileMutationRow.tsx',
  'rows/ReadRow.tsx',
  'rows/SearchRow.tsx',
  'rows/TerminalRow.tsx',
  'rows/WriteRow.tsx',
] as const

/** The rows, plus the shell's own two render sites (its card and its fallback). */
const SHELL_RENDER_FILES = [...ROW_FILES, 'ToolCardShell.tsx'] as const

describe('leading treatment wiring', () => {
  const shell = clientSource('ToolCardShell.tsx')

  it('leads with the shipped glyph table, not a status dot, while the row is clean', () => {
    expect(shell).toContain('icon={leadingFor(')
    // The dot is now a failure/interrupt mark, exactly as the shipped row has it.
    expect(shell).toContain('<StateDot state="error" />')
    expect(shell).toContain('<StateDot state="warning" />')
  })

  it('draws every glyph from the shipped leading table', () => {
    // Same five glyphs the shipped generic tool card maps its variants onto.
    for (const icon of [
      'IconApiOutline14', 'IconBrowseOutline16', 'IconEditOutline16', 'IconSearchOutline16', 'IconSparkle16',
    ]) {
      expect(shell, icon).toContain(icon)
      expect(shell, `${icon} must come from the shipped primitives package`)
        .toMatch(new RegExp(`import\\s*\\{[^}]*\\b${icon}\\b[^}]*\\}\\s*from\\s*'@deepseek-ai/dsh-client-ui-primitives'`))
    }
  })

  it('keeps the running sweep the shipped one, band for band', () => {
    // The whole declaration, so a re-tuned band (a moved gradient stop, a
    // dropped transparent edge, a different easing) cannot pass as "band for
    // band": every part of it is copied from the shipped ToolRow.module.css.
    expect(shell).toContain(
      ".twc-root[data-state='running'] .twc-row::after{content:'';position:absolute;top:0;bottom:0;left:0;width:300px;"
      + 'background:linear-gradient(90deg,transparent 0%,'
      + 'color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,transparent 100%);'
      + 'animation:twc-row-sweep 2.6s ease-out infinite;pointer-events:none}',
    )
    expect(shell).toContain('@keyframes twc-row-sweep{0%{left:-300px}90%,100%{left:100%}}')
    // The anchor and the clip the band needs, repeated from the shipped sheet.
    expect(shell).toContain('.twc-row{position:relative;min-width:0;overflow:hidden}')
  })

  it('holds the sweep still for a reader who asked for less motion', () => {
    // The one deliberate deviation from the shipped sheet, which animates with
    // no motion query at all.
    expect(shell).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\.twc-root\[data-state='running'\] \.twc-row::after\{display:none\}\}/,
    )
  })

  it('stamps the run state the sweep selector keys off, on the root it keys off', () => {
    // The sweep selector is `.twc-root[data-state='running']`, so the attribute
    // has to be on the same element as the class — a state moved anywhere else
    // would leave the sweep silently dead. Nothing renders the shell here, so
    // a source-level pin of the pair is the only guard.
    expect(shell).toContain('className="twc-root" data-state={state}')
  })

  it('injects its stylesheet whenever the shell mounts', () => {
    // The leading box, the sweep and the file link all live in that sheet; a
    // shell that stops calling `injectCss()` renders as unstyled chrome.
    expect(shell).toMatch(/export function ToolCardShell\([\s\S]{0,400}?injectCss\(\)/)
  })

  it.each(SHELL_RENDER_FILES)('%s names a tool at every shell it renders', (file) => {
    const source = clientSource(file)
    const sites = source.split('<ToolCardShell').slice(1)
    expect(sites.length, file).toBeGreaterThan(0)
    for (const [index, site] of sites.entries()) {
      const opening = site.slice(0, 240)
      // The crash fallback is hard-coded to the error state, which draws the
      // state dot and never a glyph, so it has no tool name to pass.
      if (opening.includes('state="error"')) continue
      expect(opening, `${file} shell site ${index + 1} must name its tool`)
        .toMatch(/tool=\{(?:tool|toolName)\}/)
    }
  })

  it.each(ROW_FILES)('%s names a tool at every generic fallback it renders', (file) => {
    const source = clientSource(file)
    // The degradation path draws the same glyph as the card it degrades from,
    // and needs the workspace root to shorten the path it states; a site
    // without them silently leads with the generic sparkle and an unshortened
    // or missing fact.
    const fallbacks = source.split('<GenericCard').slice(1)
    expect(fallbacks.length, file).toBeGreaterThan(0)
    for (const [index, site] of fallbacks.entries()) {
      const opening = site.slice(0, 260)
      expect(opening, `${file} GenericCard site ${index + 1}`).toContain('toolName={toolName}')
      expect(opening, `${file} GenericCard site ${index + 1}`).toMatch(/cwd=\{(?:cwd|sessionCwd)\}/)
    }
  })

  it.each(['rows/ReadRow.tsx', 'rows/WriteRow.tsx', 'rows/FileMutationRow.tsx', 'rows/AstEditRow.tsx'])(
    '%s hands its fallback the host\'s file opener',
    (file) => {
      // Without it the degraded row states the path but cannot open it, which
      // is exactly the asymmetry the real card avoids.
      const source = clientSource(file)
      const fallbacks = source.split('<GenericCard').slice(1)
      expect(fallbacks.length, file).toBeGreaterThan(0)
      for (const [index, site] of fallbacks.entries()) {
        expect(site.slice(0, 300), `${file} GenericCard site ${index + 1}`).toContain('openFile={openFile}')
      }
    },
  )

  it('gives the generic shell the same glyph as the card it degrades from', () => {
    expect(shell).toMatch(/<ToolCardShell\s+t=\{t\}\s+state=\{state\}\s+title=\{title\}[\s\S]{0,200}?tool=\{toolName\}/)
  })
})
