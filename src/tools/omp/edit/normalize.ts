/**
 * Text normalization utilities for the edit tool.
 *
 * Whitespace, Unicode, and indentation helpers. Line-ending and BOM
 * primitives live in `@oh-my-pi/hashline` and are re-exported here so
 * existing consumers see one stable surface.
 */

import { padding } from "@oh-my-pi/pi-tui";

export {
	type BomResult,
	detectLineEnding,
	type LineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "@oh-my-pi/hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Whitespace Utilities
// ═══════════════════════════════════════════════════════════════════════════

/** Count leading whitespace characters in a line */
export function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/** Get the leading whitespace string from a line */
export function getLeadingWhitespace(line: string): string {
	return line.slice(0, countLeadingWhitespace(line));
}

function isNonEmptyLine(line: string): boolean {
	return line.trim().length > 0;
}

/** Compute minimum indentation of non-empty lines */
export function minIndent(text: string): number {
	const lines = text.split("\n");
	let min = Infinity;
	for (const line of lines) {
		if (isNonEmptyLine(line)) {
			min = Math.min(min, countLeadingWhitespace(line));
		}
	}
	return min === Infinity ? 0 : min;
}

/** Detect the indentation character used in text (space or tab) */
export function detectIndentChar(text: string): string {
	const lines = text.split("\n");
	for (const line of lines) {
		const ws = getLeadingWhitespace(line);
		if (ws.length > 0) {
			return ws[0];
		}
	}
	return " ";
}

function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const temp = y;
		y = x % y;
		x = temp;
	}
	return x;
}

interface IndentProfile {
	lines: string[];
	indentCounts: number[];
	char: " " | "\t" | undefined;
	spaceOnly: boolean;
	tabOnly: boolean;
	mixed: boolean;
	unit: number;
	nonEmptyCount: number;
}

function buildIndentProfile(text: string): IndentProfile {
	const lines = text.split("\n");
	const indentCounts: number[] = [];
	let char: " " | "\t" | undefined;
	let spaceOnly = true;
	let tabOnly = true;
	let mixed = false;
	let nonEmptyCount = 0;
	let unit = 0;

	for (const line of lines) {
		if (!isNonEmptyLine(line)) continue;
		nonEmptyCount++;
		const indent = getLeadingWhitespace(line);
		indentCounts.push(indent.length);
		if (indent.includes(" ")) {
			tabOnly = false;
		}
		if (indent.includes("\t")) {
			spaceOnly = false;
		}
		if (indent.includes(" ") && indent.includes("\t")) {
			mixed = true;
		}
		if (indent.length > 0) {
			const currentChar = indent[0] as " " | "\t";
			if (!char) {
				char = currentChar;
			} else if (char !== currentChar) {
				mixed = true;
			}
		}
	}

	if (spaceOnly && nonEmptyCount > 0) {
		let current = 0;
		for (const count of indentCounts) {
			if (count === 0) continue;
			current = current === 0 ? count : gcd(current, count);
		}
		unit = current;
	}

	if (tabOnly && nonEmptyCount > 0) {
		unit = 1;
	}

	return {
		lines,
		indentCounts,
		char,
		spaceOnly,
		tabOnly,
		mixed,
		unit,
		nonEmptyCount,
	};
}

export function convertLeadingTabsToSpaces(text: string, spacesPerTab: number): string {
	if (spacesPerTab <= 0) return text;
	return text
		.split("\n")
		.map(line => {
			const trimmed = line.trimStart();
			if (trimmed.length === 0) return line;
			const leading = getLeadingWhitespace(line);
			if (!leading.includes("\t") || leading.includes(" ")) return line;
			const converted = padding(leading.length * spacesPerTab);
			return converted + trimmed;
		})
		.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Unicode Normalization
// ═══════════════════════════════════════════════════════════════════════════

const UNICODE_REPLACEMENTS: [RegExp, string][] = [
	// Various dash/hyphen code-points → ASCII '-'
	[/[\u2010-\u2015\u2212]/g, "-"],
	// Fancy single quotes → '
	[/[\u2018-\u201B]/g, "'"],
	// Fancy double quotes → "
	[/[\u201C-\u201F]/g, '"'],
	// Non-breaking space and other odd spaces → normal space
	[/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "],
	// Not-equal sign → !=
	[/\u2260/g, "!="],
	// Vulgar fraction ½ → 1/2
	[/\u00BD/g, "1/2"],
	// Zero-width characters → remove
	[/[\u200B-\u200D\uFEFF]/g, ""],
];

export function normalizeUnicode(s: string): string {
	let result = s.trim();
	for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}
	return result.normalize("NFC");
}

/**
 * Normalize a line for fuzzy comparison.
 * Trims, collapses whitespace, and normalizes punctuation.
 *
 * 与上游 17.3.5 的差异：原实现自带一份替换表，字符类里前两个都是 ASCII 引号
 * （U+0022/U+0027 各写了两遍），漏掉最常见的弯双引号 U+201C/U+201D 与弯单引号
 * U+2018/U+2019，不换行空格与零宽字符也不处理。同文件的 UNICODE_REPLACEMENTS
 * 表（normalizeUnicode 用）范围是全的，这里直接复用，避免两份表再次漂移。
 * 上游 Rust 重写版 crates/pi-edit/src/text.rs 保留了同样的缺陷，修复需另开补丁。
 */
export function normalizeForFuzzy(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "";

	// 纯 ASCII 快路径：UNICODE_REPLACEMENTS 里的字符全部在 U+0080 以上，NFC 对纯 ASCII
	// 也是恒等，所以这类行只需要处理反引号与空白折叠。逐字符扫描比整串跑七条正则快一倍多，
	// 而真实代码里绝大多数行都是纯 ASCII；含非 ASCII 的行原样走下面那条慢路径。
	let hasBacktick = false;
	let ascii = true;
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code >= 0x80) {
			ascii = false;
			break;
		}
		if (code === 0x60) hasBacktick = true;
	}
	if (ascii) {
		const folded = hasBacktick ? trimmed.replace(/\u0060/g, "'") : trimmed;
		return folded.replace(/[ \t]+/g, " ");
	}

	// 法式引号与反引号/重音符不在 UNICODE_REPLACEMENTS 的区间里，旧实现是单独折叠的，保留这两步。
	const normalized = normalizeUnicode(trimmed)
		.replace(/[\u00AB\u00BB]/g, '"')
		.replace(/[\u0060\u00B4]/g, "'");
	if (normalized.length === 0) return "";
	return normalized.replace(/[ \t]+/g, " ");
}

