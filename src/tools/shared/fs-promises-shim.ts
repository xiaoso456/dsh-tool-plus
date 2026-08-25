/**
 * DSH node:fs/promises shim.
 *
 * OMP tool code imports `node:fs/promises` and calls `fs.exists(path)`, a
 * Bun-only extension that Node's `fs/promises` does not provide. This module
 * re-exports the whole Node `fs/promises` API and adds the missing `exists`.
 *
 * NOTE: the import MUST be `from 'fs/promises'` (no `node:` prefix) so the
 * tsdown alias for `node:fs/promises` does not recursively substitute its own
 * target back onto itself.
 */
import * as fsp from 'fs/promises'

export * from 'fs/promises'

/** Bun's `node:fs/promises` extension: `exists(path)` → `Promise<boolean>`. */
export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path)
    return true
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false
    throw e
  }
}

/**
 * Augment the real `node:fs/promises` module type with Bun's `exists` so tsc
 * (which resolves `node:*` builtins through `@types/node`, not via tsconfig
 * `paths`) sees the extension on the bundled module too. At build time the
 * tsdown alias replaces `node:fs/promises` with this shim; at typecheck time
 * this augmentation covers the direct `node:fs/promises` imports.
 */
declare module 'node:fs/promises' {
  export function exists(path: string): Promise<boolean>
}
