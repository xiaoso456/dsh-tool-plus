/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 *
 * A-1 归一（second-impl-audit.md）：bash 链路不再持有第二份 streaming-output
 * 实现。本文件只是 `src/tools/omp/session/streaming-output.ts`（refs
 * oh-my-pi 17.3.5 逐字拷贝）的薄转发/包装：
 *
 *   - 纯函数（truncateHead/Middle/Tail、字节级截断、enforceInlineByteCap、
 *     截断通知格式化、streamTailUpdates）与常量经 `export *` 原样转发；
 *   - `TailBuffer` 组合包装，仅补 DSH 增量 `reset()`（background.ts 的
 *     readOutput 消费游标依赖）；
 *   - `OutputSink` 继承 verbatim 实现，仅保留拍板#20 的 DSH 三增量：
 *       1. `OutputSummary.artifactPath`：spill 镜像真实落盘时回传路径；
 *       2. spill 写失败不致崩：verbatim 侧 `#createFileSink` 吞建流错误、
 *          `#finalizeFile` 吞 flush/end 错误（对应旧 WriteStream 的 error 监听）；
 *       3. `dump()` await 落盘：verbatim `#finalizeFile` 在组装返回前
 *          `await sink.end()`（旧版 once("error")/end(cb) 等待的 Bun 原生等价）。
 *
 * 镜像触发逻辑本身与上游逐字一致（内联 head+tail 窗口溢出 / 列钳制丢字节
 * 时镜像原始流），无需在此重复。本文件禁止重新实现任何上游逻辑；行为修复
 * 请改 `src/tools/omp/session/streaming-output.ts` 并保持与 refs 一致。
 */
import {
	OutputSink as VerbatimOutputSink,
	OutputSummary as VerbatimOutputSummary,
	TailBuffer as VerbatimTailBuffer,
	type OutputSinkOptions,
} from "../omp/session/streaming-output.ts";

// Verbatim 转发：bash 链路与 OMP 上游共用同一实现（A-1 归一）。
// 本地显式导出的 OutputSummary / TailBuffer / OutputSink 优先于星号转发。
export * from "../omp/session/streaming-output.ts";

/**
 * Verbatim `OutputSummary` 加 DSH 增量字段 `artifactPath`。
 */
export interface OutputSummary extends VerbatimOutputSummary {
	/**
	 * Path of the spill file mirroring the raw stream, when one was created.
	 * Present even when only the per-line column cap triggered mirroring.
	 */
	artifactPath?: string;
}

/**
 * Marker passed as the verbatim sink's `artifactId` when the caller configured
 * only `artifactPath`: the verbatim sink reports `artifactId` from its internal
 * file record, which is set exactly when the spill file was created — so the
 * marker doubles as a "mirror exists" signal for surfacing `artifactPath` on
 * {@link OutputSink.dump}. Stripped again before the summary leaves this file.
 */
const SPILL_PATH_ONLY = "__dsh-spill-path-only__";

export class OutputSink extends VerbatimOutputSink {
	readonly #artifactPath?: string;

	constructor(options?: OutputSinkOptions) {
		super({
			...options,
			artifactId: options?.artifactId ?? (options?.artifactPath !== undefined ? SPILL_PATH_ONLY : undefined),
		});
		this.#artifactPath = options?.artifactPath;
	}

	override async dump(notice?: string): Promise<OutputSummary> {
		const { artifactId, ...rest } = await super.dump(notice);
		if (artifactId === SPILL_PATH_ONLY) {
			// Spill mirror was created (verbatim keeps its file record set after
			// finalize) and no caller artifactId was requested: surface the path.
			return { ...rest, artifactPath: this.#artifactPath };
		}
		if (artifactId !== undefined) {
			return { ...rest, artifactId, artifactPath: this.#artifactPath };
		}
		return rest;
	}
}

/**
 * Composition wrapper over the verbatim {@link TailBuffer}, adding the DSH
 * `reset()` increment. The verbatim class keeps its state in private fields,
 * so reset is modeled as a fresh window with the same budget.
 */
export class TailBuffer {
	#inner: VerbatimTailBuffer;

	readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
		this.#inner = new VerbatimTailBuffer(maxBytes);
	}

	append(text: string): void {
		this.#inner.append(text);
	}

	text(): string {
		return this.#inner.text();
	}

	bytes(): number {
		return this.#inner.bytes();
	}

	/** Drop all held output; the next {@link append} starts a fresh window. */
	reset(): void {
		this.#inner = new VerbatimTailBuffer(this.maxBytes);
	}
}