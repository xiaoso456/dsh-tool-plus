/**
 * DSH adapter for OMP `lsp/utils.ts` — only the diagnostic-summary helper
 * the diagnostics-ledger needs. Diagnostics are never produced in DSH (no
 * LSP), but the summary logic is kept verbatim so the ledger compiles and
 * behaves identically on empty input.
 */
import type { FileDiagnosticsResult } from './types.ts'
import { formatGroupedFiles } from '../tools/grouped-file-output.ts'

// Regex: split on the first `:digits:digits` boundary to separate path from the rest
const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/

/**
 * Reformat pre-formatted diagnostic messages into a multi-level, prefix-folded
 * directory/file grouping (verbatim OMP lsp/utils.ts).
 * Input:  ["path:line:col [sev] msg", ...]
 * Output: "# pkg/src/\n## file.ts\n  line:col [sev] msg"
 */
export function formatGroupedDiagnosticMessages(messages: string[]): string {
  const diagnosticsByFile = new Map<string, string[]>()
  const fileOrder: string[] = []
  const ungrouped: string[] = []

  for (const msg of messages) {
    const match = DIAG_PATH_RE.exec(msg)
    if (!match) {
      ungrouped.push(msg)
      continue
    }

    const [, rawFilePath, rest] = match
    const filePath = rawFilePath.replace(/\\/g, '/')
    if (!diagnosticsByFile.has(filePath)) {
      diagnosticsByFile.set(filePath, [])
      fileOrder.push(filePath)
    }
    diagnosticsByFile.get(filePath)?.push(rest)
  }

  if (diagnosticsByFile.size === 0) {
    return ungrouped.join('\n')
  }

  const grouped = formatGroupedFiles(fileOrder, filePath => ({
    modelLines: (diagnosticsByFile.get(filePath) ?? []).map(diagnostic => `  ${diagnostic}`),
  }))
  const lines: string[] = grouped.model

  if (ungrouped.length > 0) {
    lines.push('')
    for (const msg of ungrouped) {
      lines.push(msg)
    }
  }

  return lines.join('\n')
}

/** Summarize diagnostic messages (verbatim OMP; empty input -> empty summary). */
export function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const message of messages) {
    const match = message.match(/\[(error|warning|info|hint)\]/i)
    if (!match) continue
    const key = match[1]!.toLowerCase() as keyof typeof counts
    counts[key] += 1
  }

  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} error(s)`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`)
  if (counts.info > 0) parts.push(`${counts.info} info`)
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`)

  return {
    summary: parts.length > 0 ? parts.join(', ') : '',
    errored: counts.error > 0,
  }
}

/** No-op result for DSH (no LSP diagnostics ever). */
export function emptyDiagnostics(): FileDiagnosticsResult {
  return { messages: [], summary: '', errored: false }
}
