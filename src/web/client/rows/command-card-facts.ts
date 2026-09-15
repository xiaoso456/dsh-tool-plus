/**
 * Collapsed-fact builders for the two command-shaped cards: the command a
 * `bash` description hides, and the rewrite rule an `ast_edit` preview only
 * shows once expanded.
 *
 * Both cards collapse to one head line. `bash`'s head used to be the model's
 * own `description` — a sentence about intent, never the command that ran — so
 * the only way to learn what executed was to expand the card. `ast_edit`'s head
 * names the file and the replacement count, and its body previews the *result*:
 * the rule that produced that result lives only in the call's `ops` argument,
 * which no card showed at all. Each builder recovers one fact from the call's
 * own arguments, so nothing is inferred from output, and a call head that fell
 * outside the session window degrades to the facts the card already holds.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/command-card-facts
 */

import { argText, firstLine, type CardTranslate } from '../row-utils.ts'

/** Whether `value` is a plain object — the only op shape the engine sends. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `bash` card's collapsed summary: what ran, placed after the sentence
 * saying why.
 *
 * The command is the fact the head must carry, so the description can never be
 * the whole summary — it is a prefix at most. Only its first line is used: a
 * summary is one row high, and the rest of a multi-line command belongs to the
 * expanded body, which draws the whole thing.
 * @param description - the model's one-line intent, or `null` when absent.
 * @param command - the command actually executed (never empty).
 * @param outcome - the interruption word (`timedOut` / `cancelled`), or `null`.
 * @returns the outcome alone when the run was interrupted; otherwise the
 *   description joined to the command's first line, or that line alone.
 */
export function bashCardSummary(description: string | null, command: string, outcome: string | null): string {
  // An interrupted run has no result to describe: the deadline or the
  // cancellation IS the outcome, and it must not be pushed out of the row by a
  // description — that word is the one fact the reader still has to see.
  if (outcome !== null && outcome !== '') return outcome
  const intent = description === null ? '' : description.trim()
  const line = firstLine(command)
  return intent === '' ? line : `${intent} · ${line}`
}

/**
 * The `ast_edit` card's rule line: the first usable `ops` entry, written the
 * way the tool's own `ops` argument writes it (`pat → out`).
 *
 * Only the first rule is stated, with the count of the entries behind it: the
 * card exists to preview one change, and a call may carry many rules whose
 * patterns are whole AST fragments — listing them would bury the preview. The
 * remaining count is the array tail, not the number of *usable* entries, so it
 * always describes the call as it was made.
 * @param args - the call's parsed arguments, or `null` when its head is gone.
 * @param t - this plugin's card translate seat.
 * @returns the rule line, or `null` when the call carries no usable rule.
 */
export function astEditRuleLine(args: Record<string, unknown> | null, t: CardTranslate): string | null {
  const ops = args?.ops
  if (!Array.isArray(ops)) return null
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    if (!isRecord(op)) continue
    const pat = argText(op, 'pat')
    if (pat === null) continue
    // An empty `out` is a replacement with nothing — the engine's own delete
    // form — so it is a rule the line can state; only a missing or non-string
    // replacement is not a rule at all.
    const replacement = op.out
    if (typeof replacement !== 'string') continue
    // The count covers every *other* entry the call carried, including the ones
    // this loop skipped: a line that says "one rule" must not describe a call
    // that made two.
    const rest = ops.length - 1
    const rule = `${t('astEdit.rules')}: ${pat} →${replacement === '' ? '' : ` ${replacement}`}`
    return rest === 0 ? rule : `${rule} · ${t('astEdit.rulesRest', { count: rest })}`
  }
  return null
}
