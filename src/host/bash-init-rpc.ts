/**
 * Host half of the bash init-script endpoints: read, save, reset and 试运行.
 *
 * The script rides the shell snapshot (see bash/init-script.ts); these
 * endpoints keep the settings dialog honest by writing the exact bytes a shell
 * would source and by running a real shell that sources them.
 * @module @xiaoso/dsh-tool-plus/host/bash-init-rpc
 */

import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { executeBash } from '../tools/bash/bash-executor.ts'
import { quoteShellArg } from '../tools/bash/shell-quote.ts'
import {
  initLogPath,
  readInitScript,
  resolveInitScriptPath,
  type InitScriptInfo,
} from '../tools/bash/init-script.ts'
import {
  BASH_INIT_RESET_ENDPOINT,
  BASH_INIT_SAVE_ENDPOINT,
  BASH_INIT_STATUS_ENDPOINT,
  BASH_INIT_TEST_ENDPOINT,
  type BashInitSavePayload,
  type BashInitStatusValue,
  type BashInitTestPayload,
  type BashInitTestValue,
} from '../tools/shared/browser-rpc-channel.ts'

/** Result shape of one Connection RPC call (official gateway contract). */
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

/** Everything these endpoints need from the host plane. */
export interface BashInitRpcDeps {
  /** Live config read (`bashInitEnabled`). */
  getEnabled(): boolean
  /** Live config read (`bashInitScript`); empty means the default path. */
  getConfiguredPath(): string | undefined
}

/** Cap on one script: far above any realistic init script, far below a DoS. */
const MAX_SCRIPT_BYTES = 256 * 1024

/** How much of the shell's init log the status row surfaces. */
const MAX_LOG_TAIL = 2_000

function failure(error: unknown, code: 'internal' | 'bad-request' = 'internal'): ConnectionRpcResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error), details: {} } }
}

/** Tail of the shell's init log, when the file exists and is non-empty. */
function readLogTail(): string | undefined {
  try {
    const raw = fs.readFileSync(initLogPath(), 'utf8').trim()
    if (raw.length === 0) return undefined
    return raw.length > MAX_LOG_TAIL ? raw.slice(-MAX_LOG_TAIL) : raw
  } catch {
    return undefined
  }
}

/** Atomically write the user copy (temp file + rename), private mode. */
function writeScript(scriptPath: string, content: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true, mode: 0o700 })
  const temp = scriptPath + '.tmp-' + process.pid
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, scriptPath)
}

/** Validate a bash/initTest payload. */
export function parseBashInitTestPayload(payload: unknown): BashInitTestPayload | undefined {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object') return undefined
  const content = (payload as { content?: unknown }).content
  if (content === undefined) return {}
  if (typeof content !== 'string' || content.length > MAX_SCRIPT_BYTES) return undefined
  return { content }
}

/** Validate a bash/initSave payload. */
export function parseBashInitSavePayload(payload: unknown): BashInitSavePayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const content = (payload as { content?: unknown }).content
  if (typeof content !== 'string' || content.length > MAX_SCRIPT_BYTES) return undefined
  return { content }
}

function statusValue(deps: BashInitRpcDeps): BashInitStatusValue {
  const enabled = deps.getEnabled()
  const info: InitScriptInfo = readInitScript(deps.getConfiguredPath(), process.env, enabled)
  return {
    enabled: info.enabled,
    path: info.path,
    source: info.source,
    exists: info.exists,
    content: info.content,
    lastError: info.error ?? readLogTail(),
  }
}

/**
 * Answer one bash-init endpoint on the shared /tool-plus route.
 * @returns the envelope, or undefined when the endpoint is not ours.
 */
export async function handleBashInitEndpoint(
  deps: BashInitRpcDeps,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult | undefined> {
  if (endpoint === BASH_INIT_STATUS_ENDPOINT) {
    try {
      return { ok: true, value: statusValue(deps) }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === BASH_INIT_SAVE_ENDPOINT) {
    const parsed = parseBashInitSavePayload(payload)
    if (parsed === undefined) return failure(new Error('content must be a string under 256 KiB'), 'bad-request')
    try {
      const scriptPath = resolveInitScriptPath(deps.getConfiguredPath(), process.env)
      writeScript(scriptPath, parsed.content)
      // Return the new state so the dialog needs exactly one round trip.
      return { ok: true, value: statusValue(deps) }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === BASH_INIT_RESET_ENDPOINT) {
    try {
      const scriptPath = resolveInitScriptPath(deps.getConfiguredPath(), process.env)
      try {
        fs.rmSync(scriptPath, { force: true })
      } catch (error) {
        return failure(error)
      }
      // Same contract as save: the state after the change, one round trip.
      return { ok: true, value: statusValue(deps) }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === BASH_INIT_TEST_ENDPOINT) {
    const parsed = parseBashInitTestPayload(payload)
    if (parsed === undefined) return failure(new Error('content must be a string under 256 KiB'), 'bad-request')
    const started = Date.now()
    const tempPath = path.join(os.tmpdir(), 'tool-plus-init-test-' + process.pid + '-' + Date.now() + '.sh')
    try {
      const effective = parsed.content ?? readInitScript(deps.getConfiguredPath(), process.env).content
      fs.writeFileSync(tempPath, effective, { mode: 0o600 })
      // 试运行 = 原样执行这段脚本（source），把它的输出交回去，不附加任何探针。
      // initScriptEnabled 关掉，免得同一份脚本在建 shell 时再跑一次（那次输出会被丢弃）。
      const result = await executeBash(`source ${quoteShellArg(tempPath)}`, {
        cwd: os.homedir(),
        timeout: 15_000,
        initScriptEnabled: false,
        snapshotEnabled: false,
      })
      const value: BashInitTestValue = {
        exitCode: result.exitCode,
        output: result.output,
        durationMs: Date.now() - started,
      }
      return { ok: true, value }
    } catch (error) {
      return failure(error)
    } finally {
      try {
        fs.rmSync(tempPath, { force: true })
      } catch {
        // best-effort
      }
    }
  }

  return undefined
}
