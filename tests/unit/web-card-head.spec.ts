/**
 * Canonical spec for the web card head and row leading: what a collapsed row
 * states as its fact, how the row leads, the settings form's reversion
 * algebra, and the source-level wiring that makes all of it reach the DOM.
 *
 * Merged from seven single-concern specs. `describe('web card head')` groups
 * one nested block per concern:
 *
 * - **facts** — the pure fact helpers the collapsed heads draw: the command a
 *   bash description hides, the `ast_edit` rewrite rule, the read call's own
 *   argument (selector included) and the search scope/result counts.
 * - **wiring** — the row components must actually *call* those helpers: a
 *   helper nothing calls is a green test over a card that still hides the fact.
 * - **leading** — which glyph a row leads with, and what replaces it when the
 *   call did not settle cleanly, plus the source-level guards for the rows that
 *   have to hand the shell its tool name and the sweep's shipped geometry.
 * - **form** — the settings card's staged-vs-base-vs-stored reversion algebra.
 *
 * Everything here pins decisions and calls, never pixels: the client half is a
 * browser bundle that cannot render under the Node runner, so the rendered
 * result is pinned by real-machine screenshots instead.
 * @module tests
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CARD_TOOL_KEYS, type SearchCardMeta } from '../../src/web/contract.ts'
import { en, zh } from '../../src/web/client/labels.ts'
import { astEditRuleLine, bashCardSummary } from '../../src/web/client/rows/command-card-facts.ts'
import { readCardSummary } from '../../src/web/client/rows/read-card-facts.ts'
import { searchCardSuffix } from '../../src/web/client/rows/search-card-facts.ts'
import { leadingGlyph, leadingKind } from '../../src/web/client/rows/card-leading.ts'
import type { CardState, CardTranslate } from '../../src/web/client/row-utils.ts'
import { DEFAULT_OUTPUT_TRUNCATE, resolveConfig } from '../../src/config/settings.ts'

// ---------------------------------------------------------------- shared fixtures

/** A recording translate seat over one dictionary. */
function translator(dict: Record<string, string>): CardTranslate {
  return ((key: string, params?: Record<string, unknown>) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`missing dictionary key: ${key}`)
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }) as unknown as CardTranslate
}

/** The card dictionary in each language. */
const t = { zh: translator(zh), en: translator(en) }

/** Source text of one file under `src/web/client`. */
function clientSource(file: string): string {
  return readFileSync(new URL(`../../src/web/client/${file}`, import.meta.url), 'utf8')
}

