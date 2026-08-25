/**
 * DSH adapter shim for OMP `internal-urls/skill-protocol.ts`.
 *
 * The write adapter's `local-protocol.ts` imports only `validateRelativePath`
 * (path-traversal guard for skill:// / local:// URL paths). The full
 * `SkillProtocolHandler` resolves skill:// URLs via `getActiveSkills` and
 * `Bun.file` (extensibility/skills + .md prompt chain, Bun-only) — neither is
 * part of the write adapter's active path: DSH's InternalUrlRouter has
 * `canHandle=false`, so no skill:// URL is ever resolved.
 *
 * `validateRelativePath` is copied verbatim from the OMP original (pure path
 * guard, no Bun dependency). The handler is left as a deferred Bun-class item
 * (step.md "Bun 兼容").
 */
import * as path from "node:path"

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 * (verbatim OMP)
 */
export function validateRelativePath(relativePath: string): void {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed in skill:// URLs")
  }

  const normalized = path.normalize(relativePath)
  if (
    relativePath.split(/[\\/]/).includes("..") ||
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    normalized.includes("/..")
  ) {
    throw new Error("Path traversal (..) is not allowed in skill:// URLs")
  }
}
