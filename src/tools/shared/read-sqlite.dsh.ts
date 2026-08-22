/**
 * DSH SQLite read orchestration (plan.md 拍板#7 — SQLite 直读).
 *
 * Thin DSH-side equivalent of OMP's `read-sqlite.ts`: candidate resolution via
 * ctx.fs, then selector dispatch through the Node-adapted engine in
 * `sqlite-reader.ts`. The OMP session suffix-match cache and pi-agent
 * result-builder are intentionally absent — DSH tools return plain objects.
 */

import { DatabaseSync } from "node:sqlite";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	isSqliteFile,
	listTables,
	MAX_RAW_QUERY_ROWS,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	queryRows,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
	resolveTableRowLookup,
	type SqliteDatabase,
} from "./sqlite-reader";
import { ToolError } from "./tool-errors";

const DEFAULT_TABLE_LIST_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 20;

export interface SqliteReadResult {
	/** Rendered table list / schema / rows / query output (plain text). */
	text: string;
	/** Real filesystem path of the database that was opened. */
	resolvedPath: string;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new ToolError(signal.reason instanceof Error ? signal.reason.message : "Aborted");
	}
}

export interface SqliteReadProbe {
	handled: boolean;
	text?: string;
}

/**
 * Probe `rawInput` for a SQLite path (`db.sqlite`, `db.sqlite:table`,
 * `db.sqlite:table?limit=…`, `db.sqlite?q=SELECT …`) and render it.
 * Returns `{ handled: false }` when no candidate resolves to an existing
 * SQLite file so the caller can fall through to regular text reading
 * (OMP parity: non-SQLite files keep their normal read path).
 */
export async function trySqliteRead(
	ctx: any,
	rawInput: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<SqliteReadProbe> {
	const candidates = parseSqlitePathCandidates(rawInput);
	if (candidates.length === 0) return { handled: false };
	throwIfAborted(signal);

	let matched: { realPath: string; subPath: string; queryString: string } | undefined;
	for (const candidate of candidates) {
		// Unresolvable candidates are simply not SQLite files — move on.
		const target: any = await ctx.fs.resolve(candidate.sqlitePath, { cwd }).catch(() => null);
		if (!target) continue;
		const stat = await ctx.fs.stat(target).catch(() => null);
		if (!stat || stat.type === "directory") continue;
		const realPath: string = ctx.fs.processPath
			? ctx.fs.processPath(target)
			: ((target as any).displayPath ?? candidate.sqlitePath);
		if (!(await isSqliteFile(realPath))) continue;
		matched = { realPath, subPath: candidate.subPath, queryString: candidate.queryString };
		break;
	}
	if (!matched) return { handled: false };

	const db = new DatabaseSync(matched.realPath, { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 3000");
		throwIfAborted(signal);
		const selector = parseSqliteSelector(matched.subPath, matched.queryString);
		const text = renderSelector(db, selector, matched.realPath);
		return { handled: true, text };
	} finally {
		db.close();
	}
}

/** Dispatch a parsed selector against the open database (OMP readSqlite switch). */
function renderSelector(
	db: SqliteDatabase,
	selector: ReturnType<typeof parseSqliteSelector>,
	dbRealPath: string,
): string {
	switch (selector.kind) {
		case "list": {
			const tables = listTables(db);
			const limited = tables.slice(0, DEFAULT_TABLE_LIST_LIMIT);
			let out = renderTableList(limited);
			if (tables.length > limited.length) {
				out += `\n[Showing ${limited.length} of ${tables.length} tables.]`;
			}
			return out;
		}
		case "schema": {
			const sample = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
			let out = renderSchema(getTableSchema(db, selector.table), {
				columns: sample.columns,
				rows: sample.rows,
			});
			if (sample.rows.length < sample.totalCount) {
				const remaining = sample.totalCount - sample.rows.length;
				out += `\n[${remaining} more rows; append :${selector.table}?limit=${DEFAULT_QUERY_LIMIT}&offset=${sample.rows.length} to the database path to continue]`;
			}
			return out;
		}
		case "row": {
			const lookup = resolveTableRowLookup(db, selector.table);
			const row =
				lookup.kind === "pk"
					? getRowByKey(db, selector.table, lookup, selector.key)
					: getRowByRowId(db, selector.table, selector.key);
			if (!row) {
				return `No row found in table '${selector.table}' for key '${selector.key}'.`;
			}
			return renderRow(row);
		}
		case "query": {
			const page = queryRows(db, selector.table, selector);
			return renderTable(page.columns, page.rows, {
				totalCount: page.totalCount,
				offset: selector.offset,
				limit: selector.limit,
				table: selector.table,
				dbPath: dbRealPath,
			});
		}
		case "raw": {
			const result = executeReadQuery(db, selector.sql);
			let out = renderTable(result.columns, result.rows, {
				totalCount: result.rows.length,
				offset: 0,
				limit: result.rows.length || DEFAULT_QUERY_LIMIT,
				table: "query",
				dbPath: dbRealPath,
			});
			if (result.truncated) {
				out += `\n[Output capped at ${MAX_RAW_QUERY_ROWS} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
			}
			return out;
		}
	}
}
