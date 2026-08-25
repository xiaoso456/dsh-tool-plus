/**
 * DSH adapter for OMP `lsp/types.ts` — the diagnostic result types the edit
 * engine references. Values are verbatim OMP shapes; DSH never produces
 * diagnostics, so fields are present but always empty.
 */
export interface FileFormatResult {
  /** Formatting was performed (false in DSH — no formatter). */
  formatted: boolean
  /** Formatted content (unchanged in DSH). */
  formattedContent?: string
}

export interface FileDiagnosticsResult {
  /** Name of the LSP server used (if available) — undefined in DSH. */
  server?: string
  /** Formatted diagnostic messages */
  messages: string[]
  /** Summary string (e.g., "2 error(s), 1 warning(s)") */
  summary: string
  /** Whether there are any errors (severity 1) */
  errored: boolean
  /** Whether the file was formatted */
  formatter?: FileFormatResult
}

export type ServerVersionMap = Map<string, number>
