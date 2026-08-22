/**
 * DSH ast_edit tool — ported from OMP `tools/ast-edit.ts` (plan.md §3 拍板#11).
 *
 * Keeps: OMP parameter shape verbatim (`ops[{pat,out}]`, `paths[]`), the
 * dry-run → preview → apply flow, duplicate-pattern guard, change rendering
 * (`-line:text` / `+line:text`), parse-error surfacing.
 * Removes: internal-URL scope routing, TUI renderers, hashline snapshot tags
 * (DSH has no session snapshot store), `$envpos` env override (fixed cap).
 */

import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { astEdit, type AstReplaceChange, type AstReplaceFileChange } from '@oh-my-pi/pi-natives'

/** Hard cap on files touched per call (OMP default via PI_MAX_AST_FILES). */
const MAX_FILES = 1000

interface AggregatedResult {
	changes: AstReplaceChange[]
	fileChanges: Array<{ path: string; count: number }>
	totalReplacements: number
	filesTouched: number
	filesSearched: number
	applied: boolean
	limitReached: boolean
	parseErrors?: string[]
}

function toRewrites(ops: Array<{ pat: string; out: string }>): Record<string, string> {
	return Object.fromEntries(ops.map(op => [op.pat, op.out] as const))
}

async function runAstEditTargets(
	targets: Array<{ basePath: string; glob?: string }>,
	commonBasePath: string,
	options: { rewrites: Record<string, string>; dryRun: boolean; signal?: AbortSignal },
): Promise<AggregatedResult> {
	const aggregatedChanges: AstReplaceChange[] = []
	const fileCounts = new Map<string, number>()
	const parseErrors: string[] = []
	let totalReplacements = 0
	let filesSearched = 0
	let limitReached = false
	let applied = !options.dryRun
	for (const target of targets) {
		const targetResult = await astEdit({
			rewrites: options.rewrites,
			path: target.basePath,
			glob: target.glob,
			dryRun: options.dryRun,
			maxFiles: MAX_FILES,
			failOnParseError: false,
			signal: options.signal,
		})
		totalReplacements += targetResult.totalReplacements
		filesSearched += targetResult.filesSearched
		limitReached = limitReached || targetResult.limitReached
		applied = applied && targetResult.applied
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors)
		for (const change of targetResult.changes) {
			const absolute = path.resolve(target.basePath, change.path)
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, '/')
			aggregatedChanges.push({ ...change, path: rebased })
		}
		for (const fileChange of targetResult.fileChanges) {
			const absolute = path.resolve(target.basePath, fileChange.path)
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, '/')
			fileCounts.set(rebased, (fileCounts.get(rebased) ?? 0) + fileChange.count)
		}
	}
	return {
		changes: aggregatedChanges,
		fileChanges: Array.from(fileCounts, ([changePath, count]) => ({ path: changePath, count })),
		totalReplacements,
		filesTouched: fileCounts.size,
		filesSearched,
		applied,
		limitReached,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	}
}