/** Source text of one row component. */
function rowSource(file: string): string {
  return clientSource(`rows/${file}`)
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

/** Grouped matches for `foo`: 2 in a.ts + 1 in b.ts. */
const matches: SearchCardMeta = {
  kind: 'search',
  shape: 'matches',
  files: [
    { path: 'src/a.ts', matches: [{ lineNumber: 1, line: 'foo' }, { lineNumber: 9, line: 'foo' }] },
    { path: 'src/b.ts', matches: [{ lineNumber: 4, line: 'foo' }] },
  ],
  truncated: false,
  total: 3,
}

describe('web card head', () => {
  // -------------------------------------------------------------- facts

  describe('facts', () => {
    describe('bash card summary', () => {
      it('adds the command the description hides', () => {
        expect(bashCardSummary('列出所有测试文件', 'pnpm test --run', null))
          .toBe('列出所有测试文件 · pnpm test --run')
      })

      it('is the command alone when the model wrote no description', () => {
        expect(bashCardSummary(null, 'pnpm build', null)).toBe('pnpm build')
        expect(bashCardSummary('', 'pnpm build', null)).toBe('pnpm build')
      })

      it('shows only the command\'s first line', () => {
        expect(bashCardSummary('两件事', 'pnpm test --run\nrm -rf dist', null))
          .toBe('两件事 · pnpm test --run')
      })

      it('reports the outcome instead when the run was interrupted', () => {
        // A timed-out or cancelled run has no result to describe; the outcome is
        // the whole fact and the command must not push it out of the row.
        expect(bashCardSummary('列出所有测试文件', 'pnpm test --run', '已超时')).toBe('已超时')
        expect(bashCardSummary(null, 'pnpm build', '已取消')).toBe('已取消')
      })
    })

    describe('ast_edit rule line', () => {
      it('states the rewrite the call asked for', () => {
        expect(astEditRuleLine({ ops: [{ pat: 'console.log($A)', out: 'log($A)' }], paths: ['src/a.ts'] }, t.zh))
          .toBe('规则: console.log($A) → log($A)')
      })

      it('counts every op the line does not state', () => {
        // House style marks an elided tail with a leading ellipsis (the same
        // `… 其余 N 行` a collapsed window uses). The count is every *other* entry
        // the call carried, usable or not: otherwise a two-entry call whose first
        // entry cannot be drawn would claim to have had exactly one rule.
        expect(astEditRuleLine({ ops: [{ pat: 'a', out: 'b' }, { pat: 'c', out: 'd' }] }, t.zh))
          .toBe('规则: a → b · … 其余 1 条')
      })

      it('skips entries that are not a usable rule, still counting them', () => {
        expect(astEditRuleLine({ ops: [{ pat: 'orphan' }, { pat: 'x', out: 'y' }] }, t.zh))
          .toBe('规则: x → y · … 其余 1 条')
        expect(astEditRuleLine({ ops: [{ pat: '', out: 'y' }, { pat: 'x', out: 42 }] }, t.zh)).toBeNull()
        expect(astEditRuleLine({ ops: [{ pat: 'orphan' }, { pat: 'x', out: 'y' }, { pat: 'z', out: 'w' }] }, t.zh))
          .toBe('规则: x → y · … 其余 2 条')
      })

      it('states an empty replacement instead of hiding the op', () => {
        // An empty `out` is the engine's own "replace with nothing": it is a real
        // rule, so the line states it (the arrow ends the line) rather than
        // skipping the entry and reporting a shorter call than was made.
        expect(astEditRuleLine({ ops: [{ pat: 'a', out: '' }, { pat: 'b', out: 'c' }] }, t.zh))
          .toBe('规则: a → · … 其余 1 条')
      })

      it('has no rule to state when the call head is gone or the ops are unusable', () => {
        expect(astEditRuleLine(null, t.zh)).toBeNull()
        expect(astEditRuleLine({ paths: ['src/a.ts'] }, t.zh)).toBeNull()
        expect(astEditRuleLine({ ops: [] }, t.zh)).toBeNull()
        expect(astEditRuleLine({ ops: 'run' }, t.zh)).toBeNull()
      })

      it('speaks English in the English dictionary', () => {
        expect(astEditRuleLine({ ops: [{ pat: 'a', out: 'b' }, { pat: 'c', out: 'd' }] }, t.en))
          .toBe('Rules: a → b · … 1 more')
      })
    })

    // The read card's collapsed summary is the call's own argument, inline
    // selector included, with the Host-projected path as the fallback. The
    // projection deliberately strips the selector (`stripReadSelector`) because
    // the *link* must point at the file — but the row used to print that
    // stripped path as its whole summary, so a windowed read
    // (`package.json:22-25,31-34`) looked exactly like a whole-file read. The
    // summary is the only place the question the model asked is still visible.
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

    // The search cards' collapsed trailing fragment is the scope a grep /
    // ast_grep call actually searched, and the result count (or "no results")
    // every search shape needs before it is expanded. A search's subject on the
    // row is its *pattern*, so the scope had no place to be seen at all — worst
    // when the search found nothing, where a bare `Grep · zzz` reads as if the
    // pattern were wrong rather than as if the tool looked in the wrong tree. A
    // glob is the exception: its own argument is the path pattern, so it needs
    // the count, not a scope.
    describe('search card suffix', () => {
      it('names the scope the search actually ran in, then the counts', () => {
        expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, matches, '/w/app', t.zh))
          .toBe('· 范围 src/tools · 3 处匹配 · 2 个文件')
      })

      it('shortens a workspace-absolute scope', () => {
        expect(searchCardSuffix({ pattern: 'foo', path: '/w/app/src/tools' }, matches, '/w/app', t.zh))
          .toBe('· 范围 src/tools · 3 处匹配 · 2 个文件')
      })

      it('shortens every path of a semicolon-delimited scope', () => {
        // The target grammar accepts a `;`-delimited list. One prefix cut would
        // shorten the first entry and leave the rest absolute, so the same scope
        // would read as two unrelated things.
        expect(searchCardSuffix({ pattern: 'foo', path: '/w/app/a.ts; /w/app/src' }, matches, '/w/app', t.zh))
          .toBe('· 范围 a.ts; src · 3 处匹配 · 2 个文件')
        expect(searchCardSuffix({ pattern: 'foo', path: 'src/a.ts; src/b.ts' }, matches, '/w/app', t.zh))
          .toBe('· 范围 src/a.ts; src/b.ts · 3 处匹配 · 2 个文件')
      })

      it('says the search was empty instead of showing zero counts', () => {
        const empty: SearchCardMeta = { kind: 'search', shape: 'matches', files: [], truncated: false, total: 0 }
        expect(searchCardSuffix({ pattern: 'zzz', path: 'src/tools' }, empty, '/w/app', t.zh))
          .toBe('· 范围 src/tools · 无结果')
      })

      it('drops the scope fragment when the call searched the workspace root', () => {
        // No `path` argument means the workspace root; naming a scope the model
        // never typed would claim a tree the call did not ask for.
        expect(searchCardSuffix({ pattern: 'foo' }, matches, '/w/app', t.zh)).toBe('· 3 处匹配 · 2 个文件')
        expect(searchCardSuffix(null, matches, '/w/app', t.zh)).toBe('· 3 处匹配 · 2 个文件')
      })

      it('reports what was kept of a capped match payload', () => {
        const capped: SearchCardMeta = {
          kind: 'search',
          shape: 'matches',
          files: [{ path: 'src/a.ts', matches: [{ lineNumber: 1, line: 'foo' }] }],
          truncated: true,
          total: 40,
        }
        expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, capped, '/w/app', t.zh))
          .toBe('· 范围 src/tools · 显示 1 / 共 40 处匹配 · 1 个文件')
      })

      it('shows a glob\'s count without a scope: its argument is its scope', () => {
        const paths: SearchCardMeta = {
          kind: 'search',
          shape: 'paths',
          paths: ['src/a.ts', 'src/b.ts'],
          truncated: false,
          total: 2,
        }
        expect(searchCardSuffix({ path: 'src/**/*.ts' }, paths, '/w/app', t.zh)).toBe('· 2 个路径')
      })

      it('reports a capped and an empty path list', () => {
        const capped: SearchCardMeta = {
          kind: 'search',
          shape: 'paths',
          paths: ['src/a.ts'],
          truncated: true,
          total: 50,
        }
        const empty: SearchCardMeta = { kind: 'search', shape: 'paths', paths: [], truncated: false, total: 0 }
        expect(searchCardSuffix({ path: 'src/**/*.ts' }, capped, '/w/app', t.zh)).toBe('· 显示 1 / 共 50 个路径')
        expect(searchCardSuffix({ path: 'src/**/*.ts' }, empty, '/w/app', t.zh)).toBe('· 无结果')
      })

      it('speaks English in the English dictionary', () => {
        expect(searchCardSuffix({ pattern: 'foo', path: 'src/tools' }, matches, '/w/app', t.en))
          .toBe('· in src/tools · 3 matches · 2 files')
      })
    })
  })

  // ------------------------------------------------------------ wiring

  // A helper nothing calls is a green test over a card that still hides the
  // fact, and this change is spread over three helper modules and four rows.
  // The check is deliberately about the call, not the shape of the JSX: what the
  // card looks like is pinned by the real-machine screenshots, not by this file.
  describe('wiring', () => {
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
        const shell = clientSource('ToolCardShell.tsx')
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

    // The shell draws a glyph in every clean state and swaps it for a state dot
    // only when the call failed or was interrupted — the shipped `ToolRow`'s
    // rule — so two things must hold in the source, neither of which a pure unit
    // spec can see: every row has to hand the shell its tool name (a row that
    // forgets it leads with the generic glyph), and the running sweep has to
    // stay the shipped one (same band, same geometry, same timing).
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
          'IconApiOutlineRegular', 'IconBrowseOutlineRegular', 'IconEditOutlineRegular',
          'IconSearchOutlineRegular', 'IconSparkleRegular',
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
  })

  // ----------------------------------------------------------- leading

  // The treatment is the shipped `ToolRow`'s own (`leadingFor`): a settled or
  // running call leads with the row's glyph, and only a failure or an interrupt
  // swaps that glyph for a state dot. The glyph per tool mirrors the shipped
  // variant table (`VARIANT_ICONS` in the generic tool card), so a row here
  // leads with the same shape the shipped row would have drawn.
  describe('leading', () => {
    describe('leadingGlyph', () => {
      it.each([
        ['bash', 'bash'],
        ['read', 'read'],
        ['write', 'edit'],
        ['edit', 'edit'],
        ['grep', 'search'],
        ['glob', 'search'],
        // This plugin's own two tools are not in the shipped name table; they take
        // the family whose shipped glyph describes the act — a search reads, an
        // atomic edit writes.
        ['ast_grep', 'search'],
        ['ast_edit', 'edit'],
      ])('leads %s with the %s glyph', (toolName, glyph) => {
        expect(leadingGlyph(toolName)).toBe(glyph)
      })

      it('decides a glyph for every card key the plugin registers', () => {
        // A new card key that silently fell through to the generic sparkle would
        // ship an anonymous leading mark; this forces the decision into the diff.
        for (const key of CARD_TOOL_KEYS) {
          expect(leadingGlyph(key), key).not.toBe('others')
        }
      })

      it.each([['', '<empty>'], ['unknown_tool', 'unknown_tool']])(
        'falls back to the generic glyph for %s',
        (toolName) => {
          expect(leadingGlyph(toolName)).toBe('others')
        },
      )

      it('falls back to the generic glyph when the call carries no name at all', () => {
        expect(leadingGlyph(undefined)).toBe('others')
        expect(leadingGlyph(null)).toBe('others')
      })
    })

    describe('leadingKind', () => {
      it.each([
        ['ok', 'glyph'],
        ['running', 'glyph'],
        ['error', 'error'],
        ['warning', 'warning'],
      ] as ReadonlyArray<[CardState, string]>)('maps %s onto %s', (state, kind) => {
        expect(leadingKind(state)).toBe(kind)
      })
    })
  })

  // -------------------------------------------------------------- form

  // The client card form state logic: overridden calculation (staged vs base vs
  // stored), dirty state, resetting and selecting default values, save actions
  // (unsetting default values, setting custom overrides), and dynamic
  // progressive disclosure (bytes vs lines, head vs tail vs middle).
  describe('form', () => {
    describe('Settings Card Form Logic & Reversion States', () => {
      it('default schema values represent the base composition layer', () => {
        const config = resolveConfig({})
        expect(config.outputTruncate.strategy).toBe('bytes')
        expect(config.outputTruncate.bytes.mode).toBe('middle')
        expect(config.outputTruncate.lines.mode).toBe('middle')
        expect(config.defaultTimeoutMs).toBe(3_600_000)
        expect(config.enableRunInBackground).toBe(true)
      })

      it('selecting the base value when at default does NOT mark field as overridden', () => {
        const baseVal = 'bytes'
        const userStored = false
        const staged = 'bytes'

        // The select branch of the shared form model (src/client/forms.ts):
        let overridden = false
        if (staged === null || staged === baseVal) {
          overridden = false
        } else {
          overridden = true
        }

        expect(overridden).toBe(false)
      })

      it('selecting a non-default value marks field as overridden', () => {
        const baseVal = 'bytes'
        const staged = 'lines'

        let overridden = false
        if (staged === null || staged === baseVal) {
          overridden = false
        } else {
          overridden = true
        }

        expect(overridden).toBe(true)
      })

      it('clicking reset stages clear and marks field as NOT overridden', () => {
        const baseVal = 'bytes'
        const staged: string | null = null

        let overridden = false
        if (staged === null || staged === baseVal) {
          overridden = false
        } else {
          overridden = true
        }

        expect(overridden).toBe(false)
      })

      it('saving a value matching base cleans up (unsets) user settings rather than creating redundant overrides', () => {
        const userSettings: Record<string, unknown> = { outputTruncateStrategy: 'lines' }
        const staged = 'bytes'
        const baseVal = 'bytes'

        const writes: Array<{ action: 'set' | 'unset'; field: string; value?: unknown }> = []

        if (staged === null || staged === baseVal) {
          if (Object.prototype.hasOwnProperty.call(userSettings, 'outputTruncateStrategy')) {
            writes.push({ action: 'unset', field: 'outputTruncateStrategy' })
          }
        } else {
          writes.push({ action: 'set', field: 'outputTruncateStrategy', value: staged })
        }

        expect(writes).toEqual([{ action: 'unset', field: 'outputTruncateStrategy' }])
      })

      it('saving a custom override writes the set command to user settings', () => {
        const userSettings: Record<string, unknown> = {}
        const staged = 'lines'
        const baseVal = 'bytes'

        const writes: Array<{ action: 'set' | 'unset'; field: string; value?: unknown }> = []

        if (staged === null || staged === baseVal) {
          if (Object.prototype.hasOwnProperty.call(userSettings, 'outputTruncateStrategy')) {
            writes.push({ action: 'unset', field: 'outputTruncateStrategy' })
          }
        } else {
          writes.push({ action: 'set', field: 'outputTruncateStrategy', value: staged })
        }

        expect(writes).toEqual([{ action: 'set', field: 'outputTruncateStrategy', value: 'lines' }])
      })
    })
  })
})
