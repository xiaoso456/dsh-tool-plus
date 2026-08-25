/**
 * DSH adapter interface shim for OMP `exa/mcp-client.ts`.
 *
 * The original is the Exa MCP client: finds `EXA_API_KEY` from `$env` (Bun),
 * calls the Exa/Websets MCP endpoints via `callMCP`, wraps MCP tools as
 * `CustomTool`s, and normalizes responses. It is a Bun-dependent module
 * (`$env`) and imports `CustomTool`/`CustomToolResult` from
 * `extensibility/custom-tools/types` (not in the DSH read adapter surface), so
 * its full port is deferred (step.md Bun-class record).
 *
 * Only the two functions the verbatim `web/search/providers/exa.ts` consumes —
 * `findApiKey` and `isSearchResponse` — are provided, with `ExaSearchResponse`
 * re-exported from `./types`.
 */
import type { ExaSearchResponse } from './types'

/** Find EXA_API_KEY (env lookup; `$env`-equivalent for Node). */
export function findApiKey(): string | null {
  return process.env.EXA_API_KEY ?? null
}

/** Check if result is a search response. */
export function isSearchResponse(data: unknown): data is ExaSearchResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    ('results' in data || 'statuses' in data || 'costDollars' in data || 'searchTime' in data)
  )
}

export type { ExaSearchResponse } from './types'
