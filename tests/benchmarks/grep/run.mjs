// Grep benchmarks: OMP/DSH brush builtin grep vs external GNU grep, ugrep and
// brush builtin rg, plus the OMP native grep entry point.
//
// Usage:
//   pnpm bench:grep
//   pnpm bench:grep -- --runs 9
//   pnpm bench:grep -- --case enwik8-ere
//
// Prerequisite: pnpm bench:fetch (writes tests/benchmarks/data).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShell, measureNative, measureShellCommand, shellQuote } from "../support/harness.mjs";
import { printTable, saveResults } from "../support/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DATA = process.env.BENCH_DATA_DIR
  ? path.resolve(process.env.BENCH_DATA_DIR)
  : path.join(ROOT, "tests", "benchmarks", "data");
const RESULTS = path.join(ROOT, "tests", "benchmarks", "results");

const CASES = [
  {
    id: "enwik8-the",
    kind: "file",
    file: "enwik8/enwik8",
    pattern: "the",
    nativeMode: "count",
  },
  {
    id: "enwik8-ere",
    kind: "file",
    file: "enwik8/enwik8",
    pattern: "(the|and)",
    nativeMode: "count",
  },
  {
    id: "openssl-ssl-ctx",
    kind: "recursive",
    file: "openssl-3.1.2",
    pattern: "SSL_CTX",
    nativeMode: "filesWithMatches",
  },
];

function getArg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runs = Number(getArg("runs", "5"));
const warmups = Number(getArg("warmups", "1"));
const caseFilter = getArg("case", null);
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(warmups) || warmups < 0) {
  console.error("--runs must be >= 1 and --warmups must be >= 0");
  process.exit(2);
}

function resolveGnuGrep() {
  const candidates =
    process.platform === "win32"
      ? ["C:/Program Files/Git/usr/bin/grep.exe", "C:/Program Files/Git/bin/grep.exe"]
      : ["/usr/bin/grep", "/bin/grep"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isGnuGrep(shell, binary) {
  let output = "";
  const result = await shell.run(
    { command: shellQuote(binary) + " --version", cwd: ROOT },
    (_error, chunk) => { output += chunk; },
  );
  return result.exitCode === 0 && output.includes("GNU grep");
}

function targetOf(benchCase) {
  return path.join(DATA, benchCase.file);
}

function commandsFor(benchCase, target, gnuGrep) {
  const pattern = shellQuote(benchCase.pattern);
  const targetArg = shellQuote(target);
  const flags = benchCase.kind === "file" ? "-cE" : "-rlE";
  const commands = [
    { name: "brush builtin grep", command: "grep " + flags + " -- " + pattern + " " + targetArg },
    { name: "ugrep", command: "ugrep " + flags + " -- " + pattern + " " + targetArg },
    {
      name: "brush builtin rg",
      command:
        benchCase.kind === "file"
          ? "rg -c -e " + pattern + " " + targetArg
          : "rg -l -uu -e " + pattern + " " + targetArg,
    },
  ];
  if (gnuGrep) {
    commands.splice(1, 0, {
      name: "GNU grep",
      command: shellQuote(gnuGrep) + " " + flags + " -- " + pattern + " " + targetArg,
    });
  }
  return commands;
}

const selected = CASES.filter((item) => !caseFilter || item.id === caseFilter);
if (selected.length === 0) {
  console.error("unknown --case; available: " + CASES.map((item) => item.id).join(", "));
  process.exit(2);
}

const shell = await createShell();
const gnuGrepPath = resolveGnuGrep();
const gnuGrepUsable = gnuGrepPath ? await isGnuGrep(shell, gnuGrepPath) : false;
if (gnuGrepPath && !gnuGrepUsable) {
  console.warn("skip GNU grep: " + gnuGrepPath + " is not GNU grep");
}
const rows = [];
for (const benchCase of selected) {
  const target = targetOf(benchCase);
  if (!existsSync(target)) {
    console.warn("skip " + benchCase.id + ": missing " + path.relative(ROOT, target) + " (run pnpm bench:fetch)");
    continue;
  }
  for (const tool of commandsFor(benchCase, target, gnuGrepUsable ? gnuGrepPath : null)) {
    const result = await measureShellCommand(shell, tool.command, {
      cwd: ROOT,
      runs,
      warmups,
    });
    if (result.error) {
      console.warn("skip " + benchCase.id + " / " + tool.name + ": " + result.error);
      continue;
    }
    rows.push({
      suite: "grep",
      case: benchCase.id,
      tool: tool.name,
      command: tool.command,
      ...result,
    });
  }

  try {
    const natives = await import("@oh-my-pi/pi-natives");
    const mode =
      benchCase.nativeMode === "count"
        ? natives.GrepOutputMode.Count
        : natives.GrepOutputMode.FilesWithMatches;
    const result = await measureNative(
      () =>
        natives.grep({
          pattern: benchCase.pattern,
          path: target,
          hidden: true,
          gitignore: false,
          mode,
        }),
      { runs, warmups },
    );
    rows.push({
      suite: "grep",
      case: benchCase.id,
      tool: "OMP grep (native)",
      command: "(in-process pi-natives grep)",
      ...result,
    });
  } catch (error) {
    console.warn("skip " + benchCase.id + " / OMP grep (native): " + error.message);
  }
}

printTable(rows);
const file = await saveResults(RESULTS, "grep", rows, {
  runs,
  warmups,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  gnuGrep: gnuGrepUsable ? gnuGrepPath : null,
});
console.log("\nsaved " + path.relative(ROOT, file));
if (rows.length === 0) process.exit(1);
