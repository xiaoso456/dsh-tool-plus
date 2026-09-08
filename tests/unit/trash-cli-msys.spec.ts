/**
 * rmSafe: MSYS drive-alias path handling in trash-cli (win32).
 *
 * The bash session redefines `rm` as `node trash-cli.mjs "$@"`, so the argv
 * arrives exactly as authored in the shell — including MSYS drive aliases like
 * `/d/code/foo`. Node's fs resolves a leading `/d/…` as `<current-drive>:\d\…`
 * (root-relative), NOT `D:\…`, so an unconverted path silently targets the
 * wrong directory (misdeletion risk whenever that stray directory exists).
 * The CLI must convert drive aliases to native paths before any fs/trash call
 * while keeping the authored spelling in verbose/error messages (Git-bash rm
 * prints what the user typed).
 * @module tests
 */
import { describe, expect, it } from 'vitest'
import { runTrashCli } from '../../src/tools/bash/trash-cli.ts'
import { makeDeps } from '../helpers/trash-deps.ts'

const IS_WIN32 = process.platform === 'win32'

describe('trash-cli MSYS drive-alias paths', () => {
  it('passes the native drive path to lstat/trash, keeps the authored spelling in verbose output', async () => {
    const lstatCalls: string[] = []
    const h = makeDeps({
      lstat: async (p) => {
        lstatCalls.push(p)
        return { isDirectory: false }
      },
    })
    await runTrashCli(['-v', '/d/code/probe.txt'], h.deps)
    const native = IS_WIN32 ? 'D:\\code\\probe.txt' : '/d/code/probe.txt'
    expect(lstatCalls).toEqual([native])
    expect(h.trashCalls).toEqual([[native]])
    expect(h.code()).toBe(0)
    expect(h.out).toEqual(["removed '/d/code/probe.txt'"])
    expect(h.err).toHaveLength(0)
  })

  it('reports a missing MSYS path using the authored spelling', async () => {
    const h = makeDeps()
    await runTrashCli(['/d/code/missing-probe-xyz'], h.deps)
    expect(h.code()).toBe(1)
    expect(h.err.join('\n')).toContain("rm: cannot remove '/d/code/missing-probe-xyz': No such file or directory")
  })

  it('converts mixed-form entries in one call independently', async () => {
    const lstatCalls: string[] = []
    const h = makeDeps({
      lstat: async (p) => {
        lstatCalls.push(p)
        return { isDirectory: false }
      },
    })
    await runTrashCli(['/d/code/a.txt', 'D:/code/b.txt', 'rel.txt'], h.deps)
    // Only MSYS aliases are converted; the drive-letter + forward-slash form and
    // relative paths are already natively consumable by Node's fs.
    const expectedA = IS_WIN32 ? 'D:\\code\\a.txt' : '/d/code/a.txt'
    const expectedB = 'D:/code/b.txt'
    const expectedRel = 'rel.txt'
    expect(lstatCalls).toEqual([expectedA, expectedB, expectedRel])
    expect(h.trashCalls).toEqual([[expectedA, expectedB, expectedRel]])
  })
})