/** Split a target entry into a search root plus an optional glob filter. */
function splitTarget(entry: string): { basePath: string; glob?: string } {
	// Glob-shaped entries keep their nearest existing ancestor as the walk root;
	// literal paths are used as-is. Mirrors pi-walker's expectations.
	const hasGlobChars = /[*?[\]{}]/.test(entry)
	if (!hasGlobChars) return { basePath: entry }
	const normalized = entry.replace(/\\/g, '/')
	const slash = normalized.search(/[/][^/]*[*?[\]{]/)
	if (slash === -1) return { basePath: entry }
	const base = normalized.slice(0, slash) || '/'
	const glob = normalized.slice(slash + 1)
	return { basePath: base, glob }
}

export function registerAstEdit(ctx: Context): void {
	ctx.tools.register(
		defineTool({
			name: 'ast_edit',
			description:
				'Perform AST-aware code edits (structural refactoring) via ast-grep rewrite rules. ' +
				'Each op rewrites every match of an ast pattern to a replacement template; metavariables ' +
				'($A, $$$ARGS) enforce identity between pattern and replacement. A dry run previews all ' +
				'replacements before they are applied.',
			parameters: {
				ops: {
					type: 'array',
					required: true,
					items: {
						type: 'object',
						properties: {
							pat: { type: 'string', required: true, description: 'ast pattern' },
							out: { type: 'string', required: true, description: 'replacement template' },
						},
						additionalProperties: false,
					},
					description: 'rewrite ops',
				} as any,
				paths: {
					type: 'array',
					required: true,
					items: { type: 'string' },
					description: 'files, directories, or globs to rewrite',
				} as any,
			},
			output: {
				schema: { type: 'string' },
				render(_args, value) {
					return [{ type: 'text', text: String(value) }]
				},
			},
			isConcurrencySafe: () => false,
			async execute(rawArgs: { ops: Array<{ pat: string; out: string }>; paths: string[] }, exec) {
				const opsInput = Array.isArray(rawArgs.ops) ? rawArgs.ops : []
				if (opsInput.length === 0) throw new Error('`ops` must include at least one op entry')
				const ops = opsInput.map((entry, index) => {
					if (!entry || typeof entry.pat !== 'string' || entry.pat.length === 0) {
						throw new Error(`\`ops[${index}].pat\` must be a non-empty pattern`)
					}
					return { pat: entry.pat, out: String(entry.out ?? '') }
				})
				const seenPatterns = new Set<string>()
				for (const op of ops) {
					if (seenPatterns.has(op.pat)) throw new Error(`Duplicate rewrite pattern: ${op.pat}`)
					seenPatterns.add(op.pat)
				}
				const rawPaths = Array.isArray(rawArgs.paths) ? rawArgs.paths.filter(p => typeof p === 'string' && p.length > 0) : []
				if (rawPaths.length === 0) throw new Error('`paths` must include at least one file, directory, or glob')

				const cwd: string = (exec.agent as any)?.session?.header?.cwd ?? process.cwd()
				const targets = rawPaths.map(entry => {
					const resolved = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)
					return splitTarget(resolved)
				})
				const commonBasePath = cwd
				const rewrites = toRewrites(ops)

				// Dry run first (OMP parity): preview every replacement before writing.
				const preview = await runAstEditTargets(targets, commonBasePath, { rewrites, dryRun: true, signal: exec.signal })
				const parseErrorBlock =
					preview.parseErrors && preview.parseErrors.length > 0
						? `\nParse errors (${preview.parseErrors.length}):\n${preview.parseErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}`
						: ''
				if (preview.totalReplacements === 0) {
					return `No replacements made${parseErrorBlock}`
				}

				// Preview text: grouped -/+ first-line pairs per file.
				const changesByFile = new Map<string, AstReplaceChange[]>()
				for (const change of preview.changes) {
					const list = changesByFile.get(change.path) ?? []
					list.push(change)
					changesByFile.set(change.path, list)
				}
				const previewLines: string[] = []
				for (const [filePath, changes] of changesByFile) {
					previewLines.push(filePath)
					for (const change of changes) {
						const beforeFirstLine = (change.before.split('\n', 1)[0] ?? '').slice(0, 120)
						const afterFirstLine = (change.after.split('\n', 1)[0] ?? '').slice(0, 120)
						previewLines.push(`-${change.startLine}:${beforeFirstLine}`)
						previewLines.push(`+${change.startLine}:${afterFirstLine}`)
					}
				}

				// Apply.
				const applied = await runAstEditTargets(targets, commonBasePath, { rewrites, dryRun: false, signal: exec.signal })
				const summary = [
					`Applied ${applied.totalReplacements} replacement(s) across ${applied.filesTouched} file(s) (${applied.filesSearched} searched).`,
					applied.limitReached ? `File cap (${MAX_FILES}) reached — narrow \`paths\` to continue.` : '',
				]
					.filter(Boolean)
					.join(' ')
				return `${summary}\n\n${previewLines.join('\n')}${parseErrorBlock}`
			},
		}),
	)
}
