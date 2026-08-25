/**
 * DSH adapter interface shim for OMP `internal-urls/skill-protocol.ts`.
 *
 * The original is the full `skill://` protocol handler (routes skill names to
 * their SKILL.md files, checks containment, completes against the active-skill
 * roster). `skill://` is a clearly-removed internal-protocol capability in DSH
 * (plan.md: internal URL routing canHandle=false), so the handler class is not
 * ported.
 *
 * Only `validateRelativePath` is retained, verbatim — `internal-urls/local-protocol.ts`
 * (also a verbatim OMP copy in the adapter) depends on it as a pure
 * path-safety check for `local://` relative paths. It has no protocol routing.
 */
import * as path from "node:path"

/**
 * Validate that a path is safe (no traversal, no absolute paths).
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
