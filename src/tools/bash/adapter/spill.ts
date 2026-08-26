/**
 * Spill-file lifecycle for the bash tool, adapted from OMP's session artifact
 * seam (`session.allocateOutputArtifact("bash")` + `saveBashOriginalArtifact`)
 * to the plain Node filesystem: spill files live under `<tmpdir>/dsh-bash-spill/`,
 * one unique file per call, written losslessly by the executor's OutputSink
 * `artifactPath` mirror. A best-effort sweep removes files older than 24h
 * (including the legacy flat `dsh-bash-*.log` naming from before this module),
 * so orphaned captures do not accumulate across restarts.
 * @module @xiaoso/dsh-tool-plus/bash/adapter/spill
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Directory holding all bash spill files. */
export function spillDir(): string {
  return path.join(os.tmpdir(), 'dsh-bash-spill')
}

/** Age after which a spill file is considered orphaned and swept. */
const STALE_MS = 24 * 60 * 60 * 1000

/**
 * Allocate one unique spill file path for a call. The directory is created on
 * first use; allocation failure (read-only tmp, exotic sandbox) returns
 * `undefined` and the caller simply runs without a spill mirror.
 */
export function allocateSpillFile(): string | undefined {
  return allocate('dsh-bash-spill')
}

/**
 * Allocate one unique file for a minimizer original capture (upstream
 * `saveBashOriginalArtifact`). Same failure semantics as {@link allocateSpillFile}.
 */
export function allocateOriginalFile(): string | undefined {
  return allocate('dsh-bash-original')
}

function allocate(kind: string): string | undefined {
  try {
    fs.mkdirSync(spillDir(), { recursive: true })
    return path.join(spillDir(), `${kind}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.log`)
  } catch {
    return undefined
  }
}

/**
 * Write pre-minimization original text to a fresh file.
 * Returns the path, or `undefined` when the write failed.
 */
export function saveOriginalText(text: string): string | undefined {
  const target = allocateOriginalFile()
  if (target === undefined) return undefined
  try {
    fs.writeFileSync(target, text, 'utf-8')
    return target
  } catch {
    try { fs.unlinkSync(target) } catch { /* ignore */ }
    return undefined
  }
}

/**
 * Best-effort sweep of orphaned spill files: everything under the spill dir
 * plus the legacy flat `tmpdir/dsh-bash-*.log` files older than 24h. Never
 * throws; returns the number of files removed.
 */
export function sweepStaleSpillFiles(now: number = Date.now()): number {
  let removed = 0
  const sweepOne = (file: string): void => {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) return
      if (now - stat.mtimeMs > STALE_MS) {
        fs.unlinkSync(file)
        removed++
      }
    } catch { /* ignore */ }
  }
  try {
    for (const entry of fs.readdirSync(spillDir())) sweepOne(path.join(spillDir(), entry))
  } catch { /* dir absent — nothing to sweep */ }
  try {
    const tmp = os.tmpdir()
    for (const entry of fs.readdirSync(tmp)) {
      // Legacy naming from the pre-spill-dir FullOutputWriter era.
      if (/^dsh-bash-[0-9a-f]{8}\.log$/.test(entry)) sweepOne(path.join(tmp, entry))
    }
  } catch { /* ignore */ }
  return removed
}
