/**
 * DSH named-import shim for `bun:ffi` (pi-utils stderr-guard / process-name).
 * Both consumers degrade silently when dlopen is unavailable ("Never throws:
 * bun:ffi unavailability ... degrades silently"), so this shim returns null.
 */
export const FFIType = {} as Record<string, number>

export function dlopen(): null {
  return null
}

export const ptr = (): number => 0

/** FFI C-string view (pi-tui ttyid) — never populated since dlopen is null. */
export class CString {
  constructor(_ptr: number) {}

  toString(): string {
    return ''
  }
}
