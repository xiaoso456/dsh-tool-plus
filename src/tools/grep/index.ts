/**
 * DSH grep tool — OMP parity on pi-natives without TUI.
 *
 * Ported from OMP `packages/coding-agent/src/tools/grep.ts` (which is self-built
 * on `crates/pi-natives/src/grep.rs` via `@oh-my-pi/pi-natives` grep) — keeps
 * the double-engine sanitization, parallel walk, 4 MiB window, gitignore/hidden
 * semantics, pagination caps, context and timeout handling, but drops all
 * `pi-tui` rendering. Render is plain grouped text: `path\nLine N: text`.
 *
 * DSH FS: cwd from exec.agent.session.header.cwd, paths via ctx.fs.resolve +
 * ctx.fs.processPath, signal from exec.signal, 30 s timeout, 250-match cap,
 * 2000-byte line truncate, spill notice inlined. archive: / memory:// virtual
 * resources error for now.
 */

import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { grep, GrepOutputMode } from '@oh-my-pi/pi-natives'
import type { GrepMatch } from '@oh-my-pi/pi-natives'
import { openArchive, parseArchivePathCandidates } from '../shared/archive/zip'
import { parseLineRanges, splitPathAndSel, type LineRange } from '../read/index.ts'

// ── caps mirrored from OMP grep.ts ──────────────────────────────────────────

const SEARCH_GREP_TIMEOUT_MS = 30_000
const GREP_MAX_MATCHES = 250
const GREP_MAX_LINE_BYTES = 2000
const DEFAULT_MAX_COLUMN = 2000
/** Hard safety ceiling before JS grouping (OMP INTERNAL_TOTAL_CAP). */
const INTERNAL_TOTAL_CAP = 2000

// ── helpers ─────────────────────────────────────────────────────────────────

function truncateLine(line: string, max = GREP_MAX_LINE_BYTES): { text: string; wasTruncated: boolean } {
  if (Buffer.byteLength(line, 'utf8') <= max) return { text: line, wasTruncated: false }
  // Slice by bytes then truncate to max chars as approximation; keep readable.
  // Walk back to avoid splitting surrogate.
  let truncated = line.slice(0, max)
  // Ensure not cutting surrogate pair
  const last = truncated.charCodeAt(truncated.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1)
  return { text: truncated + ' … (line truncated)', wasTruncated: true }
}

function isMemoryPath(p: string): boolean {
  return /^memory:\/\//i.test(p)
}

// ── Archive member materialization (OMP grep.ts resolveArchiveSearchPaths) ──

interface GrepPathSpec {
  original: string
  clean: string
  literalFilesystemMatch: boolean
}

interface ArchiveResolution {
  resolvedPaths: string[]
  /** Indices whose entry failed materialization — excluded from the search. */
  skipped: Set<number>
  displayMap: Map<string, string>
  /** Scratch path → embedded line-range filter from `zip:member:N-M` selectors. */
  rangeMap: Map<string, readonly LineRange[]>
  unreadable: string[]
  cleanup: () => Promise<void>
}

function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
  for (const range of ranges) {
    if (lineNumber < range.startLine) continue
    if (range.endLine === undefined || lineNumber <= range.endLine) return true
  }
  return false
}

/**
 * Pre-resolve `paths` entries pointing at a member inside an archive (e.g.
 * `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md`). Native grep cannot read
 * archive members, so each UTF-8 text member is materialized to a temp scratch
 * file and that path is substituted into the search inputs. After grep returns
 * the caller remaps `match.path` back to the original `archive:member` selector
 * so it round-trips through the read tool. Embedded line-range selectors
 * (`zip:member:10-20`) become match filters.
 */
