/**
 * DSH write tool — OMP port (minimal, plan.md §2)
 *
 * Keeps: auto mkdir, shebang chmod +x, hashline patch write (§2 keep),
 * conflict write (§2 keep), archive/sqlite write (stub → normal write),
 * auto-generated guard (§2 keep).
 * Removes: LSP, mutation version, ACP, streaming progress, plan-mode guard,
 * vault://, local:// (plan.md §2 removes).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  archiveFormatFromPath,
  parseArchivePathCandidates,
  readArchiveEntries,
  writeArchive,
} from '../shared/archive/zip'
import {
  deleteRowByKey,
  deleteRowByRowId,
  insertRow,
  isSqliteFile,
  parseSqlitePathCandidates,
  resolveTableRowLookup,
  updateRowByKey,
  updateRowByRowId,
} from '../shared/sqlite-reader'
import { ToolError } from '../shared/tool-errors'
// Auto-generated guard — the DSH-adapted Node copy (the OMP original reads
// file headers through Bun.file, which silently no-ops under Node).
import { assertEditableFile, assertEditableFileContent } from '../shared/auto-generated-guard.dsh.ts'

// OMP write.ts normalizeArchiveWriteSubPath (verbatim semantics): reject empty
// / directory / `..` member paths, collapse `.` segments, forward-slash join.
function normalizeArchiveWriteSubPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.length === 0) throw new Error('Archive write path must target a file inside the archive')
  if (normalized.endsWith('/')) throw new Error('Archive write path must target a file, not a directory')
  const parts = normalized.split('/')
  const normalizedParts: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error("Archive path cannot contain '..'")
    normalizedParts.push(part)
  }
  if (normalizedParts.length === 0) throw new Error('Archive write path must target a file inside the archive')
  return normalizedParts.join('/')
}

// Hashline header: [path#HASH] 4-hex hash used by OMP read anchors.
const HASHLINE_HEADER_RE = /^\s*\[[^\]#\r\n]+#[0-9A-Fa-f]{4}\]\s*$/m

// ── SQLite row writes (OMP write.ts #resolveSqliteWritePath/#writeSqliteRow) ──

interface ResolvedSqliteWritePath {
  realPath: string
  displayPath: string
  table: string
  key?: string
  exists: boolean
}

/** OMP parseSqliteWriteTarget (verbatim semantics): `table` or `table:key`, no query params. */
export function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
  if (queryString.trim().length > 0) {
    throw new ToolError('SQLite write paths do not support query parameters')
  }
  const normalized = subPath.replace(/^:+/, '').trim()
  if (!normalized) {
    throw new ToolError('SQLite write path must target a table')
  }
  const separatorIndex = normalized.indexOf(':')
  const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex)
  const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1)
  if (!table) {
    throw new ToolError('SQLite write path must target a table')
  }
  if (key !== undefined && key.length === 0) {
    throw new ToolError('SQLite row writes require a non-empty row key')
  }
  return { table, key }
}

export async function resolveSqliteWritePath(
  ctx: any,
  writePath: string,
  cwd: string,
): Promise<ResolvedSqliteWritePath | null> {
  const candidates = parseSqlitePathCandidates(writePath).filter((c: any) => c.sqlitePath !== writePath)
  if (candidates.length === 0) return null

  const fallbackCandidate = candidates[candidates.length - 1]!
  const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString)
  const fallbackAbs = path.isAbsolute(fallbackCandidate.sqlitePath)
    ? fallbackCandidate.sqlitePath
    : path.join(cwd, fallbackCandidate.sqlitePath)
  const fallback: ResolvedSqliteWritePath = {
    realPath: fallbackAbs,
    displayPath: fallbackCandidate.sqlitePath,
    table: fallbackTarget.table,
    key: fallbackTarget.key,
    exists: false,
  }

  let sawExistingNonSqlite = false
  for (const candidate of candidates) {
    const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString)
    let realPath: string
    try {
      const t = await ctx.fs.resolve(candidate.sqlitePath, { cwd })
      realPath = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(t) : ((t as any).displayPath ?? candidate.sqlitePath)
      const info = await ctx.fs.stat(t)
      if (info?.type === 'directory') continue
      if (!(await isSqliteFile(realPath))) {
        sawExistingNonSqlite = true
        continue
      }
      return { realPath, displayPath: candidate.sqlitePath, table: target.table, key: target.key, exists: true }
    } catch (e: any) {
      const code = e?.code ?? e?.cause?.code
      // dsh-fs maps ENOENT to FS_NOT_FOUND; both mean "candidate doesn't exist".
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'FS_NOT_FOUND') continue
      if (typeof e?.message === 'string' && /not found/i.test(e.message)) continue
      throw e
    }
  }

  if (sawExistingNonSqlite) return null
  return fallback
}

