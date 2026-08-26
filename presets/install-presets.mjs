#!/usr/bin/env node
/**
 * Install the Tool Plus agent-preset templates into a DSH home.
 *
 * Everything preset-related lives in THIS one folder:
 *
 *   presets/
 *     install-presets.mjs      <- this script (self-locating, no cwd dependency)
 *     tool-plus-standard/      <- 标准增强版 preset template
 *     tool-plus-ptc/           <- PTC 增强版 preset template
 *
 * Each template directory is copied verbatim into
 * `${DSH_HOME:-~/.dsh}/.agent-presets/<id>/` — the roster folder every running
 * DSH scans for agent presets. New/changed presets are picked up on the next
 * Host restart.
 *
 * RE-ENTRANT BY DESIGN (safe to run any number of times):
 *
 *   target file missing              -> install it
 *   target file byte-identical       -> report "up-to-date", touch nothing
 *   target file differs (user edit)  -> SKIP and keep the local edit,
 *                                       unless --force restores the canonical copy
 *   unknown extra files in target    -> left alone (never destroys unrelated data)
 *
 * Exit codes: 0 = all targets installed or up-to-date;
 *             1 = at least one target was skipped (stale local edits exist —
 *                 rerun with --force to normalize) or a hard error occurred.
 *
 * Usage:
 *   node presets/install-presets.mjs [--force] [--dry-run] [--home <dir>]
 *
 *   --force       overwrite differing target files with the packaged copies
 *   --dry-run     report what would happen; write nothing (exit code still reflects skips)
 *   --home <dir>  override the DSH home (defaults to $DSH_HOME, then ~/.dsh);
 *                 use this to try the installer against an isolated home
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = "agent-presets";

/* ── argument parsing ────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
/** @type {{ force: boolean, dryRun: boolean, home?: string }} */
const options = { force: false, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--force") options.force = true;
  else if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
  else if (arg === "--home") {
    const value = args[++i];
    if (value === undefined) fail("--home requires a directory argument");
    options.home = value;
  } else if (arg === "--help" || arg === "-h") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").match(/\/\*\*[\s\S]*?\*\//)?.[0]
      ?.replace(/^\/\*\*/, "").replace(/\*\/$/, "").replace(/^\s*\* ?/gm, "").trim() ?? "");
    process.exit(0);
  } else fail(`unknown argument: ${arg}`);
}

function fail(message) {
  console.error(`install-presets: ${message}`);
  process.exit(1);
}

/* ── locate source templates and target home ─────────────────────────────── */

const sources = readdirSync(scriptDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(scriptDir, entry.name))
  .filter((dir) => exists(join(dir, "preset.yml")) && exists(join(dir, "agent.cordis.yml")))
  .sort();
if (sources.length === 0) fail(`no preset template directories found beside this script (${scriptDir})`);

const dshHome = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const targetRoot = join(dshHome, `.${PRESET_ROOT}`);

/* ── re-entrant install: per-file copy / up-to-date / skip (+ --force) ───── */

let skipped = 0;
console.log(`DSH home : ${dshHome}`);
console.log(`Target   : ${targetRoot}${options.dryRun ? "  (dry-run, nothing written)" : ""}`);
console.log("");

for (const sourceDir of sources) {
  const presetId = sourceDir.slice(scriptDir.length + 1).replaceAll("\\", "/");
  const targetDir = join(targetRoot, presetId);
  const files = readdirSync(sourceDir).sort();

  mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    const sourcePath = join(sourceDir, file);
    const targetPath = join(targetDir, file);
    const sourceBytes = readFileSync(sourcePath);

    if (exists(targetPath)) {
      const targetBytes = readFileSync(targetPath);
      if (sourceBytes.equals(targetBytes)) {
        report(presetId, file, "up-to-date");
        continue;
      }
      if (!options.force) {
        report(presetId, file, "SKIPPED (local edit preserved; rerun with --force)");
        skipped++;
        continue;
      }
      report(presetId, file, "restored (--force)");
      if (!options.dryRun) writeFileSync(targetPath, sourceBytes);
      continue;
    }
    report(presetId, file, "installed");
    if (!options.dryRun) writeFileSync(targetPath, sourceBytes);
  }
}

console.log("");
if (skipped > 0) {
  console.log(`${skipped} file(s) skipped: local edits differ from the packaged templates.`);
  console.log("Rerun with --force to overwrite them with the canonical copies.");
  process.exit(1);
}
console.log("All presets installed or already up-to-date.");

/* ── helpers ─────────────────────────────────────────────────────────────── */

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function report(presetId, file, action) {
  console.log(`  ${presetId}/${file}: ${action}`);
}
