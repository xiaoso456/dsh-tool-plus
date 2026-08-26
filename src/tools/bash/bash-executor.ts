/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 */
/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import * as fs from "node:fs";
import { type MinimizerOptions, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import { runtimeLogger } from "./logger.ts";
import { buildNonInteractiveEnv } from "./non-interactive-env.ts";
import { getOrCreateSnapshot } from "./shell-snapshot.ts";
import { OutputSink } from "./streaming-output.ts";
import { ExponentialYield } from "./yield.ts";

// ── Shell configuration ─────────────────────────────────────────────────

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}

function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}


let cachedShellConfig: ShellConfig | null = null;

export function getShellConfig(): ShellConfig {
	if (cachedShellConfig) return cachedShellConfig;

	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const p of paths) {
			if (fs.existsSync(p)) {
				cachedShellConfig = { shell: p, args: ["--login", "-c"], env: {}, prefix: undefined };
				return cachedShellConfig;
			}
		}
		// Fallback: bash on PATH
		cachedShellConfig = { shell: "bash", args: ["--login", "-c"], env: {}, prefix: undefined };
		return cachedShellConfig;
	}

	// POSIX: use $SHELL or /bin/bash
	const envShell = process.env.SHELL;
	if (envShell && isExecutable(envShell)) {
		const isZsh = envShell.includes("zsh");
		cachedShellConfig = {
			shell: envShell,
			args: isZsh ? ["-i", "-c"] : ["-c"],
			env: { SHELL: envShell },
			prefix: undefined,
		};
		return cachedShellConfig;
	}
	cachedShellConfig = { shell: "/bin/bash", args: ["-c"], env: {}, prefix: undefined };
	return cachedShellConfig;
}

export const DEFAULT_MINIMIZER_SETTINGS: ShellMinimizerSettings = {
	enabled: true,
	settingsPath: undefined,
	only: [],
	except: [],
	maxCaptureBytes: 512 * 1024,
	sourceOutlineLevel: "default",
	legacyFilters: undefined,
};

export interface BashExecutorOptions {
	cwd?: string;
	/** Milliseconds before aborting the command; 0 disables the executor deadline. */
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Run through the configured user shell instead of brush parsing directly. */
	useUserShell?: boolean;
	/** Capture the user rc snapshot into the session shell (default true). */
	snapshotEnabled?: boolean;
	/** Apply non-interactive env hardening to the command environment (default true). */
	nonInteractiveEnv?: boolean;
	/** Enable intelligent output minimizer. Default true. */
	minimizerEnabled?: boolean;
	/** Minimizer settings (filters, capture budget). Defaults to {@link DEFAULT_MINIMIZER_SETTINGS}. */
	minimizerSettings?: ShellMinimizerSettings;
	/** Wrap the command in `bash -c '…'` before execution (full bash environment). */
	useShellCommandWrapper?: boolean;
	/** OutputSink tail rolling budget (bytes). Falls back to DEFAULT_MAX_BYTES (50KB). */
	spillThreshold?: number;
	/** OutputSink head window (bytes). Falls back to 20KB. */
	headBytes?: number;
	/**
	 * Mirror the full raw output stream to this file while it streams — the
	 * upstream `artifactPath` seam (`session.allocateOutputArtifact("bash")`).
	 * The mirror triggers exactly when the inline head+tail windows overflow,
	 * so a spill file exists whenever output was dropped. Lossless by default
	 * (`ARTIFACT_DEFAULT_MAX_BYTES = 0`).
	 */
	artifactPath?: string;
	/**
	 * Called when the native minimizer rewrote the output, with the original
	 * pre-minimization text (upstream `onMinimizedSave`). Return the path the
	 * text was saved to; it is surfaced as {@link BashResult.originalOutputPath}
	 * so the model can recover what the minimizer discarded.
	 */
	onMinimizedSave?: (originalText: string) => string | undefined | Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** Present when the native minimizer rewrote the output. */
	minimized?: { filter: string; inputBytes: number; outputBytes: number };
	/** Path of the spill file mirroring the full raw stream, when one was created. */
	spillPath?: string;
	/** Path holding the pre-minimization original text, when {@link onMinimizedSave} saved one. */
	originalOutputPath?: string;
	/** Lines/bytes elided between the retained head and tail windows (middle elision). */
	elidedLines?: number;
	elidedBytes?: number;
	workingDir?: string;
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();
/** Session keys with a command currently in flight on the persistent Shell. */
const shellSessionsInUse = new Set<string>();

/**
 * Release every persistent shell owned by `sessionId` (foreground shells and
 * retained `:async:` shells). Dropping the last reference SIGKILLs the native
 * shell and its children via kill-on-drop; called on session shutdown/unbind.
 */
export function closeSessionShells(sessionId: string): void {
	let released = 0;
	for (const key of shellSessions.keys()) {
		if (key.startsWith(sessionId)) {
			shellSessions.delete(key);
			released++;
		}
	}
	for (const key of brokenShellSessions) {
		if (key.startsWith(sessionId)) brokenShellSessions.delete(key);
	}
	for (const key of shellSessionsInUse) {
		if (key.startsWith(sessionId)) shellSessionsInUse.delete(key);
	}
	if (released > 0) runtimeLogger().info("bash-runtime released session shells", { sessionId, count: released });
}

/**
 * Shells retained past their turn because a background (`nohup`/`&`) job is
 * still running. A per-call `:async:` Shell is normally dropped at teardown,
 * which SIGKILLs its children via kill-on-drop. Keeping the reference alive lets
 * the process survive across turns; the Shell is dropped once its last
 * background job exits (reaped by the poll loop below). Children stay
 * kill-on-drop, so they still die when the harness tears the Shell down on exit.
 */
const retainedShells = new Set<Shell>();
const RETAIN_REAP_INTERVAL_MS = 5_000;

async function retainShellWithLiveBackgroundJobs(shell: Shell): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0) return;
	retainedShells.add(shell);
	const interval = setInterval(() => {
		void shell
			.liveBackgroundJobCount()
			.then((remaining) => {
				if (remaining > 0) return;
				clearInterval(interval);
				retainedShells.delete(shell);
			})
			.catch(() => {
				clearInterval(interval);
				retainedShells.delete(shell);
			});
	}, RETAIN_REAP_INTERVAL_MS);
	interval.unref?.();
}

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const cleanup = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

