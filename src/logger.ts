/**
 * Minimal structured logger seam for the ported bash-runtime modules.
 * The pi-gateway originals used `createModuleLogger("…")`; dsh provides
 * `ctx.logger` (Cordis logger), which the plugin entry installs via
 * {@link setRuntimeLogger}. Until then a console adapter is used, so the
 * modules stay usable outside a composition (unit tests, executor-only use).
 * @module @xiaoso/dsh-bash-plus/logger
 */

export interface RuntimeLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

const consoleLogger: RuntimeLogger = {
  info: (message, ...args) => console.info(`[bash-plus] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[bash-plus] ${message}`, ...args),
  error: (message, ...args) => console.error(`[bash-plus] ${message}`, ...args),
  debug: (message, ...args) => console.debug(`[bash-plus] ${message}`, ...args),
}

let current: RuntimeLogger = consoleLogger

/** Install the composition logger (Cordis `ctx.logger`); replaces the console adapter. */
export function setRuntimeLogger(logger: RuntimeLogger): void {
  current = logger
}

/** The installed logger; defaults to the console adapter. */
export function runtimeLogger(): RuntimeLogger {
  return current
}
