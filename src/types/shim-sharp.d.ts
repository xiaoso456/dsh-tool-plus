/**
 * Ambient stub for `sharp`.
 *
 * sharp is NOT a dependency of this package: it is resolved at runtime from
 * the host DSH install tree (dsh-attachment-local depends on it directly).
 * This declaration only satisfies `import('sharp')` under
 * moduleResolution=bundler; the shim keeps all real usage behind its own
 * structural `SharpLike` types and runtime normalization.
 */
declare module 'sharp' {
  const sharp: unknown
  export default sharp
}
