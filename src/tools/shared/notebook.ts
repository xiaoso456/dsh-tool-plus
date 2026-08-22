/**
 * Notebook (.ipynb) editable-text round-trip — port of OMP
 * refs/oh-my-pi/packages/coding-agent/src/edit/notebook.ts.
 *
 * ONE shared implementation for read AND edit/write: the read tool renders the
 * exact same editable text the edit tool parses back, so what the model sees
 * is what it can patch ("# %% [code] cell:N" markers, single-\n joins,
 * marker-shaped source lines escaped on render and restored on parse).
 *
 * History: read/ previously carried a second hand-rolled renderer emitting
 * "# %% [cell N] (type)" with blank-line joins and no escaping, which broke
 * the round-trip contract (T10-1) — two implementations of one format is a
 * bug; both sides must share this module.
 */

export function isNotebookPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith('.ipynb')
}

export const CELL_MARKER_RE = /^# %% \[(code|markdown|raw)\](?: cell:(\d+))?$/;
const ESCAPABLE_MARKER_RE = /^# %%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;
const ESCAPED_MARKER_RE = /^# %%%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;

function escapeMarkerLikeSourceLines(source: string): string {
	if (!source.includes('# %%')) return source;
	return source.split('\n').map((l) => (ESCAPABLE_MARKER_RE.test(l) ? l.replace('# %', '# %%') : l)).join('\n');
}
function unescapeMarkerLikeLine(line: string): string {
	return ESCAPED_MARKER_RE.test(line) ? line.replace('# %%', '# %') : line;
}
export function sourceToText(source: string | string[] | undefined): string {
	if (source === undefined) return '';
	if (typeof source === 'string') return source;
	return source.join('');
}
export function splitNotebookSource(content: string): string[] {
	if (content.length === 0) return [];
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// ---------------------------------------------------------------------------
// Validation — wording mirrors OMP validateNotebook / readNotebookDocument
// ---------------------------------------------------------------------------
function isRecord(v: any): boolean {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isCellType(t: any): boolean {
	return t === 'code' || t === 'markdown' || t === 'raw';
}

/** Validate a parsed .ipynb JSON value; throws OMP-worded errors on bad shape. */
export function validateNotebook(value: any, displayPath: string): any {
	if (!isRecord(value)) {
		throw new Error(`Invalid notebook structure (expected object): ${displayPath}`);
	}
	if (!Array.isArray(value.cells)) {
		throw new Error(`Invalid notebook structure (missing cells array): ${displayPath}`);
	}
	for (let index = 0; index < value.cells.length; index++) {
		const cell = value.cells[index];
		if (!isRecord(cell) || !isCellType(cell.cell_type)) {
			throw new Error(`Invalid notebook cell ${index} in ${displayPath}`);
		}
	}
	return value;
}

/** Parse raw .ipynb text and validate; SyntaxError maps to OMP's wording. */
export function parseNotebookDocument(rawText: string, displayPath: string): any {
	let value: any;
	try {
		value = JSON.parse(rawText);
	} catch {
		throw new Error(`Invalid JSON in notebook: ${displayPath}`);
	}
	return validateNotebook(value, displayPath);
}

export function notebookToEditableText(notebook: any): string {
	return notebook.cells
		.map((cell: any, index: number) => {
			const source = escapeMarkerLikeSourceLines(sourceToText(cell.source));
			return source.length > 0 ? `# %% [${cell.cell_type}] cell:${index}\n${source}` : `# %% [${cell.cell_type}] cell:${index}`;
		})
		.join('\n');
}

/** Raw .ipynb text → editable cell text (parse + validate + convert). */
export function readEditableNotebookText(rawText: string, displayPath: string): string {
	return notebookToEditableText(parseNotebookDocument(rawText, displayPath));
}

export interface ParsedVirtualCell {
	cellType: string;
	cellIndex?: number;
	source: string;
}

export function parseNotebookEditableText(text: string, displayPath: string): ParsedVirtualCell[] {
	const lines = text.length === 0 ? [] : text.split('\n');
	const cells: ParsedVirtualCell[] = [];
	let current: { cellType: string; cellIndex?: number; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		cells.push({ cellType: current.cellType, cellIndex: current.cellIndex, source: current.lines.join('\n') });
	};
	for (const line of lines) {
		const m = CELL_MARKER_RE.exec(line);
		if (m) {
			flush();
			current = { cellType: m[1]!, cellIndex: m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined, lines: [] };
			continue;
		}
		if (!current) throw new Error(`Invalid notebook editable representation for ${displayPath}: expected first line to be "# %% [code] cell:0", "# %% [markdown] cell:0", or "# %% [raw] cell:0".`);
		current.lines.push(unescapeMarkerLikeLine(line));
	}
	flush();
	return cells;
}

export function applyNotebookEditableText(notebook: any, text: string, displayPath: string): any {
	const parsed = parseNotebookEditableText(text, displayPath);
	const used = new Set<number>();
	const next = structuredClone(notebook);
	next.cells = parsed.map((p) => {
		const idx = p.cellIndex;
		const orig = idx !== undefined && idx >= 0 && idx < notebook.cells.length && !used.has(idx) ? notebook.cells[idx] : undefined;
		if (orig) {
			used.add(idx!);
			const cell = structuredClone(orig);
			cell.cell_type = p.cellType;
			cell.source = splitNotebookSource(p.source);
			if (p.cellType === 'code') {
				cell.execution_count ??= null;
				cell.outputs ??= [];
			} else {
				delete cell.execution_count;
				delete cell.outputs;
			}
			return cell;
		}
		const cell: any = { cell_type: p.cellType, metadata: {}, source: splitNotebookSource(p.source) };
		if (p.cellType === 'code') {
			cell.execution_count = null;
			cell.outputs = [];
		}
		return cell;
	});
	return next;
}
