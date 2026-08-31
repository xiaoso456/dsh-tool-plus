/**
 * rmSafe CLI 入口（构建产物 lib/trash-cli.mjs，被注入的 bash `rm()` 函数调用）。
 *
 * trash 包在此动态加载：单测只 import trash-cli.ts（纯逻辑），
 * 不会触发 trash 依赖解析。
 * @module @xiaoso/dsh-tool-plus/bash/trash-cli-main
 */
import * as fs from 'node:fs'
import { runTrashCli } from './trash-cli.ts'

async function main(): Promise<void> {
  const { default: trash } = await import('trash')
  const argv = process.argv.slice(2)
  await runTrashCli(argv, {
    trash,
    lstat: async (p) => {
      try {
        const st = await fs.promises.lstat(p)
        return { isDirectory: st.isDirectory() }
      } catch {
        return null
      }
    },
    stat: async (p) => {
      try {
        const st = await fs.promises.stat(p)
        return { dev: st.dev, ino: st.ino }
      } catch {
        return null
      }
    },
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    exit: (c) => {
      process.exitCode = c
    },
  })
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
