/**
 * The one write-channel seam shared by edit and write.
 *
 * The OMP engines hand their final bytes to a WritethroughCallback. DSH has
 * no LSP writethrough, so the callback is where the host choice lives:
 *  - dsh (default): resolve through ctx.fs, attach the per-call sandbox
 *    policy, and let dsh-fs-local stage + fsync + ReplaceFileW the bytes.
 *  - native: OMP's writethroughNoop, i.e. a direct node:fs write. Faster,
 *    but non-atomic and it bypasses the sandbox fence (the 2026-08-27 方案A
 *    defect this seam exists to prevent).
 *
 * Retry is applied inside the chosen channel with a backend-specific matcher;
 * see atomic-write-retry.ts for why 1175/32 and EBUSY are the only retryable
 * failures.
 * @module @xiaoso/dsh-tool-plus/shared
 */

import type { Context } from '@deepseek-ai/cordis'
// Loads the ctx.fs module augmentation on Context.
import type {} from '@deepseek-ai/dsh-fs'
import type { RuntimeConfig } from '../../config/settings.ts'
import type { WritethroughCallback } from '../omp/tools/writethrough.ts'
import { writethroughNoop } from '../omp/tools/writethrough.ts'
import { isNativeWriteContention, isReplaceFileContention, writeWithRetry } from './atomic-write-retry.ts'
import { resolveSandboxPolicy } from './sandbox-policy.ts'

export type WriteBackend = 'dsh' | 'native'

/** Selected backend; unknown/absent values fall back to the safe DSH path. */
export function resolveWriteBackend(cfg: RuntimeConfig): WriteBackend {
  return cfg.writeBackend === 'native' ? 'native' : 'dsh'
}

function retriesOf(cfg: RuntimeConfig): number {
  if (cfg.writeRetryEnabled === false) return 0
  return cfg.writeRetryCount ?? 3
}

function createNativeWritethrough(cfg: RuntimeConfig): WritethroughCallback {
  return async (dst, content, signal, file) => {
    const write = async (): Promise<void> => {
      await writethroughNoop(dst, content, signal, file)
    }
    const retries = retriesOf(cfg)
    if (retries === 0) return write()
    await writeWithRetry(write, { retries, signal, isRetryable: isNativeWriteContention })
  }
}

function createDshWritethrough(ctx: Context, exec: any, cfg: RuntimeConfig): WritethroughCallback {
  return async (dst, content, signal, _file) => {
    // The OMP engines pass a file handle for patch/hashline modes; ignoring it
    // is deliberate: writing through it bypasses the host sandbox fence.
    const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const target = await ctx.fs.resolve(dst, { cwd, signal })
    const sandboxPolicy = resolveSandboxPolicy(ctx, exec)
    const write = async (): Promise<void> => {
      await ctx.fs.writeText(target, content, undefined, signal, sandboxPolicy)
    }
    const retries = retriesOf(cfg)
    if (retries === 0) return write()
    await writeWithRetry(write, { retries, signal, isRetryable: isReplaceFileContention })
  }
}

/**
 * Build the writethrough for the selected backend. Without a host ctx.fs
 * (direct calls and unit tests) the native channel is used, matching the
 * previous no-ctx fallback.
 */
export function createWriteChannel(ctx: Context | undefined, exec: any, cfg: RuntimeConfig): WritethroughCallback {
  if (resolveWriteBackend(cfg) === 'native' || ctx === undefined || ctx.fs?.resolve === undefined || ctx.fs?.writeText === undefined) {
    return createNativeWritethrough(cfg)
  }
  return createDshWritethrough(ctx, exec, cfg)
}
