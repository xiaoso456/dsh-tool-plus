/**
 * rmSafe 测试共享依赖工厂：fake trash + 真实文件系统 lstat/stat。
 * 供 trash-cli.spec.ts 与 trash-cli-coreutils.spec.ts 复用（避免复制）。
 */
import * as fs from 'node:fs'
import type { TrashCliDeps } from '../../src/tools/bash/trash-cli.ts'

export interface TrashDepsHarness {
  deps: TrashCliDeps
  trashCalls: string[][]
  out: string[]
  err: string[]
  code: () => number | null
}

export function makeDeps(overrides: Partial<TrashCliDeps> = {}): TrashDepsHarness {
  const trashCalls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  let code: number | null = null
  const deps: TrashCliDeps = {
    trash: async (paths) => {
      trashCalls.push(paths)
    },
    lstat: async (p) => {
      try {
        const st = fs.lstatSync(p)
        return { isDirectory: st.isDirectory() }
      } catch {
        return null
      }
    },
    stat: async (p) => {
      try {
        const st = fs.statSync(p)
        return { dev: st.dev, ino: st.ino }
      } catch {
        return null
      }
    },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    exit: (c) => {
      code = c
    },
    ...overrides,
  }
  return { deps, trashCalls, out, err, code: () => code }
}
