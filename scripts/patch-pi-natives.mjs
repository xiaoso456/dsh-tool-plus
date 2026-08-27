#!/usr/bin/env node
/**
 * Self-heal `@oh-my-pi/pi-natives` for Node runtimes after installs that did
 * NOT go through pnpm (plain npm / yarn / npx of this package).
 *
 * Background: upstream pi-natives@17.3.5 locates its prebuilt binaries with
 * the Bun-only API `import.meta.dir` (native/loader-state.js). Under pnpm,
 * `patches/@oh-my-pi__pi-natives.patch` (declared in pnpm-workspace.yaml)
 * fixes that line automatically; every other package manager ignores pnpm
 * patch declarations, so their installs keep the bug and the tool plugin
 * crashes on first native access. This hook folds in the SAME one-line fix,
 * making the dependency-tree end state identical across all managers.
 *
 * Idempotent by construction:
 *   - file absent            -> warn, exit 0 (unknown layout must not brick installs)
 *   - line already fixed     -> no-op ("already patched")
 *   - buggy literal found    -> rewrite `import.meta.dir` -> `import.meta.dirname`
 *
 * Usage: node scripts/patch-pi-natives.mjs [searchRoot]
 *   Without argument the script walks ancestors of this file looking for a
 *   node_modules/@oh-my-pi/pi-natives package (hoisting-safe). With an
 *   argument, that directory is used as the walk root (for isolated tests).
 *
 * Never throws: a packaging lifecycle hook must not fail installs; if
 * anything unexpected happens it warns so the (pre-existing) runtime error
 * stays the single source of truth.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_SUBPATH = join("node_modules", "@oh-my-pi", "pi-natives");
const TARGET_REL = join("native", "loader-state.js");
// Exact buggy token; `\b` keeps an already-fixed `import.meta.dirname` intact.
const BUGGY = /import\.meta\.dir\b/g;

function log(message) {
  console.log(`[patch-pi-natives] ${message}`);
}

/** Walk upwards from `start`, yielding every candidate package directory. */
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
  // The known target first (byte-for-byte what the pnpm patch touches).
  const direct = join(packageDir, TARGET_REL);
  if (existsSync(direct)) return direct;
  // Unknown layouts: locate any loader-state.js so we can still heal them.
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

function main() {
  // Default: walk ancestors starting at THIS script's directory (`scripts/`),
  // so the repo root's node_modules is covered both here and in published
  // layouts (where the package sits inside someone else's node_modules tree).
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const searchRoot = process.argv[2] ? resolve(process.argv[2]) : scriptDir;

  let inspected = 0;
  let healed = 0;
  for (const packageDir of candidatePackageDirs(searchRoot)) {
    inspected += 1;
    const file = firstMatchedFile(packageDir);
    if (file === undefined) {
      log(`WARN ${packageDir}: loader-state.js not found, skipped`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    BUGGY.lastIndex = 0;
    if (!BUGGY.test(source)) {
      log(`${file}: already patched`);
      continue;
    }
    BUGGY.lastIndex = 0;
    writeFileSync(file, source.replace(BUGGY, "import.meta.dirname"));
    healed += 1;
    log(`${file}: patched import.meta.dir -> import.meta.dirname`);
  }

  if (inspected === 0) log(`WARN no @oh-my-pi/pi-natives found under ${searchRoot}`);
  else log(`done: ${inspected} package(s) seen, ${healed} patched`);
}

try {
  main();
} catch (error) {
  log(`WARN self-heal skipped: ${error?.message ?? error}`);
}
