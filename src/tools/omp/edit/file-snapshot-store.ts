/**
 * Session-bound file snapshot store.
 *
 * Used by `read` and `search` to record exactly what the model saw, and by
 * the native hashline engine to verify (or recover from) stale section tags —
 * a file changed externally between read and edit, or a prior in-session edit
 * advanced the tag.
 *
 * The storage itself is the native `EditStore`
 * (`@oh-my-pi/pi-natives`), which owns the full-file snapshot ring, the
 * `CUT`/`PUT` clipboard registers and the no-op loop guard. This module is the
 * DSH wrapper around it and keeps the two things the native store cannot know
 * about:
 *
 * 1. **The session slot.** DSH rebuilds its `ToolSession` on every tool call
 *    and round-trips the store through `shared/session-state.ts`, so the store
 *    is reached through {@link getFileSnapshotStore} — a one-line forward to
 *    the adapter's `getEditStore` (single authority: one store per session,
 *    shared by read / search / write / edit).
 * 2. **Key canonicalization** — see {@link canonicalSnapshotKey}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getEditStore, type EditStore, type EditStoreOwner } from "../../hashline/native/index.ts";

/**
 * Upper bound on the file size we snapshot.
 *
 * A section tag is a content hash of the *whole* file, so minting one means
 * holding the full normalized text in the store. Files above this cap emit no
 * `[path#tag]` header — line-anchored editing of multi-megabyte files is out
 * of scope under the full-content model.
 *
 * The value mirrors the native store's own cap (`EditStore.recordSnapshotFile`
 * returns `null` for "unreadable or larger than 4 MiB",
 * `@oh-my-pi/pi-natives` index.d.ts:132-136); `read` also uses it to decide
 * whether to stream a whole file into memory.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Look up (or lazily create) the file snapshot store attached to a session.
 *
 * One-line forward to the adapter's `getEditStore` so there is exactly one
 * store per session; the DSH name is kept because this module owns the
 * DSH-side concerns listed in the file header.
 */
export function getFileSnapshotStore(session: EditStoreOwner): EditStore {
	return getEditStore(session);
}

/**
 * Canonicalize an absolute path into the stable key the snapshot store uses.
 *
 * Different code paths reach the snapshot store via different path forms:
 * `read local://foo.md` records under the file's `fs.realpath` (the local
 * protocol handler resolves symlinks); a subsequent `edit` may address the
 * same artifact via `local://foo.md`, whose resolver does NOT realpath, or
 * via the absolute path returned in the `[path#tag]` header. macOS adds the
 * same hazard at the working-tree level (`/tmp/...` vs `/private/tmp/...`).
 * Collapsing every key through `realpath` makes those forms fuse onto one
 * snapshot entry, so a freshly-minted tag is never rejected as stale just
 * because the lookup spelled the same file differently.
 *
 * Non-existent paths (new-file writes) fall back to a realpath of the parent
 * directory + basename, then to the input. This keeps creates and updates on
 * the same canonical key.
 *
 * Parity note (native migration): the Rust engine keys its own lookups by
 * `policy.cwd` + the authored path, i.e. the unresolved spelling. For a path
 * with no symlink component the two spellings are identical; for a symlinked
 * subpath they are not, and a tag minted here would not be found by the
 * engine. Listed for the parity doc (T-parity) rather than papered over —
 * native exposes no path-canonicalization hook.
 */
export function canonicalSnapshotKey(absolutePath: string): string {
	try {
		return fs.realpathSync.native(absolutePath);
	} catch {
		try {
			const parent = fs.realpathSync.native(path.dirname(absolutePath));
			return path.join(parent, path.basename(absolutePath));
		} catch {
			return absolutePath;
		}
	}
}

/**
 * Read the full text of `absolutePath` (within {@link SNAPSHOT_MAX_BYTES}),
 * record it as a version snapshot, and return its content-hash tag. Returns
 * `undefined` when the file exceeds the cap or cannot be read — callers then
 * omit the section header so the model never sees a tag it can't anchor against.
 *
 * Producers that only displayed a slice of the file (range reads, search hits)
 * use this to mint a whole-file tag: the displayed lines stay partial, but the
 * tag fingerprints the entire file so a follow-up edit anchored at any line
 * validates whenever the live file is byte-identical to what was read. Raw
 * reads pass `seenLines` even though they do not emit a header, letting a prior
 * or later same-content hashline tag inherit the raw range's provenance.
 *
 * `async` for call-site compatibility (`read`/`grep`/`ast-grep` await it); the
 * native `recordSnapshotFile` performs the read, LF normalization and the
 * 4 MiB cap synchronously, and returns `null` instead of `undefined`.
 */
export async function recordFileSnapshot(
	session: EditStoreOwner,
	absolutePath: string,
	seenLines?: Iterable<number>,
): Promise<string | undefined> {
	const lines = seenLines === undefined ? undefined : [...seenLines];
	return getFileSnapshotStore(session).recordSnapshotFile(canonicalSnapshotKey(absolutePath), lines) ?? undefined;
}

/** Merge explicit 1-indexed displayed lines into a recorded hashline snapshot. */
export function recordSeenLines(
	session: EditStoreOwner,
	absolutePath: string,
	tag: string,
	lines: readonly number[],
): void {
	if (lines.length === 0) return;
	getFileSnapshotStore(session).recordSeenLines(canonicalSnapshotKey(absolutePath), tag, [...lines]);
}

/**
 * Attach the lines a read displayed to the snapshot it minted, so the engine's
 * (opt-in) seen-line guard can reject edits anchored on lines the model never
 * saw. Best-effort: a no-op when the body has no numbered rows or the snapshot
 * already aged out. `tag` must be the tag returned when this exact content was
 * recorded. Every displayed `NN:` row counts as seen, including column-clipped
 * rows — the guard no longer distinguishes full-width from truncated display.
 *
 * The `N:` / `NN-MM:` row parsing lives in Rust now
 * (`EditStore.recordSeenLinesFromBody`, including the collapsed-summary
 * boundary-line rule), so this is a straight forward with key canonicalization.
 */
export function recordSeenLinesFromBody(
	session: EditStoreOwner,
	absolutePath: string,
	tag: string,
	body: string,
): void {
	if (body.length === 0) return;
	getFileSnapshotStore(session).recordSeenLinesFromBody(canonicalSnapshotKey(absolutePath), tag, body);
}
