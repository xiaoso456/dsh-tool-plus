/**
 * P0-3: `ast_grep` gained the `lang` override in OMP 18.12.6.
 *
 * The native side already accepted `lang` (`AstFindOptions.lang`, with
 * `resolve_language` preferring it over extension inference), so this was a
 * TypeScript-layer gap: the OMP schema, both native call sites, the DSH adapter
 * parameter table, and the prompt all had to carry it.
 *
 * The discriminating assertion is the parser swap: a C++ `.h` file matches a
 * C++ pattern with no `lang`, and the *same* file reports a parse error under
 * `lang: "typescript"`. Only a real pass-through can change the parser under a
 * file whose extension is unchanged, and unlike "it still matches", it cannot
 * pass by accident.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Settings } from '../../src/tools/omp/config/settings.ts'
import { getDefault } from '../../src/tools/omp/config/settings-schema.ts'
import { AstGrepTool } from '../../src/tools/omp/tools/ast-grep.ts'
import { registerAstGrep } from '../../src/tools/ast-grep/adapter/index.ts'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tp-ast-grep-lang-'))
  writeFileSync(path.join(dir, 'sample.h'), 'int alpha = 1;\nint beta = 2;\n')
  writeFileSync(path.join(dir, 'sample.ts'), 'const gamma = 3;\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const session = (): unknown => {
  const settings = new Settings({} as never, getDefault)
  return { cwd: dir, settings, enableLsp: false, hasEditTool: true }
}

const runGrep = async (params: Record<string, unknown>): Promise<string> => {
  const tool = new AstGrepTool(session() as never)
  const result = (await tool.execute('call', params as never, undefined)) as {
    content: Array<{ type: string; text?: string }>
  }
  return result.content.map(block => block.text ?? '').join('')
}

describe('P0-3: lang override reaches the native parser', () => {
  it('infers from the extension when lang is omitted', async () => {
    const text = await runGrep({ pat: 'int $NAME = $VAL;', path: 'sample.h' })
    expect(text).toContain('int alpha = 1;')
    expect(text).toContain('int beta = 2;')
  })

  it('accepts an explicit matching lang without changing the result', async () => {
    const text = await runGrep({ pat: 'int $NAME = $VAL;', path: 'sample.h', lang: 'cpp' })
    expect(text).toContain('int alpha = 1;')
    expect(text).not.toContain('parse error')
  })

  it('swaps the parser for the same file when lang disagrees', async () => {
    // Same bytes, same extension: only a real override can force the TS parser,
    // which then rejects C++ source. Without the pass-through this would match.
    const text = await runGrep({ pat: 'const $NAME = $VAL', path: 'sample.h', lang: 'typescript' })
    expect(text).toContain('No matches found')
    expect(text).toContain('sample.h: parse error')
  })

  it('applies the override across a multi-target search', async () => {
    const text = await runGrep({ pat: 'int $NAME = $VAL;', path: 'sample.h; sample.ts', lang: 'cpp' })
    expect(text).toContain('int alpha = 1;')
    // The TypeScript file is scanned as C++ and reports a parse issue instead of
    // being silently skipped.
    expect(text).toContain('sample.ts: parse error')
  })
})

describe('P0-3: unsupported languages fail loudly', () => {
  it('names the unsupported language instead of returning empty results', async () => {
    const text = await runGrep({ pat: 'int $NAME = $VAL;', path: 'sample.h', lang: 'definitely-not-a-lang' })
    expect(text).toContain('Unsupported language')
    expect(text).toContain('definitely-not-a-lang')
  })
})

describe('P0-3: built-in grammars never trigger a download note', () => {
  it('stays quiet for cpp and typescript', async () => {
    const cpp = await runGrep({ pat: 'int $NAME = $VAL;', path: 'sample.h', lang: 'cpp' })
    const ts = await runGrep({ pat: 'const $NAME = $VAL', path: 'sample.ts', lang: 'typescript' })
    // missingGrammarsNote() would read "Skipped ... grammar could not be downloaded";
    // built-in languages carry grammars inside the addon, so it must never appear.
    expect(cpp).not.toContain('grammar could not be downloaded')
    expect(ts).not.toContain('grammar could not be downloaded')
  })
})

describe('P0-3: the DSH adapter exposes lang to the model', () => {
  interface CapturedTool {
    // defineTool compiles the per-property map into a JSON Schema object.
    parameters: {
      type?: string
      properties?: Record<string, { type?: string }>
      required?: string[]
    }
    description: string
  }

  const capture = (): CapturedTool => {
    let captured: CapturedTool | undefined
    const ctx = {
      tools: {
        register: (definition: CapturedTool) => {
          captured = definition
          return () => {}
        },
      },
    }
    registerAstGrep(ctx as never, () => ({ astGrepEnabled: true }) as never)
    if (!captured) throw new Error('registerAstGrep did not register a tool')
    return captured
  }

  it('declares lang alongside pat/path/skip', () => {
    const tool = capture()
    expect(tool.parameters.type).toBe('object')
    expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual(['lang', 'pat', 'path', 'skip'])
    expect(tool.parameters.properties?.lang?.type).toBe('string')
    // Optional: only pat is required, so `lang` may be omitted.
    expect(tool.parameters.required).toEqual(['pat'])
  })

  it('documents the override in the model-facing description', () => {
    const tool = capture()
    expect(tool.description).toContain('lang')
    expect(tool.description).toContain('.cu')
  })
})