function isIndentationOnlyRewrite(oldText: string, newText: string): boolean {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	if (oldLines.length !== newLines.length) {
		return false;
	}
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i].trim() !== newLines[i].trim()) {
			return false;
		}
	}
	return true;
}

function maybeConvertTabIndentation(
	oldProfile: IndentProfile,
	actualProfile: IndentProfile,
	newProfile: IndentProfile,
	newText: string,
): string | undefined {
	if (!actualProfile.spaceOnly || !oldProfile.tabOnly || !newProfile.tabOnly || actualProfile.unit <= 0) {
		return undefined;
	}

	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		const oldIndent = getLeadingWhitespace(oldLine);
		if (oldIndent.length === 0) continue;
		const actualIndent = getLeadingWhitespace(actualLine);
		if (actualIndent.length !== oldIndent.length * actualProfile.unit) {
			return undefined;
		}
	}

	return convertLeadingTabsToSpaces(newText, actualProfile.unit);
}

function computeUniformIndentDelta(oldProfile: IndentProfile, actualProfile: IndentProfile): number | undefined {
	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	const deltas: number[] = [];
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine));
	}

	if (deltas.length === 0) {
		return undefined;
	}

	const delta = deltas[0];
	return deltas.every(value => value === delta) ? delta : undefined;
}

function applyIndentDelta(text: string, delta: number, indentChar: string): string {
	const adjusted = text.split("\n").map(line => {
		if (!isNonEmptyLine(line)) {
			return line;
		}
		if (delta > 0) {
			return indentChar.repeat(delta) + line;
		}
		const toRemove = Math.min(-delta, countLeadingWhitespace(line));
		return line.slice(toRemove);
	});

	return adjusted.join("\n");
}

function hasNonEmptyIndentProfiles(...profiles: IndentProfile[]): boolean {
	return profiles.every(profile => profile.nonEmptyCount > 0);
}

function hasMixedIndentation(...profiles: IndentProfile[]): boolean {
	return profiles.some(profile => profile.mixed);
}

// ═══════════════════════════════════════════════════════════════════════════
// Indentation Adjustment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adjust newText indentation to match the indentation delta between
 * what was provided (oldText) and what was actually matched (actualText).
 *
 * If oldText has 0 indent but actualText has 12 spaces, we add 12 spaces
 * to each line in newText.
 */
export function adjustIndentation(oldText: string, actualText: string, newText: string): string {
	// If old text already matches actual text exactly, preserve agent's intended indentation
	if (oldText === actualText) {
		return newText;
	}

	// If the patch is purely an indentation change (same trimmed content), apply exactly as specified
	if (isIndentationOnlyRewrite(oldText, newText)) {
		return newText;
	}

	const oldProfile = buildIndentProfile(oldText);
	const actualProfile = buildIndentProfile(actualText);
	const newProfile = buildIndentProfile(newText);

	if (!hasNonEmptyIndentProfiles(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (hasMixedIndentation(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (oldProfile.char && actualProfile.char && oldProfile.char !== actualProfile.char) {
		const converted = maybeConvertTabIndentation(oldProfile, actualProfile, newProfile, newText);
		if (converted !== undefined) {
			return converted;
		}
		return newText;
	}

	const delta = computeUniformIndentDelta(oldProfile, actualProfile);
	if (delta === undefined || delta === 0) {
		return newText;
	}

	if (newProfile.char && actualProfile.char && newProfile.char !== actualProfile.char) {
		return newText;
	}

	const indentChar = actualProfile.char ?? oldProfile.char ?? detectIndentChar(actualText);
	return applyIndentDelta(newText, delta, indentChar);
}