function resolveShellCwd(cwd: string | undefined): string | undefined {
	// Preserve the caller's logical cwd string. Brush uses this value to update `PWD` and its
	// internal working directory, so realpathing here collapses symlinks before the shell sees them.
	return cwd;
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

function shellBasename(shell: string): string {
	return shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isBashShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash");
}

function needsInteractiveShellArg(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("zsh");
}

function supportsAutoUserShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash") || basename.includes("zsh") || basename.includes("fish");
}

function hasInteractiveShellArg(args: string[]): boolean {
	return args.some((arg) => arg === "--interactive" || /^-[^-]*i/.test(arg));
}

function ensureInteractiveShellArgs(shell: string, args: string[]): string[] {
	if (!needsInteractiveShellArg(shell) || hasInteractiveShellArg(args)) return args;

	const commandIndex = args.findIndex((arg) => arg === "-c" || arg === "--command");
	if (commandIndex !== -1) {
		return [...args.slice(0, commandIndex), "-i", ...args.slice(commandIndex)];
	}

	const compactCommandIndex = args.findIndex((arg) => /^-[^-]*c[^-]*$/.test(arg));
	if (compactCommandIndex !== -1) {
		return args.map((arg, index) => (index === compactCommandIndex ? arg.replace("c", "ic") : arg));
	}

	return [...args, "-i"];
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return [shell, ...ensureInteractiveShellArgs(shell, args), command].map(quoteShellArg).join(" ");
}