/** OMP #writeSqliteRow: empty content + key deletes, JSON object updates (key) or inserts. */
export async function writeSqliteRow(
  displayPath: string,
  content: string,
  resolved: ResolvedSqliteWritePath,
): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite')
  if (!resolved.exists) {
    throw new ToolError(`SQLite database '${displayPath}' not found`)
  }
  const db = new DatabaseSync(resolved.realPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const trimmed = content.trim()
    if (trimmed.length === 0) {
      if (!resolved.key) {
        throw new ToolError('SQLite deletes require a row key in the path')
      }
      const lookup = resolveTableRowLookup(db, resolved.table)
      const deleted =
        lookup.kind === 'pk'
          ? deleteRowByKey(db, resolved.table, lookup, resolved.key)
          : deleteRowByRowId(db, resolved.table, resolved.key)
      return deleted > 0
        ? `Deleted row '${resolved.key}' from ${resolved.table}`
        : `No row deleted from ${resolved.table} for key '${resolved.key}'`
    }

    // OMP parsed JSON5 via Bun.JSON5; the Node port accepts strict JSON.
    let parsedContent: unknown
    try {
      parsedContent = JSON.parse(content)
    } catch (error) {
      throw new ToolError(
        `SQLite write content must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (typeof parsedContent !== 'object' || parsedContent === null || Array.isArray(parsedContent)) {
      throw new ToolError('SQLite write content must be a JSON object')
    }

    if (resolved.key) {
      const lookup = resolveTableRowLookup(db, resolved.table)
      const updated =
        lookup.kind === 'pk'
          ? updateRowByKey(db, resolved.table, lookup, resolved.key, parsedContent as Record<string, unknown>)
          : updateRowByRowId(db, resolved.table, resolved.key, parsedContent as Record<string, unknown>)
      return updated > 0
        ? `Updated row '${resolved.key}' in ${resolved.table}`
        : `No row updated in ${resolved.table} for key '${resolved.key}'`
    }
    insertRow(db, resolved.table, parsedContent as Record<string, unknown>)
    return `Inserted row into ${resolved.table}`
  } catch (e: any) {
    if (e instanceof ToolError) throw e
    const code = e?.code ?? e?.cause?.code
    if (code === 'ENOENT') throw new ToolError(`SQLite database '${displayPath}' not found`)
    throw new ToolError(e instanceof Error ? e.message : String(e))
  } finally {
    db.close()
  }
}

// conflict://<id> | conflict://*  optionally /scope
const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/

function parseConflictUri(raw: string): { id: number | '*', scope?: string, recoveredPrefix?: string } | null {
  const m = raw.match(CONFLICT_URI_RE)
  if (!m) return null
  const recoveredPrefix = m[1]
  const tail = m[2]!
  const slash = tail.indexOf('/')
  const idPart = slash === -1 ? tail : tail.slice(0, slash)
  const scopePart = slash === -1 ? undefined : tail.slice(slash + 1)
  if (idPart === '*') {
    if (scopePart !== undefined) throw new Error(`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment.`)
    return recoveredPrefix !== undefined ? { id: '*', recoveredPrefix } : { id: '*' }
  }
  if (!/^\d+$/.test(idPart)) throw new Error(`Invalid conflict URI '${raw}': must be 'conflict://<N>' or 'conflict://*'`)
  const id = Number.parseInt(idPart, 10)
  if (id < 1) throw new Error(`Invalid conflict URI '${raw}': id must be >=1`)
  const scope = scopePart as string | undefined
  if (scope && !['ours', 'theirs', 'base'].includes(scope)) throw new Error(`Invalid conflict URI '${raw}': scope must be ours/theirs/base`)
  return recoveredPrefix !== undefined ? { id, scope, recoveredPrefix } : { id, scope }
}

/** OMP auto-generated guard: content-header check + existing-file header check. */
async function tryAutoGeneratedGuard(filePath: string, content: string, absolutePath: string): Promise<void> {
  assertEditableFileContent(content, filePath)
  await assertEditableFile(absolutePath, filePath)
}

async function maybeMarkExecutable(fsPath: string, content: string): Promise<boolean> {
  if (!content.startsWith('#!')) return false
  try {
    const st = await fs.stat(fsPath)
    const cur = (st.mode & 0o7777)
    const next = cur | 0o111
    if (next === cur) return false
    await fs.chmod(fsPath, next)
    return true
  } catch {
    return false
  }
}

async function handleConflictWrite(
  ctx: any,
  target: any,
  displayPath: string,
  content: string,
  conflictId: number | '*',
  signal?: AbortSignal,
): Promise<any> {
  // Minimal conflict handling: read current file, expand @ours/@theirs tokens,
  // and splice. This mirrors OMP's spliceConflict but without session history.
  // For bulk '*' we require explicit per-id directives or uniform content —
  // delegate to shared/conflict-detect if available.
  try {
    const mod: any = await import('../shared/conflict-detect.ts')
    if (mod && typeof mod.spliceConflict === 'function' && typeof mod.expandContentTokens === 'function') {
      // Try to use shared implementation with a synthetic history built from
      // scanning the file. This covers single-id writes without prior read.
      const currentText: string = await ctx.fs.readText(target, signal)
      const lines = currentText.split('\n')
      const blocks = mod.scanConflictLines ? mod.scanConflictLines(lines, 1) : []
      if (conflictId === '*') {
        // Bulk: apply content as uniform replacement for all blocks if no
        // per-id directives present. For per-id directives, splice each.
        // Simplified: uniform bulk replace all blocks with content.
        let text = currentText
        // Apply bottom-up to keep anchors valid
        const sorted = [...blocks].sort((a: any, b: any) => b.startLine - a.startLine)
        for (const block of sorted) {
          const entry = { ...block, absolutePath: displayPath, displayPath, id: block.startLine }
          const expanded = mod.expandContentTokens(content, entry)
          const res = mod.spliceConflict(text, entry, expanded)
          text = res.text
        }
        return { text, blocks: sorted.length }
      } else {
        const entry = blocks.find((b: any, idx: number) => idx + 1 === conflictId || b.startLine === conflictId)
        // Fallback: pick by 1-based order
        const chosen = blocks[conflictId as number - 1] ?? entry
        if (!chosen) throw new Error(`Conflict #${conflictId} not found — re-read the file to surface conflict markers.`)
        const synthetic = { ...chosen, absolutePath: displayPath, displayPath, id: conflictId }
        const expanded = mod.expandContentTokens(content, synthetic)
        const res = mod.spliceConflict(currentText, synthetic, expanded)
        return { text: res.text, blocks: 1 }
      }
    }
  } catch (e: any) {
    if (e && e.name === 'ToolError') throw e
    // fall through to plain write if shared module unavailable
  }
  throw new Error(`conflict://${conflictId} write requires conflict markers in the target file — re-read the file with conflicts first.`)
}

