/**
 * DSH bun:sqlite shim (node:sqlite implementation).
 *
 * OMP tool code (copied verbatim into adapter/omp) imports `bun:sqlite` and
 * relies on Bun's synchronous SQLite API. Node 22 exposes the same SQLite
 * engine through `node:sqlite` (`DatabaseSync` / `StatementSync`, experimental
 * but flag-free since 22.13); this module re-implements the Bun API subset the
 * ported code actually uses so the OMP sources type-check and run unchanged.
 *
 * API differences absorbed here:
 * - `new Database(path, { readonly })` → `new DatabaseSync(path, { readOnly })`
 *   (node uses camelCase `readOnly`; bun uses lowercase `readonly`).
 * - bun `create` / `strict` options have no node counterpart: `create` is
 *   honoured by refusing to open a missing file, and `strict` is ignored
 *   (node:sqlite STRICT-table handling is a per-CREATE concern, not a flag).
 * - bun `db.run(sql)` → node `db.exec(sql)` (both execute SQL without a
 *   returned row set).
 * - node `StatementSync.get` returns `undefined` (no row) — the shim maps it
 *   to `null` so bun-shaped callers that declare `T | null` type-check.
 * - node `StatementSync.all` returns `[]` (no rows) — bun matches too; the
 *   shim keeps node's array and normalises `null` to `[]` defensively.
 * - bun `Statement.paramsCount` / `Statement.columnNames` → derived from the
 *   node statement's `sourceSQL` (parameter scan) and `columns()` metadata.
 * - node has no `Statement.finalize()` — statements are closed with the
 *   database, so `finalize()` is a safe no-op.
 * - bun `db.transaction(fn)` → BEGIN/COMMIT/ROLLBACK wrapper.
 *
 * Bindings: bun accepts booleans; node:sqlite rejects them (see the note in
 * `src/tools/shared/sqlite-reader.ts`). `SQLQueryBindings` therefore includes
 * `boolean` to match the unmodified OMP write code, and the shim coerces
 * booleans to `1`/`0` before handing values to node:sqlite.
 *
 * Node < 22.13 needs `--experimental-sqlite` and before 22.5 has no
 * `node:sqlite` at all; when the module is missing we throw a clear error.
 */
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync, SQLInputValue } from 'node:sqlite'
import { existsSync } from 'node:fs'

/**
 * Bindings bun:sqlite accepts. Includes `boolean` because the unmodified OMP
 * write path passes booleans directly; the shim coerces them to `1`/`0` for
 * node:sqlite, which rejects them.
 */
export type SQLQueryBindings = string | number | bigint | boolean | null | Uint8Array

/** Coerce a bun-legal binding into a node:sqlite-legal value (boolean → 1/0). */
function coerceBinding(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  return value as SQLInputValue
}

/** Constructor options for {@link Database} — a superset of bun's surface. */
export interface DatabaseOptions {
  readonly?: boolean
  create?: boolean
  strict?: boolean
}

/**
 * Count SQL placeholder parameters (`?`/`?NNN`/`:name`/`@name`/`$name`)
 * outside quoted strings and comments. Replaces bun's `Statement.paramsCount`,
 * which node:sqlite does not expose.
 */
function countPlaceholders(sql: string): number {
  let count = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = index + 1 < sql.length ? sql[index + 1]! : undefined
    if (inLineComment) {
      if (char === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }
    if (inSingleQuote) {
      if (char === "'" && next === "'") index++
      else if (char === "'") inSingleQuote = false
      continue
    }
    if (inDoubleQuote) {
      if (char === '"' && next === '"') index++
      else if (char === '"') inDoubleQuote = false
      continue
    }
    if (char === "'") {
      inSingleQuote = true
      continue
    }
    if (char === '"') {
      inDoubleQuote = true
      continue
    }
    if (char === '-' && next === '-') {
      inLineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }
    if (char === '?') {
      count++
      continue
    }
    if (char === ':' || char === '@' || char === '$') {
      // Named parameter — count once per `:name`/`@name`/`$name` token. A
      // bare `:` that is not part of an identifier is not a parameter.
      const identStart = index + 1
      let identEnd = identStart
      while (identEnd < sql.length && /[A-Za-z0-9_]/.test(sql[identEnd]!)) identEnd++
      if (identEnd > identStart) {
        count++
        index = identEnd - 1
      }
    }
  }
  return count
}

