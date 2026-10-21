/**
 * tool-plus package entry — pi-natives compatibility bootstrap.
 *
 * \`@oh-my-pi/pi-natives\` ships a Bun-only \`import.meta.dir\` in
 * native/loader-state.js. A postinstall patch alone is not enough under pnpm:
 * the file is a hardlink to the content-addressable store, and a later
 * install that repairs or re-links the store can restore the buggy bytes.
 *
 * This entry runs the shared patch helper first, then dynamically imports the
 * real plugin entry. It must not statically import index.mjs (or any module
 * that reaches pi-natives): static imports are evaluated before this body.
 *
 * The helper writes through a temp file + rename, so it breaks the store
 * hardlink and keeps this profile's copy private.
 */
import { ensurePiNativesPatched } from "../scripts/patch-pi-natives.mjs";

const result = ensurePiNativesPatched({ detach: true });
if (result.error) {
  console.warn("[tool-plus] pi-natives compat: " + result.error);
} else if (result.patched > 0 || result.detached > 0) {
  console.log(
    "[tool-plus] pi-natives compat: patched=" + result.patched + ", detached=" + result.detached,
  );
}

// Runtime-computed URL: keep this dynamic so a bundler never inlines the
// plugin graph (and its static pi-natives imports) ahead of the patch above.
const mod = await import(new URL("./index.mjs", import.meta.url).href);

export const name = mod.name;
export const inject = mod.inject;
export const Config = mod.Config;
export const apply = mod.apply;