function resolveUserShellConfig(baseConfig: ShellConfig): ShellConfig {
	const envShell = process.env.SHELL;
	if (process.platform === "win32" || !envShell || envShell === baseConfig.shell) {
		return baseConfig;
	}
	if (!supportsAutoUserShell(envShell) || !isExecutable(envShell)) {
		return baseConfig;
	}

	return {
		...baseConfig,
		shell: envShell,
		env: {
			...baseConfig.env,
			SHELL: envShell,
		},
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	// Automatically wrap in bash -c for full bash environment
	if (options?.useShellCommandWrapper === true) {
		// Standard bash escaping: escape single quotes using '"'"' pattern
		// This ensures the command runs identically to original
		const escapedCommand = command.replace(/'/g, "'\"'\"'");
		command = `bash -c '${escapedCommand}'`;
	}

	const baseShellConfig = getShellConfig();
	const shellConfig = options?.useUserShell === true ? resolveUserShellConfig(baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	const snapshotPath = bashShell && options?.snapshotEnabled !== false ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizerSettings = options?.minimizerSettings ?? DEFAULT_MINIMIZER_SETTINGS;
	const minimizerEnabled = options?.minimizerEnabled ?? minimizerSettings.enabled;
	const minimizer = minimizerEnabled ? buildMinimizerOptions(minimizerSettings) : undefined;

	const commandCwd = resolveShellCwd(options?.cwd);
	const commandEnv = options?.nonInteractiveEnv === false ? (options?.env ?? {}) : buildNonInteractiveEnv(options?.env);

	// Apply command prefix if configured
	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	const finalCommand =
		options?.useUserShell === true && !bashShell
			? buildUserShellCommand(shell, args, prefixedCommand)
			: prefixedCommand;

	// Create output sink for truncation and artifact handling
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		spillThreshold: options?.spillThreshold,
		headBytes: options?.headBytes ?? 20 * 1024,
		maxColumns: 768,
		chunkThrottleMs: options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
		artifactPath: options?.artifactPath,
	});

	// Finalize the sink into BashResult fields: the summary's `artifactPath`
	// (path of the spill file mirroring the raw stream, when one was created)
	// is surfaced as `spillPath`.
	const settle = async (notice?: string) => {
		const summary = await sink.dump(notice);
		const { artifactPath, ...rest } = summary;
		return { ...rest, spillPath: artifactPath };
	};

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await settle("Command cancelled")),
		};
	}

	const shellOptions = {
		sessionEnv: shellEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	// A persistent Shell runs one command at a time (the native session is a
	// mutex-guarded queue and `abort()` kills every in-flight run on it). When
	// parallel bash calls overlap on the same key, the first one owns the
	// persistent session; the rest degrade to isolated one-shot shells — the
	// same path quarantined sessions take.
	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shellSession = persistentSessionBroken || sessionBusy ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionBusy) {
		shellSession = new Shell(shellOptions);
		shellSessions.set(sessionKey, shellSession);
	}
	const executionShell = shellSession ?? new Shell(shellOptions);
	const ownsPersistentSession = shellSession !== undefined;
	if (ownsPersistentSession) {
		shellSessionsInUse.add(sessionKey);
	}
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	let abortCleanupPromise: Promise<void> | undefined;
	const abortShell = (): Promise<void> => {
		abortCleanupPromise ??= executionShell.abort().catch(() => undefined);
		return abortCleanupPromise;
	};
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		void abortShell();
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const requestedTimeoutMs = options?.timeout;
	const deadlineTimeoutMs = requestedTimeoutMs === 0 ? undefined : Math.max(1_000, requestedTimeoutMs ?? 300_000);
	const nativeTimeoutMs = requestedTimeoutMs !== undefined && requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined;
	const nativeOwnsTimeout = nativeTimeoutMs !== undefined;
	if (deadlineTimeoutMs !== undefined) {
		timeoutTimer = setTimeout(() => {
			// Explicit timeouts are already enforced inside pi-natives via
			// `timeoutMs`. Do not also abort the JS AbortSignal here: on Windows,
			// aborting that signal while a piped command is still forwarding output
			// can terminate the Bun host before the native timeout result resolves.
			if (!nativeOwnsTimeout) {
				abortCurrentExecution();
			}
			timeoutDeferred.resolve("timeout");
		}, deadlineTimeoutMs);
	}

	let resetSession = false;

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				signal: runAbortController.signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);

		const ey = new ExponentialYield();
		const winner = await ey.race<
			{ kind: "result"; result: ShellRunResult } | { kind: "timeout" } | { kind: "abort" }
		>([
			runPromise.then((result) => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then((kind) => ({ kind })),
			abortDeferred.promise.then((kind) => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			const cleanupPromise = abortShell();
			if (shellSession) {
				resetSession = true;
				quarantineShellSession(sessionKey, runPromise, cleanupPromise);
			} else {
				void Promise.allSettled([runPromise, cleanupPromise]);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await settle(
					winner.kind === "timeout" && deadlineTimeoutMs !== undefined
						? `Command timed out after ${Math.round(deadlineTimeoutMs / 1000)} seconds`
						: "Command cancelled",
				)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		// Handle timeout
		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await settle(annotation)),
			};
		}

		// Handle cancellation
		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await settle("Command cancelled")),
			};
		}

		// When the native minimizer rewrote the output, save the original text
		// (upstream `onMinimizedSave`) and swap the sink's accumulated raw stream
		// for the minimized text so truncation applies to the minimized text and
		// the counters realign. The artifactPath mirror — if one was created
		// before the replacement — already holds the same raw stream; the
		// dedicated save covers rewrites that never overflowed the inline
		// windows.
		const minimized = winner.result.minimized;
		let originalOutputPath: string | undefined;
		if (minimized && minimized.text !== minimized.originalText) {
			if (options?.onMinimizedSave !== undefined) {
				try {
					originalOutputPath = await options.onMinimizedSave(minimized.originalText);
				} catch {
					originalOutputPath = undefined;
				}
			}
			sink.replace(minimized.text);
		}

		// Normal completion
		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			minimized: minimized && minimized.text !== minimized.originalText
				? { filter: minimized.filter, inputBytes: minimized.inputBytes, outputBytes: minimized.outputBytes }
				: undefined,
			originalOutputPath,
			workingDir: winner.result.workingDir,
			...(await settle()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			shellSessionsInUse.delete(sessionKey);
			if (resetSession || options?.sessionKey?.includes(":async:")) {
				// `:async:` keys are per-job (jobId is unique), so the Shell would
				// otherwise stay in the process-global map forever after completion.
				shellSessions.delete(sessionKey);
				// Dropping the only reference to a per-call `:async:` Shell SIGKILLs
				// any `nohup`/`&` children (kill-on-drop). If the command left a live
				// background job, retain the Shell so the process survives across
				// turns; it is reaped once its last job exits and still dies with the
				// harness. Skip on resetSession (cancel/error) — those tear down.
				if (!resetSession && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession);
				}
			}
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
