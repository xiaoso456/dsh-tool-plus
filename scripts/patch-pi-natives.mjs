#!/usr/bin/env node
/**
 * Self-heal \`@oh-my-pi/pi-natives\` for Node runtimes.
 *
 * The upstream package locates its prebuilt binaries with the Bun-only
 * \`import.meta.dir\` (native/loader-state.js). Node has no such property, so
 * \`path.join(undefined, "..", "native")\` throws ERR_INVALID_ARG_TYPE before
 * any tool can load.
 *
 * Two callers share this module:
 *   - the package postinstall (plain npm / yarn / npx installs), and
 *   - lib/pi-natives-bootstrap.mjs, which runs before the real plugin entry
 *     so a pnpm store repair/re-link cannot break the next dsh start.
 *
 * Copy-on-patch is intentional. pnpm links package files from its
 * content-addressable store with hardlinks; writing the linked file in place
 * mutates the store and every profile that shares that inode. Writing a temp
 * file and renaming it over the target gives this profile a private inode and
 * leaves the store untouched. When the file is already patched but still
 * shared, the same operation detaches it once.
 *
 * Resolution prefers \`import.meta.resolve("@oh-my-pi/pi-natives")\` because the
 * package is ESM-only; createRequire.resolve throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED for it. The historical ancestor walk remains
 * as a fallback for unknown layouts, and can be forced with a searchRoot.
 *
 * Idempotent; the CLI never throws.
 *
 * Usage: node scripts/patch-pi-natives.mjs [searchRoot]
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_SUBPATH = join("node_modules", "@oh-my-pi", "pi-natives");
const TARGET_REL = join("native", "loader-state.js");
// Exact buggy token; \b keeps an already-fixed \`import.meta.dirname\` intact.
const BUGGY = /import\.meta\.dir\b/g;
const PATCHED_LITERAL = "import.meta.dirname";
const PKG_NAME = "@oh-my-pi/pi-natives";

function log(message) {
  console.log("[patch-pi-natives] " + message);
}

function warn(message) {
  console.warn("[patch-pi-natives] " + message);
}

/** Walk upwards from start, yielding every candidate package directory. */
function* candidatePackageDirs(start) {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, PKG_SUBPATH);
    if (existsSync(candidate)) yield candidate;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function firstMatchedFile(packageDir) {
  const direct = join(packageDir, TARGET_REL);
  if (existsSync(direct)) return direct;
  const stack = [packageDir];
  while (stack.length > 0) {
    const entry = stack.pop();
    for (const item of readdirSync(entry)) {
      const full = join(entry, item);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (item === "loader-state.js") return full;
    }
  }
  return undefined;
}

/** Walk up from a resolved entry until the pi-natives package root. */
function packageRootFor(entry) {
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === PKG_NAME) return dir;
      } catch {
        // Keep walking: a malformed package.json is not our target.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * @param {string | undefined} searchRoot
 * @param {boolean} preferExact
 * @returns {{ file: string | undefined, inspected: number }}
 */
function resolveTarget(searchRoot, preferExact) {
  if (preferExact) {
    try {
      const entry = fileURLToPath(import.meta.resolve(PKG_NAME));
      const packageRoot = packageRootFor(entry);
      if (packageRoot !== undefined) {
        const direct = join(packageRoot, TARGET_REL);
        if (existsSync(direct)) return { file: direct, inspected: 1 };
      }
    } catch {
      // Fall through to the ancestor walk.
    }
  }

  const start = searchRoot ? resolve(searchRoot) : dirname(fileURLToPath(import.meta.url));
  let inspected = 0;
  for (const packageDir of candidatePackageDirs(start)) {
    inspected += 1;
    const file = firstMatchedFile(packageDir);
    if (file !== undefined) return { file, inspected };
  }
  return { file: undefined, inspected };
}

/**
 * Replace the target with a private inode. rename() removes this path's link
 * to the old inode (the store and other profiles keep theirs); the temp file
 * becomes the new content.
 */
function atomicReplace(file, content) {
  const real = realpathSync(file);
  const mode = statSync(real).mode;
  const tmp = real + "." + process.pid + "." + Date.now() + ".tmp";
  writeFileSync(tmp, content, { mode });
  try {
    renameSync(tmp, real);
  } catch (error) {
    const code = error && error.code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EXDEV") throw error;
    rmSync(real, { force: true });
    renameSync(tmp, real);
  } finally {
    rmSync(tmp, { force: true });
  }
  return real;
}

/**
 * @param {{
 *   target?: string,
 *   searchRoot?: string,
 *   detach?: boolean,
 *   copyOnPatch?: boolean,
 * }} [options]
 * @returns {{ inspected: number, patched: number, detached: number, files: string[], error?: string }}
 */
export function ensurePiNativesPatched(options = {}) {
  const { target, searchRoot, detach = true, copyOnPatch = true } = options;

  try {
    let found;
    if (target) {
      found = { file: existsSync(target) ? target : undefined, inspected: existsSync(target) ? 1 : 0 };
    } else {
      found = resolveTarget(searchRoot, searchRoot === undefined);
    }

    if (found.file === undefined) {
      return {
        inspected: found.inspected,
        patched: 0,
        detached: 0,
        files: [],
        error: "no " + PKG_NAME + "/" + TARGET_REL + " found",
      };
    }

    const real = realpathSync(found.file);
    const source = readFileSync(real, "utf8");
    const next = source.replace(BUGGY, PATCHED_LITERAL);
    const patched = next !== source;
    const shared = statSync(real).nlink > 1;
    const shouldDetach = !patched && detach && shared;

    if (!patched && !shouldDetach) {
      return { inspected: found.inspected, patched: 0, detached: 0, files: [real] };
    }

    if (copyOnPatch) atomicReplace(real, next);
    else writeFileSync(real, next);

    return {
      inspected: found.inspected,
      patched: patched ? 1 : 0,
      detached: shouldDetach ? 1 : 0,
      files: [real],
    };
  } catch (error) {
    return {
      inspected: 0,
      patched: 0,
      detached: 0,
      files: [],
      error: error && error.message ? error.message : String(error),
    };
  }
}

function main() {
  const searchRoot = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = ensurePiNativesPatched({ detach: true, searchRoot });
  if (result.error) {
    warn("WARN " + result.error);
    return;
  }
  for (const file of result.files) {
    if (result.patched > 0) log(file + ": patched import.meta.dir -> import.meta.dirname");
    else if (result.detached > 0) log(file + ": detached hardlink (private copy)");
    else log(file + ": already patched");
  }
  log("done: patched=" + result.patched + ", detached=" + result.detached);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    warn("WARN self-heal skipped: " + (error && error.message ? error.message : String(error)));
  }
}