async function resolveArchiveSearchPaths(
  pathSpecs: readonly GrepPathSpec[],
  cwd: string,
  resolveAbsolutePath: (input: string) => Promise<string>,
): Promise<ArchiveResolution> {
  const resolvedPaths = pathSpecs.map(spec => spec.clean)
  const skipped = new Set<number>()
  const displayMap = new Map<string, string>()
  const rangeMap = new Map<string, readonly LineRange[]>()
  const unreadable: string[] = []
  let tempDir: string | undefined
  const archiveCache = new Map<string, Awaited<ReturnType<typeof openArchive>>>()

  const cleanup = async () => {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    for (let idx = 0; idx < pathSpecs.length; idx++) {
      const spec = pathSpecs[idx]!
      if (spec.literalFilesystemMatch) continue
      const entry = spec.clean
      const candidates = parseArchivePathCandidates(entry)
      const member = candidates.find(c => c.subPath !== '' && c.archivePath !== entry)
      if (!member) continue

      const archiveAbs = await resolveAbsolutePath(member.archivePath)
      let archive = archiveCache.get(archiveAbs)
      if (!archive) {
        try {
          archive = await openArchive(archiveAbs)
        } catch (err) {
          unreadable.push(`${entry} (cannot open archive: ${err instanceof Error ? err.message : String(err)})`)
          skipped.add(idx)
          continue
        }
        archiveCache.set(archiveAbs, archive)
      }

      // A trailing read selector on the member (`zip:f.ts:10-20`) filters matches.
      let subPath = member.subPath
      let ranges: [LineRange, ...LineRange[]] | undefined
      const sp = splitPathAndSel(subPath)
      if (sp.sel !== undefined) {
        const parsed = parseLineRanges(sp.sel)
        if (parsed) {
          subPath = sp.path
          ranges = parsed
        }
      }

      let extracted: Awaited<ReturnType<typeof archive.readFile>>
      try {
        extracted = await archive.readFile(subPath)
      } catch (err) {
        unreadable.push(`${entry} (${err instanceof Error ? err.message : String(err)})`)
        skipped.add(idx)
        continue
      }
      // Binary members would just produce noise through the grep engine.
      let hasNull = false
      for (const byte of extracted.bytes) {
        if (byte === 0) {
          hasNull = true
          break
        }
      }
      if (hasNull) {
        unreadable.push(`${entry} (binary archive entry)`)
        skipped.add(idx)
        continue
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(extracted.bytes)
      } catch {
        unreadable.push(`${entry} (non-UTF-8 archive entry)`)
        skipped.add(idx)
        continue
      }

      if (!tempDir) {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tool-plus-search-archive-'))
      }
      // Per-entry filename keeps scratch paths unique even when two selectors
      // resolve to members with the same basename.
      const safeBase = path.basename(subPath).replace(/[^\w.-]+/g, '_') || 'entry'
      const tempPath = path.join(tempDir, `${idx}-${safeBase}`)
      await fsp.writeFile(tempPath, text)
      resolvedPaths[idx] = tempPath
      displayMap.set(tempPath, entry)
      if (ranges) rangeMap.set(tempPath, ranges)
    }

    return { resolvedPaths, skipped, displayMap, rangeMap, unreadable, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

function groupMatchesByFile(matches: GrepMatch[]): Map<string, GrepMatch[]> {
  const map = new Map<string, GrepMatch[]>()
  for (const m of matches) {
    const list = map.get(m.path)
    if (list) list.push(m)
    else map.set(m.path, [m])
  }
  return map
}

function formatGrouped(matches: GrepMatch[]): string {
  if (matches.length === 0) return 'No matches found.'
  const groups = groupMatchesByFile(matches)
  const lines: string[] = []
  for (const [file, fileMatches] of groups) {
    lines.push(file)
    for (const m of fileMatches) {
      const before = m.contextBefore ?? []
      for (const c of before) {
        const { text } = truncateLine(c.line)
        lines.push(`  ${c.lineNumber} : ${text}`)
      }
      const { text, wasTruncated } = truncateLine(m.line)
      // Truncation marker already in text; keep lineNumber alignment minimal.
      void wasTruncated
      lines.push(`  Line ${m.lineNumber}: ${text}`)
      const after = m.contextAfter ?? []
      for (const c of after) {
        const { text: t } = truncateLine(c.line)
        lines.push(`  ${c.lineNumber} : ${t}`)
      }
    }
    lines.push('')
  }
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

async function resolveAbsolutePath(
  ctx: Context,
  inputPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const raw = inputPath.trim() || '.'
  if (raw === '.' || raw === './') return cwd
  // Prefer DSH FS resolver so sandboxed / remote backends stay correct.
  const fs: any = (ctx as any).fs
  if (fs?.resolve && fs?.processPath) {
    try {
      const target = await fs.resolve(raw, { cwd, signal })
      return fs.processPath(target)
    } catch {
      // Fall through to path.resolve for non-existent / not-yet-created targets:
      // pi-natives walker handles missing gracefully (filesSearched=0).
      return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
    }
  }
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
}

// ── tool registration ───────────────────────────────────────────────────────

export interface GrepToolArgs {
  pattern: string
  path?: string
  include?: string
  contextBefore?: number
  contextAfter?: number
  maxCount?: number
  limit?: number
  skip?: number
  maxColumns?: number
  hidden?: boolean
  gitignore?: boolean
}

export function registerGrep(ctx: Context): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'grep',
      description:
        'Search files for a regex pattern using the native pi-natives grep engine (double engine, brace sanitization via Rust). ' +
        'Use instead of shell grep/rg. Groups results by file as "path\\nLine N: text".',
      parameters: {
        pattern: {
          type: 'string',
          required: true,
          description: 'Regex pattern (Rust regex + PCRE2 JIT; invalid patterns return an error).',
        },
        path: {
          type: 'string',
          description:
            'File, directory, glob, or archive member to search — relative to the session cwd. Omitted or "." searches the workspace root. Archive members are searched via "bundle.zip:src/foo.ts" (semicolon-separated entries allowed; members may carry ":N-M" line-range filters). memory:// is not supported.',
        },
        include: {
          type: 'string',
          description: 'Optional glob filter for filenames, e.g. "*.ts" or "*.{js,ts}". Maps to pi-natives glob.',
        },
        contextBefore: {
          type: 'integer',
          description: 'Lines of context before each match.',
        },
        contextAfter: {
          type: 'integer',
          description: 'Lines of context after each match.',
        },
        maxCount: {
          type: 'integer',
          description: 'Maximum matches to return (capped at 250 for display, 2000 internally).',
        },
        limit: {
          type: 'integer',
          description: 'Alias for maxCount.',
        },
        skip: {
          type: 'integer',
          description: 'Number of leading matches to skip (maps to offset). Use to paginate after a capped result.',
        },
        maxColumns: {
          type: 'integer',
          description: 'Truncate lines longer than this many characters (default 2000).',
        },
        hidden: {
          type: 'boolean',
          description: 'Include hidden files (default false, OMP parity).',
        },
        gitignore: {
          type: 'boolean',
          description: 'Respect .gitignore (default true, OMP parity).',
        },
      },
      output: {
        schema: {
          type: 'string',
        },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      timeoutMs: SEARCH_GREP_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(rawArgs: GrepToolArgs, exec) {
        const pattern = rawArgs.pattern
        if (typeof pattern !== 'string' || pattern.length === 0) {
          throw new Error('grep: pattern must be a non-empty string')
        }

        const cwd: string = (exec.agent as any)?.session?.header?.cwd ?? process.cwd()

        const pathInput = rawArgs.path?.trim() || '.'
        if (isMemoryPath(pathInput) || (rawArgs.include && isMemoryPath(rawArgs.include))) {
          throw new Error('grep: memory:// virtual resources are not supported in the DSH port — search a real filesystem path instead.')
        }
        for (const seg of pathInput.split(';')) {
          if (isMemoryPath(seg.trim())) {
            throw new Error(`grep: memory:// virtual resource not supported: ${seg.trim()} — use a real file or directory path.`)
          }
        }

        const include = rawArgs.include?.trim() || undefined
        const contextBefore = rawArgs.contextBefore != null ? Math.max(0, Math.floor(rawArgs.contextBefore)) : 0
        const contextAfter = rawArgs.contextAfter != null ? Math.max(0, Math.floor(rawArgs.contextAfter)) : 0
        const maxColumns = rawArgs.maxColumns != null ? Math.max(0, Math.floor(rawArgs.maxColumns)) : DEFAULT_MAX_COLUMN
        const requestedMax = rawArgs.limit ?? rawArgs.maxCount
        const skip = rawArgs.skip != null ? Math.max(0, Math.floor(rawArgs.skip)) : 0

        // Display cap is 250; internal cap keeps OMP pagination headroom.
        // When skip is used, fetch one page worth past it.
        const displayCap = GREP_MAX_MATCHES
        const effectiveMax = requestedMax != null ? Math.max(1, Math.floor(requestedMax)) : displayCap
        const internalMax = Math.min(INTERNAL_TOTAL_CAP, Math.max(effectiveMax + skip, effectiveMax))

        const hidden = rawArgs.hidden ?? false
        const gitignore = rawArgs.gitignore ?? true

        // ── Path specs + archive member materialization ──────────────────
        // A literal filesystem match always wins (a real file named `test:1-2`
        // outranks the selector interpretation); everything else may be an
        // `archive.zip:member` entry whose text members are materialized to
        // scratch files for the native engine.
        const segments = pathInput.split(';').map(s => s.trim()).filter(Boolean)
        const pathSpecs: GrepPathSpec[] = []
        for (const seg of segments) {
          const literalTarget = await fsp
            .stat(path.isAbsolute(seg) ? seg : path.resolve(cwd, seg))
            .then(() => true)
            .catch(() => false)
          if (literalTarget) {
            pathSpecs.push({ original: seg, clean: await resolveAbsolutePath(ctx, seg, cwd, exec.signal), literalFilesystemMatch: true })
            continue
          }
          pathSpecs.push({ original: seg, clean: seg, literalFilesystemMatch: false })
        }

        const resolution = await resolveArchiveSearchPaths(pathSpecs, cwd, async input =>
          resolveAbsolutePath(ctx, input, cwd, exec.signal),
        )

        try {
          let allMatches: GrepMatch[] = []
          let filesWithMatches = 0
          let totalMatches = 0
          let filesSearched = 0
          let skippedOversized: number | undefined
          let limitReached = false

          for (let i = 0; i < resolution.resolvedPaths.length; i++) {
            if (resolution.skipped.has(i)) continue
            const searchPath = resolution.resolvedPaths[i]!
            let result: Awaited<ReturnType<typeof grep>>
            try {
              result = await grep(
                {
                  pattern,
                  path: searchPath,
                  ...(include ? { glob: include } : {}),
                  hidden,
                  gitignore,
                  maxCount: internalMax,
                  ...(skip ? { offset: skip } : {}),
                  contextBefore,
                  contextAfter,
                  maxColumns,
                  mode: GrepOutputMode.Content,
                  timeoutMs: SEARCH_GREP_TIMEOUT_MS,
                  signal: exec.signal,
                },
                undefined,
              )
            } catch (err: any) {
              const msg = err?.message ?? String(err)
              // Map native regex compile failures to a clean tool error
              if (/invalid|regex|pattern/i.test(msg)) throw new Error(`grep: invalid pattern: ${msg}`)
              if (err?.name === 'AbortError' || /abort|cancel/i.test(msg)) {
                throw new Error(`grep: aborted: ${msg}`)
              }
              throw new Error(`grep: ${msg}`)
            }

            let matches: GrepMatch[] = result.matches ?? []
            // Embedded line-range selectors on archive members (`zip:f.ts:10-20`)
            // act as match filters (OMP parity).
            const memberRanges = resolution.rangeMap.get(searchPath)
            if (memberRanges) {
              matches = matches.filter(m => isLineInRanges(m.lineNumber, memberRanges))
            }

            filesWithMatches += result.filesWithMatches ?? new Set(matches.map(m => m.path)).size
            totalMatches += result.totalMatches ?? matches.length
            filesSearched += result.filesSearched ?? 0
            skippedOversized = skippedOversized ?? (result as any).skippedOversized
            limitReached = limitReached || (result.limitReached ?? false)

            // Remap scratch paths back to the original `archive:member` selectors
            for (const m of matches) {
              const original = resolution.displayMap.get(m.path)
              if (original !== undefined) m.path = original
            }
            // OMP multi-file per-file cap parity: keep diversity by capping
            // per file when more than one file matched.
            if ((result.filesWithMatches ?? new Set(matches.map(m => m.path)).size) > 1) {
              const MULTI_FILE_PER_FILE_MATCHES = 20
              const perFileCount = new Map<string, number>()
              const filtered: GrepMatch[] = []
              for (const m of matches) {
                const c = perFileCount.get(m.path) ?? 0
                if (c < MULTI_FILE_PER_FILE_MATCHES) {
                  filtered.push(m)
                  perFileCount.set(m.path, c + 1)
                }
              }
              matches = filtered
            }
            allMatches = allMatches.concat(matches)
          }

          // Cross-root per-file cap pass (a member and its container could both match)
          {
            const perFileCount = new Map<string, number>()
            allMatches = allMatches.filter(m => {
              const c = perFileCount.get(m.path) ?? 0
              perFileCount.set(m.path, c + 1)
              return c < 20
            })
          }

          // Apply display cap (250) after per-file capping, preserving skip semantics
          // (pi-natives already applied offset, so slice from 0)
          const truncated = allMatches.length > displayCap || limitReached || totalMatches > displayCap
          const displayMatches = allMatches.slice(0, displayCap)
          const skippedOversizedFinal = skippedOversized

          let text = formatGrouped(displayMatches)

          const notices: string[] = []
          if (resolution.unreadable.length > 0) {
            notices.push(`Skipped unreadable entries: ${resolution.unreadable.join('; ')}.`)
          }
          if (allMatches.length === 0 && totalMatches === 0) {
            // formatGrouped already says No matches found — add scope hint
            notices.push(`Searched ${filesSearched} file(s) in ${segments.map(s => (path.isAbsolute(s) ? path.relative(cwd, s) : s)).join('; ') || '.'}.`)
            if (skippedOversizedFinal) notices.push(`Skipped ${skippedOversizedFinal} oversized file(s) (>4 MiB window).`)
          } else {
            const shown = displayMatches.length
            const total = totalMatches
            if (truncated || total > shown || filesWithMatches > groupMatchesByFile(displayMatches).size) {
              notices.push(`Showing ${shown} of ${total} matches in ${filesWithMatches} file(s) (cap ${displayCap}). Narrow pattern, set include, or use skip to paginate.`)
            } else {
              notices.push(`Found ${total} match(es) in ${filesWithMatches} file(s).`)
            }
            if (skippedOversizedFinal) notices.push(`Skipped ${skippedOversizedFinal} oversized file(s) (>4 MiB window).`)
            // Best-effort spill for full result when truncated — mirrors official
            // dsh-tool-fs-search trySaveFormattedResult: opportunistic
            // `ctx.get("spillStore")` (never property access — Cordis rejects
            // undeclared ctx properties), missing backend degrades to the inline
            // notice and never turns search success into an error.
            if (truncated) {
              const fullText = formatGrouped(allMatches)
              const store: any = ctx.get?.('spillStore' as any)
              const sessionId = (exec.agent as any)?.session?.header?.id
              if (store?.saveText && sessionId !== undefined) {
                try {
                  const ref = await store.saveText({
                    owner: { sessionId: String(sessionId) },
                    source: { toolName: exec.name, callId: exec.callId, label: 'result' },
                    suggestedName: 'grep-results.txt',
                    content: fullText,
                  } as any)
                  const loc = (ref as any)?.locator ?? (ref as any)?.url ?? String(ref)
                  notices.push(`Full result spilled to ${loc}.`)
                } catch (error) {
                  notices.push(`Full result spill failed (${String(error)}) — narrow pattern or increase maxCount.`)
                }
              } else {
                notices.push('Full result not saved (no spill backend) — narrow pattern or increase maxCount.')
              }
            }
          }

          if (notices.length > 0) {
            text = text === 'No matches found.' ? `${text}\n${notices.join(' ')}` : `${text}\n\n${notices.join(' ')}`
          }

          return text
        } finally {
          await resolution.cleanup()
        }
      },
    }),
  )
}

// Cordis plugin entry — so the tool can also be mounted via ctx.use() / cordis composition.
export function apply(ctx: Context): void {
  registerGrep(ctx)
}

export default { apply }
