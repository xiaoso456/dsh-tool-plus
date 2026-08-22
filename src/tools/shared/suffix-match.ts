/**
 * Suffix-match path resolution — port of OMP
 * refs/oh-my-pi/packages/coding-agent/src/tools/read-path-resolution.ts plus
 * `findUniqueWorkspaceSuffix` from tools/path-utils.ts (verbatim logic; the
 * ToolSession parameter is adapted to an explicit cwd, and the glob engine is
 * the same @oh-my-pi/pi-natives native the glob tool already uses).
 *
 * A missing authored path (typically `name.zip` / `db.sqlite` / partial dir)
 * is probed once against the workspace with a `**\/<escaped>` hidden glob;
 * exactly one match resolves, ambiguity/timeout/failure resolve to null.
 * Per-execute memo collapses repeated probes of the same string within one
 * tool call (each carries a 5s timeout — repeats would stack into a stall).
 */
import * as path from 'node:path'
import { glob } from '@oh-my-pi/pi-natives'

const WORKSPACE_SUFFIX_TIMEOUT_MS = 5000

export interface SuffixHit {
	absolutePath: string;
	displayPath: string;
}

/** Per-execute memo of suffix-glob lookups; `null` records a confirmed miss. */
export type SuffixMatchCache = Map<string, SuffixHit | null>;

export function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const code = (error as { code?: string }).code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, '[$&]');
}

/**
 * Find a unique workspace entry whose trailing path matches a missing authored
 * path. Returns `null` for no match, ambiguity, timeout, or scan failure.
 */
export async function findUniqueWorkspaceSuffix(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<SuffixHit | null> {
	const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (!normalized) return null;

	const timeoutSignal = AbortSignal.timeout(WORKSPACE_SUFFIX_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	try {
		const result = await glob(
			{
				pattern: `**/${escapeGlobMetachars(normalized)}`,
				path: cwd,
				hidden: true,
				timeoutMs: WORKSPACE_SUFFIX_TIMEOUT_MS,
				signal: combinedSignal,
			} as any,
			undefined as any,
		);
		matches = (result?.matches ?? []).map((m: any) => m.path).filter(Boolean);
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			if (!signal?.aborted) return null;
			throw error;
		}
		return null;
	}

	if (matches.length !== 1) return null;
	return {
		absolutePath: path.resolve(cwd, matches[0]!),
		displayPath: matches[0]!,
	};
}

/** Memoized {@link findUniqueWorkspaceSuffix} bound to one execute call. */
export async function findSuffixMatchCached(
	cache: SuffixMatchCache,
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<SuffixHit | null> {
	const hit = cache.get(rawPath);
	if (hit !== undefined) return hit;
	const result = await findUniqueWorkspaceSuffix(rawPath, cwd, signal);
	cache.set(rawPath, result);
	return result;
}

/** OMP read-format.ts wording: notice prepended when a suffix match resolved. */
export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;
	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}
