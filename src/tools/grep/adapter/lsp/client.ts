/**
 * DSH adapter for OMP `lsp/client.ts` — the workspace-watched-file
 * notification surface used by edit modes after a write. DSH has no LSP
 * clients to notify, so the enum and the notification function keep their
 * OMP signatures (verbatim) while the notify is a no-op.
 */
export enum FileChangeType {
  Created = 1,
  Changed = 2,
  Deleted = 3,
}

/** Filesystem change authored by the harness and announced to active LSP clients. */
export interface WatchedFileChange {
  filePath: string
  type: FileChangeType
}

/**
 * Announce filesystem changes to active LSP clients (no-op in DSH — no LSP
 * servers are connected).
 */
export async function notifyWorkspaceWatchedFiles(
  _cwd: string,
  _watchedFiles: WatchedFileChange[],
  _signal?: AbortSignal,
): Promise<void> {}
