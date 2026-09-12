import * as path from "node:path";
import { notebookToEditableText } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
	cell_type: NotebookCellType;
	source?: string | string[];
	metadata?: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
	[key: string]: unknown;
}

export interface NotebookDocument {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
	[key: string]: unknown;
}

const CELL_MARKER_RE = /^# %% \[(code|markdown|raw)\](?: cell:(\d+))?$/;
/**
 * Cell source lines that would themselves parse as (possibly already-escaped)
 * cell markers gain one extra `%` on render and lose it on parse, so a
 * notebook that *contains* the literal text `# %% [markdown] cell:3` survives
 * the editable-text round trip instead of being split into extra cells.
 *
 * Only the *unescape* half lives here. Rendering is the engine's own codec
 * (`readEditableNotebookText` → `pi-natives`), so its escape half went with
 * the TS renderer that used to duplicate it.
 */
const ESCAPED_MARKER_RE = /^# %%%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;

function unescapeMarkerLikeLine(line: string): string {
	return ESCAPED_MARKER_RE.test(line) ? line.replace("# %%", "# %") : line;
}

export function isNotebookPath(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".ipynb";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCellType(value: unknown): value is NotebookCellType {
	return value === "code" || value === "markdown" || value === "raw";
}

export function splitNotebookSource(content: string): string[] {
	if (content.length === 0) return [];
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function cloneCell(cell: NotebookCell): NotebookCell {
	return structuredClone(cell);
}

function createNotebookCell(cellType: NotebookCellType, source: string): NotebookCell {
	const cell: NotebookCell = {
		cell_type: cellType,
		metadata: {},
		source: splitNotebookSource(source),
	};
	if (cellType === "code") {
		cell.execution_count = null;
		cell.outputs = [];
	}
	return cell;
}

function createEmptyNotebook(): NotebookDocument {
	return {
		cells: [],
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	};
}

function validateNotebook(value: unknown, displayPath: string): NotebookDocument {
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
	return value as unknown as NotebookDocument;
}

export async function readNotebookDocument(absolutePath: string, displayPath: string): Promise<NotebookDocument> {
	try {
		// Strip a leading UTF-8 BOM before parsing, matching the native engine
		// (`crates/pi-edit/src/notebook.rs::notebook_to_editable_text` drops
		// `\u{feff}` first). This is an alignment with the 18.x Rust engine, not a
		// regression fix: v17.3.5's upstream `edit/notebook.ts` was byte-identical
		// to the code below (`Bun.file(...).json()` with no BOM handling), so the
		// old TS engine could not read a BOM-prefixed notebook either. Without
		// this, `JSON.parse` rejects U+FEFF and the read leg throws
		// `Invalid JSON in notebook` for a file the engine edits happily.
		const text = (await Bun.file(absolutePath).text()).replace(/^\uFEFF/, "");
		return validateNotebook(JSON.parse(text), displayPath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${displayPath}`);
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in notebook: ${displayPath}`);
		throw error;
	}
}

interface ParsedVirtualCell {
	cellType: NotebookCellType;
	cellIndex?: number;
	source: string;
}

function parseVirtualCellMarker(line: string): { cellType: NotebookCellType; cellIndex?: number } | undefined {
	const match = CELL_MARKER_RE.exec(line);
	if (!match) return undefined;
	const cellType = match[1] as NotebookCellType;
	const cellIndexText = match[2];
	return {
		cellType,
		cellIndex: cellIndexText === undefined ? undefined : Number.parseInt(cellIndexText, 10),
	};
}

function linesToSourceText(lines: string[]): string {
	if (lines.length === 0) return "";
	return lines.join("\n");
}

function parseNotebookEditableText(text: string, displayPath: string): ParsedVirtualCell[] {
	const lines = text.length === 0 ? [] : text.split("\n");
	const cells: ParsedVirtualCell[] = [];
	let current: { cellType: NotebookCellType; cellIndex?: number; lines: string[] } | undefined;

	const flush = () => {
		if (!current) return;
		cells.push({
			cellType: current.cellType,
			cellIndex: current.cellIndex,
			source: linesToSourceText(current.lines),
		});
	};

	for (const line of lines) {
		const marker = parseVirtualCellMarker(line);
		if (marker) {
			flush();
			current = { ...marker, lines: [] };
			continue;
		}
		if (!current) {
			throw new Error(
				`Invalid notebook editable representation for ${displayPath}: expected first line to be "# %% [code] cell:0", "# %% [markdown] cell:0", or "# %% [raw] cell:0".`,
			);
		}
		current.lines.push(unescapeMarkerLikeLine(line));
	}
	flush();
	return cells;
}

export function applyNotebookEditableText(
	notebook: NotebookDocument,
	text: string,
	displayPath: string,
): NotebookDocument {
	const parsedCells = parseNotebookEditableText(text, displayPath);
	const usedOriginalCells = new Set<number>();
	const nextNotebook = structuredClone(notebook);
	nextNotebook.cells = parsedCells.map(parsedCell => {
		const originalIndex = parsedCell.cellIndex;
		const originalCell =
			originalIndex !== undefined &&
			originalIndex >= 0 &&
			originalIndex < notebook.cells.length &&
			!usedOriginalCells.has(originalIndex)
				? notebook.cells[originalIndex]
				: undefined;
		if (originalCell) {
			usedOriginalCells.add(originalIndex!);
			const cell = cloneCell(originalCell);
			cell.cell_type = parsedCell.cellType;
			cell.source = splitNotebookSource(parsedCell.source);
			if (parsedCell.cellType === "code") {
				cell.execution_count ??= null;
				cell.outputs ??= [];
			} else {
				delete cell.execution_count;
				delete cell.outputs;
			}
			return cell;
		}
		return createNotebookCell(parsedCell.cellType, parsedCell.source);
	});
	return nextNotebook;
}

/**
 * Decode a notebook for display and for hashline anchoring.
 *
 * The decode is the **engine's own codec** — `pi-natives`
 * `notebookToEditableText`, the same call upstream's read tool makes
 * (`refs/oh-my-pi/packages/coding-agent/src/tools/read.ts:1599`) — not a
 * second TS implementation. That matters beyond tidiness: `read` mints the
 * hashline tag over this projection and the edit engine validates the live
 * file by projecting it the same way (`crates/pi-edit/src/files.rs:138-142`),
 * so once both sides run the same code their agreement is structural. A
 * hand-maintained copy can only *resemble* the engine, and the first
 * divergence (BOM handling, cell escaping, cell join) silently turns every
 * edit into "file changed between read and edit".
 *
 * Error text is identical to the previous TS decoder, verified over the whole
 * corpus including BOM and every failure shape: the Rust `NotebookError`
 * `Display` strings are verbatim ports. Only ENOENT is ours, because the read
 * has to happen here to keep the `File not found: <display>` message the
 * `read` tool and the patch/replace modes rely on.
 *
 * What stays in this file is the **encode** half (`readNotebookDocument` +
 * `applyNotebookEditableText` + `serializeEditedNotebookText`), which
 * `native/writer.ts` no longer uses — the engine serializes notebooks itself
 * for the hashline path. It survives only because the native surface exposes
 * no encoder and DSH's own patch/replace/write paths still need one; deleting
 * it means migrating those modes onto the Rust engine (the same move this
 * migration made for hashline), which is the remaining half of the work.
 */
export async function readEditableNotebookText(absolutePath: string, displayPath: string): Promise<string> {
	let json: string;
	try {
		json = await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${displayPath}`);
		throw error;
	}
	return notebookToEditableText(json, displayPath);
}

export async function serializeEditedNotebookText(
	absolutePath: string,
	displayPath: string,
	text: string,
): Promise<string> {
	let notebook: NotebookDocument;
	try {
		notebook = await readNotebookDocument(absolutePath, displayPath);
	} catch (error) {
		if (error instanceof Error && error.message === `File not found: ${displayPath}`) {
			notebook = createEmptyNotebook();
		} else {
			throw error;
		}
	}
	const nextNotebook = applyNotebookEditableText(notebook, text, displayPath);
	return JSON.stringify(nextNotebook, null, 1);
}
