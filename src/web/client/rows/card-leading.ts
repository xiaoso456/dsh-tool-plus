/**
 * Row-leading treatment: which glyph a row leads with, and what replaces it
 * when the call did not settle cleanly.
 *
 * The shipped `ToolRow` does not lead with a status dot. A clean or running row
 * leads with its tool's own glyph, and only `error` / `stopped` swap that glyph
 * for a `StateDot` (`ui-tool/src/client/tool/components/ToolRow.tsx::leadingFor`);
 * the glyph per tool name comes from the shipped variant table
 * (`ui-tool/src/client/tool/toolviews/GenericToolCard.tsx::VARIANT_ICONS`).
 * This module is that rule and that table, kept pure so the mapping is testable
 * under the Node runner — the component that draws it lives in
 * `ToolCardShell`.
 *
 * Two of the eight card keys are this plugin's own tools, so they are absent
 * from the shipped name table. They take the family whose shipped glyph
 * describes the act — a structural search reads like `grep`, an atomic edit
 * writes like `edit` — rather than the shipped `others` sparkle, which would
 * make the two cards this plugin is the only home of look like unknown tools.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/card-leading
 */

import type { CardState } from '../row-utils.ts'

/** Glyph families of the shipped leading table. */
export type CardLeadingGlyph = 'bash' | 'read' | 'edit' | 'search' | 'others'

/**
 * Wire tool name to glyph family: the shipped name table for the six keys this
 * plugin shadows, plus its own two tools.
 */
const GLYPH_BY_TOOL: Record<string, CardLeadingGlyph> = {
  bash: 'bash',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  grep: 'search',
  glob: 'search',
  ast_grep: 'search',
  ast_edit: 'edit',
}

/**
 * Glyph family a row leads with.
 * @param toolName - the call's wire tool name, when the node carries one.
 * @returns the family, or `others` (the shipped generic glyph) for an unknown name.
 */
export function leadingGlyph(toolName: string | null | undefined): CardLeadingGlyph {
  if (typeof toolName !== 'string') return 'others'
  return GLYPH_BY_TOOL[toolName] ?? 'others'
}

/** What the leading box draws for one run state. */
export type CardLeadingKind = 'glyph' | 'error' | 'warning'

/**
 * Whether a run state keeps the row's glyph or replaces it with a state dot.
 * @param state - the card's run state.
 * @returns the leading kind; `error` and `warning` are the two dot states.
 */
export function leadingKind(state: CardState): CardLeadingKind {
  switch (state) {
    case 'error': return 'error'
    case 'warning': return 'warning'
    default: return 'glyph'
  }
}
