/**
 * Ambient module declarations for OMP text imports (Bun-compat). Kept as a
 * non-module .d.ts so the wildcard declarations resolve for
 * `import x from "*.md" with { type: "text" }`.
 */

declare module '*.md' {
  const content: string
  export default content
}

declare module '*.lark' {
  const content: string
  export default content
}
