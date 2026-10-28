#!/usr/bin/env node
// Thin vendor manager for the pinned oh-my-pi source checkout.
//
//   node scripts/vendor.mjs init [--from <path>]
//   node scripts/vendor.mjs sync
//   node scripts/vendor.mjs apply
//   node scripts/vendor.mjs check
//
// The checkout itself is gitignored; lock.json, README.md, overlay/ and
// patches/* are tracked. CI recreates the checkout with actions/checkout, so
// this script is mainly for local builds and for verifying the patch series.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VENDOR = path.join(ROOT, "vendor", "oh-my-pi");
const UPSTREAM = path.join(VENDOR, "upstream");
const PATCHES = path.join(VENDOR, "patches");
const OVERLAY = path.join(VENDOR, "overlay");
const lock = JSON.parse(readFileSync(path.join(VENDOR, "lock.json"), "utf8"));

function git(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  // execFileSync returns null when stdio is inherited.
  return typeof output === "string" ? output.trim() : "";
}

function head(dir) {
  return git(["rev-parse", "HEAD"], { cwd: dir });
}

function assertPinnedCheckout() {
  if (!existsSync(path.join(UPSTREAM, ".git"))) {
    throw new Error(
      "vendor/oh-my-pi/upstream is missing. Run pnpm vendor:init first " +
        "(or pnpm vendor:init -- --from refs/oh-my-pi for the local reference clone).",
    );
  }
  const actual = head(UPSTREAM);
  if (actual !== lock.commit) {
    throw new Error(
      "vendor upstream is at " + actual + ", expected " + lock.commit + " (" + lock.tag + "). " +
        "Run pnpm vendor:init -- --force or check out the pinned commit manually.",
    );
  }
}

function listPatches() {
  if (!existsSync(PATCHES)) return [];
  return readdirSync(PATCHES)
    .filter((name) => name.endsWith(".patch"))
    .sort();
}

function copyTree(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }
}

function syncOverlay(destination = UPSTREAM) {
  if (!existsSync(OVERLAY)) return;
  copyTree(OVERLAY, destination);
}

function init(argv) {
  const fromIndex = argv.indexOf("--from");
  const from = fromIndex >= 0 ? argv[fromIndex + 1] : null;
  const force = argv.includes("--force");
  if (force && existsSync(UPSTREAM)) {
    throw new Error("refusing to delete an existing checkout automatically; remove it yourself first");
  }
  if (existsSync(path.join(UPSTREAM, ".git")) && !force) {
    assertPinnedCheckout();
    syncOverlay();
    console.log("vendor upstream already at " + lock.commit + "; overlay synced");
    return;
  }
  mkdirSync(VENDOR, { recursive: true });
  console.log("checking out " + lock.tag + " (" + lock.commit + ") into " + path.relative(ROOT, UPSTREAM));
  if (from) {
    const source = path.resolve(ROOT, from);
    if (!existsSync(path.join(source, ".git"))) {
      throw new Error("--from is not a git checkout: " + source);
    }
    git(["clone", "--quiet", "--local", source, UPSTREAM], { stdio: "inherit" });
    git(["remote", "set-url", "origin", lock.repo], { cwd: UPSTREAM });
  } else {
    git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", lock.repo, UPSTREAM], { stdio: "inherit" });
    git(["fetch", "--quiet", "--depth", "1", "origin", lock.commit], { cwd: UPSTREAM, stdio: "inherit" });
  }
  git(["checkout", "--quiet", "--detach", lock.commit], { cwd: UPSTREAM, stdio: "inherit" });
  assertPinnedCheckout();
  syncOverlay();
  console.log("vendor upstream ready at " + lock.commit + ", overlay synced");
}

function applyPatches(destination = UPSTREAM) {
  for (const patch of listPatches()) {
    const file = path.join(PATCHES, patch);
    try {
      git(["apply", "--check", file], { cwd: destination });
    } catch (checkError) {
      try {
        git(["apply", "--reverse", "--check", file], { cwd: destination });
        console.log("patch already applied: " + patch);
        continue;
      } catch {
        const detail = checkError.stderr?.toString().trim() || checkError.message;
        throw new Error("patch does not apply: " + patch + "\n" + detail);
      }
    }
    git(["apply", file], { cwd: destination });
    console.log("patch applied: " + patch);
  }
}

function sync() {
  assertPinnedCheckout();
  syncOverlay();
  console.log("overlay synced into " + path.relative(ROOT, UPSTREAM));
}

function apply() {
  assertPinnedCheckout();
  syncOverlay();
  applyPatches();
  console.log("vendor checkout ready at " + lock.commit);
}

function check() {
  assertPinnedCheckout();
  const patches = listPatches();
  const temporary = mkdtempSync(path.join(os.tmpdir(), "dsh-vendor-check-"));
  const tree = path.join(temporary, "tree");
  try {
    git(["worktree", "add", "--detach", tree, "HEAD"], { cwd: UPSTREAM });
    syncOverlay(tree);
    for (const patch of patches) {
      try {
        git(["apply", path.join(PATCHES, patch)], { cwd: tree });
        console.log("patch ok: " + patch);
      } catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        throw new Error("patch does not apply: " + patch + "\n" + detail);
      }
    }
    console.log("vendor check ok: " + lock.tag + " " + lock.commit + ", " + patches.length + " local patch(es)");
  } finally {
    try {
      git(["worktree", "remove", "--force", tree], { cwd: UPSTREAM });
    } catch {
      // The worktree may not have been created; the temporary parent is removed below.
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "init") init(rest);
  else if (command === "sync") sync();
  else if (command === "apply") apply();
  else if (command === "check") check();
  else {
    console.error("usage: node scripts/vendor.mjs init [--from <path>] [--force] | sync | apply | check");
    process.exit(2);
  }
} catch (error) {
  console.error("vendor: " + (error.message || error));
  process.exit(1);
}