/** Wrap a node `StatementSync` in Bun's `Statement` surface. */
export class Statement<T = unknown, B extends unknown[] = unknown[]> {
  readonly #s: StatementSync

  constructor(s: StatementSync) {
    this.#s = s
  }

  /** First result row as `T`, or `null` when the query returned no row. */
  get(...params: B): T | null {
    const row = this.#s.get(...(params.map(coerceBinding) as SQLInputValue[]))
    return row === undefined || row === null ? null : (row as T)
  }

  /** All result rows; node returns `[]` when there are none — normalise to that. */
  all(...params: B): T[] {
    const rows = this.#s.all(...(params.map(coerceBinding) as SQLInputValue[]))
    return (rows ?? []) as T[]
  }

  /** Execute a write statement; returns affected-row and insert info. */
  run(...params: B): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.#s.run(...(params.map(coerceBinding) as SQLInputValue[]))
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  /** Lazily iterate over result rows. */
  iterate(...params: B): IterableIterator<T> {
    return this.#s.iterate(...(params.map(coerceBinding) as SQLInputValue[])) as IterableIterator<T>
  }

  /** Number of bind parameters in the prepared SQL. */
  get paramsCount(): number {
    return countPlaceholders(this.#s.sourceSQL)
  }

  /** Column names of the result set (for SELECT statements). */
  get columnNames(): string[] {
    try {
      return this.#s.columns().map(column => column.name)
    } catch {
      return []
    }
  }

  /** bun's `finalize()` — node closes statements with the database, so no-op. */
  finalize(): void {
    /* node:sqlite has no per-statement finalize; the owning DatabaseSync owns
       statement lifetime. Keeping the method keeps bun-shaped callers valid. */
  }
}

/** Wrap a node `DatabaseSync` in a bun `Database` surface. */
export class Database {
  private readonly s: DatabaseSync

  constructor(path: string, opts?: DatabaseOptions) {
    if (typeof DatabaseSync === 'undefined') {
      throw new Error(
        'DSH: node:sqlite is unavailable in this Node runtime. ' +
          'It requires Node >= 22.13 (without a flag) or >= 22.5 with --experimental-sqlite.',
      )
    }
    // bun `create:false` refuses to open a missing file (node's default
    // creates it unless readOnly). Honour that before handing off.
    const readOnly = opts?.readonly === true
    if (!readOnly && opts?.create === false && !existsSync(path)) {
      throw new Error(`Unable to open database: no such file '${path}'`)
    }
    this.s = new DatabaseSync(path, { readOnly })
    // bun `strict` has no node equivalent — nothing to forward.
  }

  /** Compile a prepared statement. */
  prepare<T = unknown, B extends unknown[] = unknown[]>(sql: string): Statement<T, B> {
    return new Statement<T, B>(this.s.prepare(sql))
  }

  /** Execute a SQL string directly (bun `db.run`); no result row set. */
  run(sql: string): void {
    this.s.exec(sql)
  }

  /** Execute one or more SQL statements. */
  exec(sql: string): void {
    this.s.exec(sql)
  }

  /** Run `fn` inside a BEGIN/COMMIT transaction, rolling back on throw. */
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const wrapped = (...args: Parameters<T>): ReturnType<T> => {
      this.s.exec('BEGIN')
      try {
        const result = fn(...args)
        this.s.exec('COMMIT')
        return result as ReturnType<T>
      } catch (err) {
        try {
          this.s.exec('ROLLBACK')
        } catch {
          /* rollback failure is unrecoverable — preserve the original error */
        }
        throw err
      }
    }
    return wrapped as T
  }

  close(): void {
    this.s.close()
  }
}
