/**
 * Ambient module declarations for OMP text imports and the xxhashjs
 * dependency (Bun-compat). Kept as a non-module .d.ts so the wildcard
 * declarations resolve for `import x from "*.md" with { type: "text" }`.
 */

declare module '*.md' {
  const content: string
  export default content
}

declare module '*.lark' {
  const content: string
  export default content
}

declare module 'xxhashjs' {
  export function xxHash64(input: string, seed?: number): number
  export function xxHash32(input: string, seed?: number): number
  export const h32: (seed?: number) => { update(input: string): unknown; digest(): number }
  export const h64: (seed?: number) => { update(input: string): unknown; digest(): string }
  const _default: {
    xxHash64(input: string, seed?: number): number
    xxHash32(input: string, seed?: number): number
  }
  export default _default
}
