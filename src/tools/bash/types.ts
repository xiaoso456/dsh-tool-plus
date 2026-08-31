/**
 * Plugin configuration, tool argument, and result DTO types for the ported
 * Oh My Pi bash tool. The runtime `Config` schema lives in `index.ts`.
 * @module @xiaoso/dsh-tool-plus/types
 */

/** Minimizer settings mirroring the native `MinimizerOptions` surface. */
export interface MinimizerConfig {
  enabled: boolean
  /** Restrict minimization to these filter names (empty = all). */
  only: string[]
  /** Exclude these filter names from minimization. */
  except: string[]
  /** Output capture budget in bytes; larger outputs pass through raw. */
  maxCaptureBytes: number
}

/**
 * Runtime configuration schema for the plugin; declared in `index.ts`
 * alongside `apply`. Every field is optional at the composition boundary and
 * defaults inside `apply`; {@link ResolvedConfig} is the fully-defaulted form.
 */
export interface Config {
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
  /** Foreground commands exceeding this wall time are moved to the background (0 = never). */
  autoBackgroundMs?: number
  /** Deadline applied when the model omits `timeoutMs`. */
  defaultTimeoutMs?: number
  /** Upper clamp for explicit timeouts; `timeoutMs: 0` disables the deadline. */
  maxTimeoutMs?: number
  /** Tail budget for live previews and background-job output reads. */
  outputMaxBytes?: number
  /** OutputSink rolling tail window (bytes). */
  outputSinkTailBytes?: number
  /** OutputSink head window (bytes) retained in addition to the tail. */
  outputSinkHeadBytes?: number
  /** Output minimizer (native intelligent compression for git/npm/cargo/…). */
  minimizer?: MinimizerConfig
  /** Block intercepted commands and suggest the dedicated dsh tool instead. */
  interceptorEnabled?: boolean
  /** Harden the command environment for non-interactive use (pagers, prompts, color). */
  nonInteractiveEnv?: boolean
  /** Capture the user's rc file (aliases, functions, options) into the session shell. */
  snapshotEnabled?: boolean
  /** Redefine `rm` in the session shell to move into the system trash; the plugin config layer decides the default (rmSafe: true). */
  rmSafe?: boolean
  /** Wrap every command in `bash -c '…'` for a full bash environment. */
  useShellCommandWrapper?: boolean
}

/** {@link Config} with every field resolved to its default. */
export type ResolvedConfig = Required<Config>

/** Parsed tool arguments; execute validates value constraints absent from ParameterSchemaSpec. */
export interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  env?: Record<string, string>
  run_in_background?: boolean
}

/** Minimizer facts surfaced with a foreground result. */
export interface MinimizedOutputInfo {
  filter: string
  inputBytes: number
  outputBytes: number
}

/** One collected output stream (single merged stdout+stderr, like the native Shell). */
export interface CollectedOutput {
  text: string
  truncated: boolean
  /** Path of the spill file mirroring the full raw output stream, when one was created. */
  spillPath?: string
  /** Path holding the pre-minimization original text, when the native minimizer rewrote the output. */
  originalSpillPath?: string
  /** Stream counters carried for the truncation notice (OMP OutputSummary parity). */
  totalLines?: number
  totalBytes?: number
  outputLines?: number
  outputBytes?: number
  elidedLines?: number
  elidedBytes?: number
}

/** Foreground completion of one bash call. */
export interface BashForegroundOutput {
  kind: 'foreground'
  /** Process exit code; null when the run was interrupted before exit. */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** The effective deadline in ms (null when the deadline was disabled). */
  timeoutMs: number | null
  /** Wall-clock duration of the run. */
  wallTimeMs: number
  /** The shell's working directory after the command (persists across calls). */
  workingDir?: string
  /** Present when the native minimizer rewrote the output. */
  minimized?: MinimizedOutputInfo
  /** True when the rmSafe injection failed: `rm` deletes permanently. */
  rmSafeInjectionFailed?: boolean
  output: CollectedOutput
}

/** Background acknowledgement: the call returned a managed job id. */
export interface BashBackgroundOutput {
  kind: 'background'
  jobId: string
}

/** The tool's canonical output DTO. */
export type BashOutput = BashForegroundOutput | BashBackgroundOutput