export function registerWrite(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or overwrite a file with the given content. Parent directories are created automatically. Content may be empty. Archive members ("archive.zip:member/path") rewrite the container; SQLite paths write rows: "db.sqlite:table" inserts the JSON object in content, "db.sqlite:table:key" updates that row, empty content with a key deletes it. Hashline patches ([PATH#HASH] headers) and conflict:// URIs are handled inline.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Destination file path (relative to session cwd or absolute). Supports conflict://<id> for merge-conflict resolution, archive members via "archive.zip:member", SQLite row writes via "db.sqlite[:table[:key]]", and [PATH#HASH] hashline patches in content.' },
      content: { type: 'string', required: true, description: 'Full file content to write (may be empty). For SQLite targets this is a JSON object (insert/update) or empty to delete the keyed row. If it starts with a hashline header [PATH#HASH], it is applied as a hashline patch.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: { type: 'string' },
          after: { type: 'string' },
          madeExecutable: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
      render: (_args: any, value: any) => {
        if (typeof value.detail === 'string' && value.detail.length > 0) {
          return [{ type: 'text', text: value.detail }]
        }
        const op = value.operation ?? 'update'
        const p = value.path ?? _args.file_path
        const extra = value.madeExecutable ? ' [made executable via chmod +x]' : ''
        return [{ type: 'text', text: `Successfully ${op === 'create' ? 'created' : 'wrote'} ${String(value.after ?? '').length} bytes to ${p}${extra}` }]
      },
    },
    async execute(args: { file_path: string; content: string }, exec: any) {
      const filePath = String((args as any).file_path ?? '')
      const content = String((args as any).content ?? '')
      if (filePath.trim().length === 0) throw new Error('file_path must be a non-empty string')

      const cwd: string = exec.agent?.session.header.cwd ?? process.cwd()
      const signal: AbortSignal | undefined = exec.signal
      // Per-call sandbox policy resolved WITH the calling session (mirrors
      // official dsh-tool-fs resolvePolicy): the session's pinned sandbox/mode
      // override (e.g. danger-full-access) must reach the fs backend, else it
      // falls back to the deployment default and denies out-of-root writes.
      const sandboxPolicy: any = (ctx as any).get?.('sandboxPolicy')?.resolve?.({ session: exec?.agent?.session })

      // conflict:// — parse and try to splice via shared/conflict-detect.
      // Without session ConflictHistory we scan the file that contains markers.
      // If we cannot locate the file, surface an actionable error.
      const conflictUri = parseConflictUri(filePath)
      if (conflictUri) {
        if (conflictUri.scope) {
          throw new Error(`Conflict URI scope '/${conflictUri.scope}' is read-only — read conflict://${conflictUri.id}/${conflictUri.scope} to inspect that side. To write, use conflict://${conflictUri.id} and put the chosen content in 'content'.`)
        }
        // If the file was previously read, conflict history would be in
        // shared/conflict-detect's ConflictHistory. Without it we attempt a
        // best-effort locate: look for recoveredPrefix as the file path, else
        // fail with guidance. handleConflictWrite covers the scanned-file path.
        if (conflictUri.recoveredPrefix) {
          const targetFile = conflictUri.recoveredPrefix
          try {
            const target: any = await ctx.fs.resolve(targetFile, { cwd })
            const spliced = await handleConflictWrite(ctx, target, targetFile, content, conflictUri.id, signal)
            await ctx.fs.writeText(target, spliced.text, undefined, signal, sandboxPolicy)
            const after = spliced.text
            // observed emission is handled by dsh-fs-local's write path; also emit explicitly if available
            try { (ctx as any).emit?.('fs/observed', { target, version: after }) } catch {}
            // Lossless JSON only: never emit explicit `undefined` properties.
            return { path: targetFile, operation: 'update' as const, after }
          } catch (e: any) {
            if (e && e.name === 'ToolError') throw e
            // fall through to generic guidance below
          }
        }
        throw new Error(
          `conflict://${conflictUri.id} requires session conflict history — re-read the file(s) containing '<<<<<<<' markers to register conflicts, then write to conflict://<id>. ` +
          (conflictUri.recoveredPrefix ? `Note: stripped erroneous '${conflictUri.recoveredPrefix}:' prefix — use conflict://${conflictUri.id} (no file prefix).` : '')
        )
      }

      // Hashline patch detection: content starts with [PATH#HASH] header(s)
      const looksLikeHashline = HASHLINE_HEADER_RE.test(content)
      if (looksLikeHashline) {
        try {
          // @ts-ignore — hashline engine has Bun types not in tsconfig
          const hl: any = await import('../hashline/omp-hashline/src/index.ts')
          // Prefer Patcher if available
          if (hl.Patcher && hl.Patch) {
            // Build a minimal Filesystem adapter over ctx.fs for the patcher
            const targetForPatch = await ctx.fs.resolve(filePath, { cwd })
            const displayForPatch = (targetForPatch as any).displayPath ?? filePath
            // If content itself carries its own [PATH#HASH] headers, use it as
            // the patch input; otherwise wrap content under the target header.
            const patchInput = content.trimStart().startsWith('[') ? content : `[${filePath}#0000]\n${content}`
            // Minimal snapshot store no-op (hashline will validate)
            const snapshots: any = {
              record: () => '0000',
              byHash: () => null,
              byContent: () => null,
              findByHash: () => [],
              invalidate: () => {},
              relocate: () => {},
            }
            const fsAdapter: any = {
              canonicalPath: (p: string) => path.resolve(cwd, p),
              allowTagPathRecovery: () => false,
              preflightWrite: async () => {},
              readText: async (p: string) => {
                const t = await ctx.fs.resolve(p, { cwd })
                return ctx.fs.readText(t, signal)
              },
              readBinary: undefined,
              writeText: async (p: string, text: string) => {
                const t = await ctx.fs.resolve(p, { cwd })
                const dir = path.dirname((t as any).displayPath ?? p)
                await fs.mkdir(dir, { recursive: true }).catch(() => {})
                const outcome = await ctx.fs.writeText(t, text, undefined, signal, sandboxPolicy)
                return { text, ...outcome }
              },
              delete: async (p: string) => {
                const t = await ctx.fs.resolve(p, { cwd })
                const real = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(t) : (t as any).displayPath
                await fs.rm(real, { force: true })
              },
              move: async (from: string, to: string, text: string) => {
                const tFrom = await ctx.fs.resolve(from, { cwd })
                const tTo = await ctx.fs.resolve(to, { cwd })
                const dir = path.dirname((tTo as any).displayPath ?? to)
                await fs.mkdir(dir, { recursive: true }).catch(() => {})
                await ctx.fs.writeText(tTo, text, undefined, signal, sandboxPolicy)
                const realFrom = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(tFrom) : (tFrom as any).displayPath
                await fs.rm(realFrom, { force: true }).catch(() => {})
              },
            }
            const patcher = new hl.Patcher({ fs: fsAdapter, snapshots })
            const patch = hl.Patch.parse(patchInput, { cwd })
            const result = await patcher.apply(patch)
            const first = result.sections[0]
            if (first) {
              const madeExecutable = await maybeMarkExecutable(displayForPatch, first.after)
              // Lossless JSON only: conditionally spread optional before/after.
              return {
                path: String(first.path),
                operation: (first.op === 'create' ? 'create' : 'update') as 'create' | 'update',
                ...(first.before != null ? { before: first.before } : {}),
                ...(first.after != null ? { after: first.after } : {}),
                ...(madeExecutable ? { madeExecutable: true } : {}),
              }
            }
          }
        } catch (e: any) {
          // Hashline engine missing or patch failed — fall through to plain write
          if (e && e.name === 'ToolError') throw e
          // If patch parse error, surface it
          if (e instanceof Error && /Input header must be|hashline/i.test(e.message)) throw e
        }
      }

      // ── Archive member write (OMP parity) ──────────────────────────────
      // `archive.zip:member/path` rewrites the WHOLE archive: existing members
      // are materialized, the target member is set, and the result is written
      // to a temp file then renamed so a mid-write crash can't destroy the
      // original. Empty content + a selector-shaped missing member is refused
      // (readSelectorForEmptyWrite misfire guard).
      {
        const candidates = parseArchivePathCandidates(filePath).filter((c: any) => c.archivePath !== filePath)
        if (candidates.length > 0) {
          let picked: { real: string; archivePath: string; subPath: string; exists: boolean } | null = null
          for (const candidate of candidates) {
            try {
              const t = await ctx.fs.resolve(candidate.archivePath, { cwd })
              const info = await ctx.fs.stat(t)
              if (info?.type === 'directory') continue
              const real = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(t) : ((t as any).displayPath ?? candidate.archivePath)
              picked = { real, archivePath: candidate.archivePath, subPath: normalizeArchiveWriteSubPath(candidate.subPath), exists: true }
              break
            } catch (e: any) {
              const code = e?.code ?? e?.cause?.code
              if (code === 'ENOENT' || code === 'ENOTDIR') continue
              throw e
            }
          }
          if (!picked) {
            const lastCandidate = candidates[candidates.length - 1]!
            const fallbackAbs = path.isAbsolute(lastCandidate.archivePath) ? lastCandidate.archivePath : path.join(cwd, lastCandidate.archivePath)
            picked = { real: fallbackAbs, archivePath: lastCandidate.archivePath, subPath: normalizeArchiveWriteSubPath(lastCandidate.subPath), exists: false }
          }

          const finalReal: string = picked.exists
            ? (await fs.realpath(picked.real).catch(() => picked.real))
            : picked.real
          const format = archiveFormatFromPath(finalReal) ?? 'tar'
          const tmpPath = `${finalReal}.tmp-${process.pid}`

          const parentDir = path.dirname(picked.real)
          if (parentDir && parentDir !== '.') {
            await fs.mkdir(parentDir, { recursive: true }).catch(() => {})
          }

          let entriesMap = new Map<string, Uint8Array | string>()
          if (picked.exists) {
            try {
              entriesMap = await readArchiveEntries({ path: finalReal, format }) as Map<string, Uint8Array | string>
            } catch (e: any) {
              throw new Error(e instanceof Error ? e.message : String(e))
            }
          }
          const writeTarget = `${picked.archivePath}:${picked.subPath}`
          if (content.length === 0 && !entriesMap.has(picked.subPath)) {
            const selTail = (() => { try { return filePath.split(':').pop() ?? '' } catch { return '' } })()
            throw new Error(
              `write target '${writeTarget}' ends with a read-tool selector '${selTail ? `:${selTail}` : ''}' and no such file exists — refusing to create a literal file by that name. ` +
                `If you meant to read it, use the read tool on "${writeTarget}". ` +
                `If you truly intend to create this file, pass its contents in \`content\` (a non-empty write is never blocked).`,
            )
          }
          const existed = entriesMap.has(picked.subPath)
          entriesMap.set(picked.subPath, content)

          try {
            await writeArchive(tmpPath, format, [...entriesMap.entries()])
            await fs.rename(tmpPath, finalReal)
          } catch (e: any) {
            await fs.rm(tmpPath, { force: true }).catch(() => {})
            throw new Error(e instanceof Error ? e.message : String(e))
          }

          // Lossless JSON only: an explicit `before: undefined` property is
          // rejected by the output validator ("value is not lossless JSON")
          // even though the archive rewrite itself already succeeded.
          return {
            path: writeTarget,
            operation: existed ? ('update' as const) : ('create' as const),
            after: content,
          }
        }
      }

      // ── SQLite row write (OMP parity): db.sqlite:table inserts a JSON
      // object row, :table:key updates it, empty content + key deletes. ──
      {
        const sqliteResolved = await resolveSqliteWritePath(ctx, filePath, cwd)
        if (sqliteResolved) {
          const resultText = await writeSqliteRow(sqliteResolved.displayPath, content, sqliteResolved)
          //  renders verbatim — 'Inserted row into items' is the model-facing
          // truth; the generic byte-count render would hide what actually happened.
          return { path: filePath, operation: 'update' as const, after: resultText, detail: resultText }
        }
      }

      // Normal file write
      const target: any = await ctx.fs.resolve(filePath, { cwd })
      const displayPath: string = (target as any).displayPath ?? filePath
      const realPathForFs: string = (ctx.fs as any).processPath ? (ctx.fs as any).processPath(target) : displayPath

      // Auto-generated guard (content + existing file)
      await tryAutoGeneratedGuard(filePath, content, realPathForFs)

      // Ensure parent directories exist (DSH local backend does this atomically
      // via mkdir in writeFileAtomic, but we mkdir eagerly for clearer errors
      // and for backends that don't)
      const parentDir = path.dirname(realPathForFs)
      if (parentDir && parentDir !== '.' && parentDir !== realPathForFs) {
        await fs.mkdir(parentDir, { recursive: true }).catch(() => {})
      }

      // DSH write — expected is undefined (no stale guard); signal + per-call
      // sandbox policy (session-aware) forwarded
      const outcome: any = await (ctx.fs as any).writeText(target, content, undefined, signal, sandboxPolicy)

      // Shebang chmod +x (best-effort, never fails the write)
      let madeExecutable = false
      if (content.startsWith('#!')) {
        madeExecutable = await maybeMarkExecutable(realPathForFs, content)
      }

      // The DSH outcome carries { operation, version, before, after }
      // where before is the previous text (or null for create) and after is
      // the normalized written content.
      const op: 'create' | 'update' = outcome.operation === 'create' ? 'create' : 'update'
      const beforeVal: string | undefined = outcome.before == null ? undefined : String(outcome.before)
      const afterVal: string | undefined = outcome.after == null ? String(content) : String(outcome.after)
      const result: any = { path: String(displayPath), operation: op }
      if (beforeVal !== undefined) result.before = beforeVal
      if (afterVal !== undefined) result.after = afterVal
      if (madeExecutable) result.madeExecutable = true
      return result
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: `Write ${args.file_path}`,
      kind: 'execute',
      rawInput: args.content?.slice(0, 2000) ?? '',
    }),
    presentResult: (args: any, result: any) => {
      if ((result as any)?.isError) return undefined
      return undefined
    },
  }))
}
