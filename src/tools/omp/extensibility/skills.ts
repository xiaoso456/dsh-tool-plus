/**
 * DSH adapter for OMP `extensibility/skills.ts` — the `Skill` type
 * referenced by `tools/path-utils.ts` (skill:// resolution). DSH has no
 * skill:// protocol; the type is provided verbatim so path-utils compiles.
 */
export interface Skill {
  name: string
  description: string
  filePath: string
  baseDir: string
  source: string
  /** When true, loaded but excluded from rendered <skills> listing. */
  hide?: boolean
  /** Filesystem-resolved plugin root for Agent Plugin skills. */
  containRoot?: string
  /** Source metadata for display */
  _source?: { provider: string; kind?: string; category?: string }
}
