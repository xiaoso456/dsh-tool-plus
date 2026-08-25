/**
 * DSH adapter for OMP `lsp/utils.ts` — only the diagnostic-summary helper
 * the diagnostics-ledger needs. Diagnostics are never produced in DSH (no
 * LSP), but the summary logic is kept verbatim so the ledger compiles and
 * behaves identically on empty input.
 */
import type { FileDiagnosticsResult } from './types.ts'

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
