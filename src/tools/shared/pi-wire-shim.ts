/**
 * DSH adaptation shim for `@oh-my-pi/pi-wire`.
 *
 * The verbatim OMP tool copies (`adapter/omp/.../json-tree.ts`) import
 * `INTENT_FIELD` from the pi-wire package. pi-wire remains a transitive
 * dependency of pi-ai/pi-agent-core and is still bundled for those imports,
 * but nothing in this plugin needs the direct package — so the copied files
 * point at this shim instead (an import-path-only adjustment, per plan).
 *
 * Value mirrors `packages/wire/src/index.ts` (v17.3.5):
 *   INTENT_FIELD = "i"  — parameter key used for intent tracing
 *   (e.g. prompt explanation/reasoning).
 */
export const INTENT_FIELD = "i";
