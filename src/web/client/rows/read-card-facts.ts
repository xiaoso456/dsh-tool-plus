/**
 * Collapsed-summary facts for the `read` card.
 *
 * The Host projection strips the inline selector off the path
 * (`stripReadSelector` in `web/host/read.ts`) because the card's *link* must
 * point at a real file, and it keeps only the file's own window. The collapsed
 * head is then the one place where the question the model actually asked is
 * still readable — and the projected path cannot answer it: a windowed read of
 * `package.json:22-25,31-34` and a whole-file read of `package.json` project to
 * the very same string, so the card hides the difference.
 *
 * The summary is therefore built from the call's own argument, selector and
 * all, with the projected path kept as the fallback for a result whose call
 * head fell outside the session window (a truncated window carries no
 * `tool/call` event, so no argument survives). That fallback states a fact the
 * card already holds; nothing is invented.
 * @module @xiaoso/dsh-tool-plus/web/client/rows/read-card-facts
 */

import { argText, displayPath } from '../row-utils.ts'

/**
 * The `read` card's collapsed summary: the path the model asked for, keeping
 * whatever inline selector it carried (`:22-25`, `:raw`, `:conflicts`, `:28-`,
 * a sqlite row, an archive member) and shortened against the workspace root.
 *
 * The selector is deliberately not validated against the read grammar: the head
 * reports the call verbatim, and a selector this plugin does not recognize is
 * still what the model typed — substituting the projection's stripped path
 * would erase the evidence that two calls differ.
 * @param args - the call's parsed arguments, or `null` when its head is gone.
 * @param metaPath - the Host-projected path (already selector-free).
 * @param cwd - the session workspace root, when known.
 * @returns the workspace-shortened argument path, or the projected path.
 */
export function readCardSummary(
  args: Record<string, unknown> | null,
  metaPath: string,
  cwd: string | undefined,
): string {
  const asked = argText(args, 'path')
  return displayPath(asked ?? metaPath, cwd)
}
