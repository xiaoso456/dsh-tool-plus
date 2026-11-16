#!/usr/bin/env node
/**
 * Keep `src/vendor/pi-natives` in sync with the pinned oh-my-pi checkout.
 *
 * The pi-natives JS loader is vendored because tool-plus changes how it resolves
 * the platform package (patches/0006): the plugin bundles this code, so it has
 * to live in the repository instead of being read out of `node_modules` at
 * runtime.
 *
 *   most files       copied byte-for-byte from the pinned commit
 *   loader-state.js  the pinned file with patches/0006 applied
 *
 * Usage:
 *   node scripts/vendor-natives-js.mjs sync    regenerate the vendored copy
 *   node scripts/vendor-natives-js.mjs check   exit 1 when the copy drifted
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = path.join(ROOT, "vendor", "oh-my-pi", "upstream");
const LOCK_PATH = path.join(ROOT, "vendor", "oh-my-pi", "lock.json");
const PATCH_PATH = path.join(ROOT, "vendor", "oh-my-pi", "patches", "0006-natives-local-platform-package.patch");
const OUT_DIR = path.join(ROOT, "src", "vendor", "pi-natives");
const UPSTREAM_NATIVE_DIR = "packages/natives/native";

/** Copied verbatim from the pinned commit. */
const VERBATIM = [
	"index.js",
	"path.js",
	"desktop.js",
	"desktop-adapter.js",
	"embedded-addon.js",
	"version-sentinel.js",
	// Declarations travel with the code. They cannot be one-line re-exports of
	// the npm package: the build aliases `@oh-my-pi/pi-natives` onto this
	// directory, so such a re-export would resolve to itself.
	"index.d.ts",
	"path.d.ts",
	"desktop.d.ts",
	"desktop-adapter.d.ts",
	"loader-state.d.ts",
	"version-sentinel.d.ts",
];

/** Pinned file + patches/0006. */
const PATCHED = "loader-state.js";

function git(args) {
	return execFileSync("git", ["-C", UPSTREAM, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function assertPinned() {
	const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
	let head;
	try {
		head = git(["rev-parse", "HEAD"]).trim();
	} catch {
		throw new Error(`no checkout at ${UPSTREAM}; run: node scripts/vendor.mjs sync`);
	}
	if (head !== lock.commit) {
		throw new Error(
			`checkout is at ${head}, pin is ${lock.commit} (${lock.tag}); run: node scripts/vendor.mjs sync`,
		);
	}
	return lock;
}

/** Read one file from the pinned commit, ignoring anything applied in the work tree. */
function showPinned(file) {
	return git(["show", `HEAD:${UPSTREAM_NATIVE_DIR}/${file}`]);
}

/** Apply patches/0006 to the pinned bytes in a throwaway repo (autocrlf off: keep LF). */
function applyPatch(pristine) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tool-plus-natives-"));
	const work = path.join(tmp, "wt");
	try {
		const target = path.join(work, ...UPSTREAM_NATIVE_DIR.split("/"), PATCHED);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, pristine);
		execFileSync("git", ["-C", work, "init", "-q"]);
		execFileSync("git", ["-C", work, "-c", "core.autocrlf=false", "apply", PATCH_PATH]);
		return fs.readFileSync(target, "utf8");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/** Everything the vendored directory should contain, keyed by filename. */
function build() {
	assertPinned();
	const files = new Map();
	for (const file of VERBATIM) files.set(file, showPinned(file));
	files.set(PATCHED, applyPatch(showPinned(PATCHED)));
	for (const [name, content] of files) {
		if (content.includes("\r")) throw new Error(`${name}: generated content has CRLF, expected LF`);
	}
	return files;
}

function sync() {
	const files = build();
	fs.mkdirSync(OUT_DIR, { recursive: true });
	for (const [name, content] of files) fs.writeFileSync(path.join(OUT_DIR, name), content);
	for (const name of fs.readdirSync(OUT_DIR)) {
		if (name === "VENDOR.md" || files.has(name)) continue;
		throw new Error(`${name} is in ${path.relative(ROOT, OUT_DIR)} but not generated; remove it`);
	}
	console.log(`synced ${files.size} files into ${path.relative(ROOT, OUT_DIR)}`);
}

function check() {
	const files = build();
	const problems = [];
	for (const [name, expected] of files) {
		const target = path.join(OUT_DIR, name);
		const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
		if (actual === null) problems.push(`${name}: missing`);
		else if (actual !== expected) problems.push(`${name}: differs from pin + 0006`);
	}
	if (fs.existsSync(OUT_DIR)) {
		for (const name of fs.readdirSync(OUT_DIR)) {
			if (name !== "VENDOR.md" && !files.has(name)) problems.push(`${name}: not produced by sync`);
		}
	}
	if (problems.length > 0) {
		for (const problem of problems) console.error(`  ${problem}`);
		console.error("vendored pi-natives loader drifted; run: node scripts/vendor-natives-js.mjs sync");
		process.exit(1);
	}
	console.log(`vendored pi-natives loader matches pin + 0006 (${files.size} files)`);
}

const command = process.argv[2];
if (command === "sync") sync();
else if (command === "check") check();
else {
	console.error("usage: node scripts/vendor-natives-js.mjs <sync|check>");
	process.exit(2);
}
