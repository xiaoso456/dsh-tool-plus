// Fetch the corpora used by the grep/find benchmarks.
//
// Data lives under tests/benchmarks/data (gitignored). Downloads are pinned:
// - enwik8: the same 100 MB corpus used by ugrep's own benchmark suite.
// - openssl-3.1.2: one file from Genivia/ugrep-benchmarks at a fixed commit,
//   fetched with a blobless partial clone so we do not download its 200 MB pack.
//
// Usage:
//   node tests/benchmarks/fetch.mjs
//   node tests/benchmarks/fetch.mjs --only enwik8
//   node tests/benchmarks/fetch.mjs --force
//
// Set HTTPS_PROXY/HTTP_PROXY (or run a local proxy) if GitHub/file hosts are
// slow on your network; curl and git both honor the standard env vars.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const CACHE = path.join(DATA, ".cache");

const ENWIK8 = {
  url: "https://mattmahoney.net/dc/enwik8.zip",
  sha256: "547994d9980ebed1288380d652999f38a14fe291a6247c157c3d33d4932534bc",
  zip: path.join(CACHE, "enwik8.zip"),
  target: path.join(DATA, "enwik8"),
  marker: path.join(DATA, "enwik8", "enwik8"),
};

const OPENSSL = {
  repo: "https://github.com/Genivia/ugrep-benchmarks.git",
  commit: "d24625d20a360c160b3bc68bcffa32f663905494",
  remotePath: "corpi/openssl-3.1.2.zip",
  rawUrl:
    "https://raw.githubusercontent.com/Genivia/ugrep-benchmarks/" +
    "d24625d20a360c160b3bc68bcffa32f663905494/corpi/openssl-3.1.2.zip",
  sha256: "c2722c5864e7c0cfb7fdd08c84ef183ee1e891dc9d3cb0d29932a5b8542dc566",
  zip: path.join(CACHE, "openssl-3.1.2.zip"),
  gitDir: path.join(CACHE, "ugrep-benchmarks.git"),
  target: path.join(DATA, "openssl-3.1.2"),
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr || "").trim();
    throw new Error(command + " " + args.join(" ") + " failed" + (detail ? ": " + detail : ""));
  }
  return result;
}

function sizeOf(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verifySha(file, expected, label) {
  const actual = hashFile(file);
  const size = sizeOf(file);
  console.log(label + ": " + size + " bytes, sha256=" + actual);
  if (expected && actual !== expected) {
    throw new Error(label + " checksum mismatch: expected " + expected + ", got " + actual);
  }
  return actual;
}

function download(url, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const args = ["-L", "--fail", "--retry", "5", "--retry-delay", "2", "--retry-all-errors", "-o", dest];
  if (sizeOf(dest) > 0 && !process.env.BENCH_NO_RESUME) args.push("-C", "-");
  args.push(url);
  console.log("downloading " + url + (args.includes("-C") ? " (resume)" : ""));
  run("curl", args);
}

function unzip(zip, target) {
  mkdirSync(target, { recursive: true });
  console.log("unzipping " + path.basename(zip) + " -> " + path.relative(process.cwd(), target));
  run("unzip", ["-q", "-o", zip, "-d", target]);
}

function ensureEnwik8(force) {
  if (!force && existsSync(ENWIK8.marker)) {
    console.log("enwik8 already extracted: " + path.relative(process.cwd(), ENWIK8.marker));
    return;
  }
  if (force || !existsSync(ENWIK8.zip) || sizeOf(ENWIK8.zip) < 1024 * 1024) {
    download(ENWIK8.url, ENWIK8.zip);
  } else {
    console.log("using cached archive " + path.relative(process.cwd(), ENWIK8.zip));
  }
  verifySha(ENWIK8.zip, ENWIK8.sha256, "enwik8.zip");
  unzip(ENWIK8.zip, ENWIK8.target);
  if (!existsSync(ENWIK8.marker)) {
    throw new Error("enwik8 archive did not produce " + ENWIK8.marker);
  }
  console.log("enwik8 ready: " + path.relative(process.cwd(), ENWIK8.marker));
}

function fetchOpensslViaGit() {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(path.join(OPENSSL.gitDir, ".git"))) {
    mkdirSync(OPENSSL.gitDir, { recursive: true });
    run("git", ["init", "--quiet", OPENSSL.gitDir]);
    run("git", ["-C", OPENSSL.gitDir, "remote", "add", "origin", OPENSSL.repo]);
  }
  console.log("fetching " + OPENSSL.commit.slice(0, 12) + " (blobless partial clone metadata)");
  run("git", [
    "-C", OPENSSL.gitDir,
    "fetch", "--quiet", "--depth", "1", "--filter=blob:none",
    "origin", OPENSSL.commit,
  ]);
  console.log("fetching " + OPENSSL.remotePath + " blob");
  const result = spawnSync(
    "git",
    ["-C", OPENSSL.gitDir, "show", "FETCH_HEAD:" + OPENSSL.remotePath],
    { maxBuffer: 128 * 1024 * 1024, env: process.env },
  );
  if (result.error || result.status !== 0) {
    throw new Error("git show failed: " + (result.error?.message ?? String(result.stderr)));
  }
  writeFileSync(OPENSSL.zip, result.stdout);
}

function ensureOpenssl(force) {
  if (!force && existsSync(OPENSSL.target)) {
    console.log("openssl already extracted: " + path.relative(process.cwd(), OPENSSL.target));
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  if (force || !existsSync(OPENSSL.zip) || sizeOf(OPENSSL.zip) < 1024 * 1024) {
    try {
      download(OPENSSL.rawUrl, OPENSSL.zip);
    } catch (error) {
      console.warn("raw download failed (" + error.message + "); falling back to blobless git fetch");
      fetchOpensslViaGit();
    }
  } else {
    console.log("using cached archive " + path.relative(process.cwd(), OPENSSL.zip));
  }
  verifySha(OPENSSL.zip, OPENSSL.sha256, "openssl-3.1.2.zip");
  unzip(OPENSSL.zip, DATA);
  if (!existsSync(OPENSSL.target)) {
    throw new Error("openssl archive did not produce " + OPENSSL.target);
  }
  console.log("openssl ready: " + path.relative(process.cwd(), OPENSSL.target));
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const force = args.includes("--force");
if (only && only !== "enwik8" && only !== "openssl") {
  console.error("--only must be enwik8 or openssl");
  process.exit(2);
}

mkdirSync(DATA, { recursive: true });
try {
  if (!only || only === "enwik8") ensureEnwik8(force);
  if (!only || only === "openssl") ensureOpenssl(force);
} catch (error) {
  console.error("\nbenchmark data fetch failed: " + error.message);
  console.error("If the host is slow, set HTTPS_PROXY/HTTP_PROXY (for example http://127.0.0.1:10808) and retry.");
  process.exit(1);
}
