/**
 * Coding-agent specific {@link Filesystem} adapter for the hashline patcher.
 *
 * Wires hashline's storage abstraction to the agent runtime:
 *
 * - Section paths are resolved through the plan-mode redirect so a bare
 *   `PLAN.md` lands at the canonical session artifact location.
 * - Reads go through `readEditFileText` (notebook-aware) and the
 *   auto-generated-file guard.
 * - Writes go through `serializeEditFileText` (notebook-aware) and the
 *   file-write channel, with FS-scan cache invalidation on success.
 *
 * Construct one per `executeHashlineSingle` call: per-section state
 * lives on the instance and isn't safe to share across concurrent edit tools.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Filesystem, NotFoundError, type PreflightWriteOptions, type WriteResult } from "@oh-my-pi/hashline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { WritethroughCallback } from "../../../omp/tools/writethrough.ts";
import type { ToolSession } from "../../../omp/tools/index.ts";
import { assertEditableFileContent } from "../../../edit/adapter/tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../../omp/tools/fs-cache-invalidation.ts";
import { isInternalUrlPath } from "../../../omp/tools/path-utils.ts";
import { enforcePlanModeWrite, resolvePlanPath, targetsLocalSandbox } from "../../../edit/adapter/tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../../../omp/edit/file-snapshot-store.ts";
import { isNotebookPath } from "../../../omp/edit/notebook.ts";
import { readEditFileText, serializeEditFileText } from "../read-file";

export interface HashlineFilesystemOptions {
	session: ToolSession;
	writethrough: WritethroughCallback;
	signal?: AbortSignal;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #writethrough: WritethroughCallback;
	readonly #signal: AbortSignal | undefined;

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#writethrough = options.writethrough;
		this.#signal = options.signal;
	}

	resolveAbsolute(relativePath: string): string {
		return resolvePlanPath(this.session, relativePath);
	}

	override canonicalPath(relativePath: string): string {
		return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
	}

	override allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
		// Internal-URL authored targets (`local://`, `vault://`, …) are approved
		// at the lower "read" privilege; never let one redirect onto a "write".
		if (isInternalUrlPath(authoredPath)) return false;
		// Recovery rebinds a bare/mis-typed authored path onto the file its
		// snapshot tag uniquely names. Confine the redirect to locations a plain
		// "write" may legitimately target:
		//  1. the working tree (the model dropped the directory), or
		//  2. the session `local://` sandbox where plan/scratch artifacts live —
		//     the snapshot tag proves the model wrote/read that exact file this
		//     session, so a bare `plan.md#tag` should land on `local://plan.md`.
		// The secret vault and any other out-of-tree path stay refused.
		const root = canonicalSnapshotKey(this.session.cwd);
		if (resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`)) return true;
		return targetsLocalSandbox(this.session, resolvedPath);
	}

	async readText(relativePath: string): Promise<string> {
		const absolutePath = this.resolveAbsolute(relativePath);
		let content: string;
		try {
			content = await readEditFileText(absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}
		// Refuse edits against generated files (lockfiles, models.json, …).
		assertEditableFileContent(content, relativePath, this.session.settings);
		return content;
	}

	override async readBinary(relativePath: string): Promise<Uint8Array | undefined> {
		const absolutePath = this.resolveAbsolute(relativePath);
		if (isNotebookPath(absolutePath)) return undefined;
		try {
			return await fs.readFile(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
	}

	override async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
		const fileOp = options?.fileOp;
		if (fileOp?.kind === "rem") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			return;
		}
		if (fileOp?.kind === "move") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update", move: fileOp.dest });
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	override async delete(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		const absolutePath = this.resolveAbsolute(relativePath);
		try {
			await fs.rm(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		invalidateFsScanAfterWrite(absolutePath);
	}

	override async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		const fromAbsolute = this.resolveAbsolute(fromRelative);
		const toAbsolute = this.resolveAbsolute(toRelative);
		if (content !== undefined) {
			await Bun.write(toAbsolute, content);
			await fs.rm(fromAbsolute);
		} else {
			await fs.rename(fromAbsolute, toAbsolute);
		}
		invalidateFsScanAfterWrite(fromAbsolute);
		invalidateFsScanAfterWrite(toAbsolute);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);

		const absoluteTarget = absolutePath;
		await this.#writethrough(absoluteTarget, finalContent, this.#signal, Bun.file(absoluteTarget));
		invalidateFsScanAfterWrite(absoluteTarget);
		return { text: content };
	}

	override async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
