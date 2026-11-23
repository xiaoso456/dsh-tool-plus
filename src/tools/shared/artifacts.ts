/**
 * Artifacts directory for the OMP engines' URL path.
 *
 * Upstream `ToolSession.getArtifactsDir()` points at the host's per-session
 * artifact store. DSH has no such store (the bash tool's spill mirror solved the
 * same gap the same way), so this module provides the seam over the plain Node
 * filesystem: a single shared directory under `<tmpdir>`, created on demand.
 *
 * Only readers that must hand a fetched page to a path-based tool use it
 * (`grep` over a URL writes the rendered body to `<dir>/url-search/<hash>.<ext>`).
 * Names are content-derived, so repeated reads of the same URL reuse one file
 * instead of growing the directory; {@link sweepStaleArtifacts} bounds the rest.
 *
 * @module @xiaoso/dsh-tool-plus/shared/artifacts
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Shared artifacts root (one directory per session lives beneath it). */
export function artifactsRoot(): string {
  return path.join(os.tmpdir(), 'dsh-tool-plus-artifacts')
}

/**
 * Resolve (and create) one session's artifacts directory. Returns `null` when the
 * directory cannot be created (read-only tmp, exotic sandbox): callers treat
 * that as "this session cannot materialize artifacts" and degrade with an
 * explanation instead of throwing an unrelated IO error.
 *
 * Upstream keys artifacts off the session journal (`session.jsonl` minus the
 * suffix), so every session gets its own directory beside its transcript. DSH
 * does not expose that path to plugins, so the session id reproduces the same
 * property: one directory per session, nothing shared between sessions.
 */
export function ensureArtifactsDir(sessionId: string): string | null {
  try {
    const dir = path.join(artifactsRoot(), sanitizeSessionId(sessionId))
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** Keep a session id usable as a single path segment (`:` and `\\` are illegal on Windows). */
function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  return cleaned.length > 0 ? cleaned : 'anonymous'
}

/** Age after which an artifact is considered orphaned. */
const STALE_MS = 24 * 60 * 60 * 1000

/**
 * Best-effort sweep of artifacts older than 24h (matches the bash spill sweep).
 * Never throws; returns the number of files removed.
 */
export function sweepStaleArtifacts(now: number = Date.now()): number {
  const root = artifactsRoot()
  let removed = 0
  const sweepDir = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        sweepDir(full)
        // A session directory that lost all its files is residue — but only once
        // it has been empty for a full stale window. A just-created directory is
        // empty too, and a concurrent plugin apply() must not delete the
        // directory a live session is about to write into (the artifacts-seam
        // spec covers exactly that race).
        try {
          if (full !== root && fs.readdirSync(full).length === 0 && now - fs.statSync(full).mtimeMs > STALE_MS) fs.rmdirSync(full)
        } catch {
          /* ignore */
        }
        continue
      }
      try {
        if (now - fs.statSync(full).mtimeMs > STALE_MS) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {
        /* ignore */
      }
    }
  }
  sweepDir(root)
  return removed
}
