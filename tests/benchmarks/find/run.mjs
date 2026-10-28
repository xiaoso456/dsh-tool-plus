// Find benchmarks: OMP/DSH brush builtin find vs external GNU find, brush
// builtin fd and brush builtin rg's file walker.
//
// Usage:
//   pnpm bench:find
//   pnpm bench:find -- --runs 9

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShell, measureShellCommand, shellQuote } from "../support/harness.mjs";
import { printTable, saveResults } from "../support/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DATA = process.env.BENCH_DATA_DIR
  ? path.resolve(process.env.BENCH_DATA_DIR)
  : path.join(ROOT, "tests", "benchmarks", "data");
const RESULTS = path.join(ROOT, "tests", "benchmarks", "results");

const CASES = [
  { id: "openssl-files", dir: "openssl-3.1.2", findArgs: "-type f", fdArgs: [], rgGlob: null },
  { id: "openssl-c", dir: "openssl-3.1.2", findArgs: "-type f -name '*.c'", fdArgs: ["-e", "c"], rgGlob: "*.c" },
];

function getArg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runs = Number(getArg("runs", "5"));
const warmups = Number(getArg("warmups", "1"));
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(warmups) || warmups < 0) {
  console.error("--runs must be >= 1 and --warmups must be >= 0");
  process.exit(2);
}

function resolveGnuFind() {
  const candidates =
    process.platform === "win32"
      ? ["C:/Program Files/Git/usr/bin/find.exe", "C:/Program Files/Git/bin/find.exe"]
      : ["/usr/bin/find"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isGnuFind(shell, binary) {
  let output = "";
  const result = await shell.run(
    { command: shellQuote(binary) + " --version", cwd: ROOT },
    (_error, chunk) => { output += chunk; },
  );
  return result.exitCode === 0 && output.includes("GNU");
}

const shell = await createShell();
const gnuFind = resolveGnuFind();
const gnuFindUsable = gnuFind ? await isGnuFind(shell, gnuFind) : false;
if (gnuFind && !gnuFindUsable) {
  console.warn("skip GNU find: " + gnuFind + " is not GNU findutils");
}

const rows = [];
for (const benchCase of CASES) {
  const target = path.join(DATA, benchCase.dir);
  if (!existsSync(target)) {
    console.warn("skip " + benchCase.id + ": missing " + path.relative(ROOT, target) + " (run pnpm bench:fetch)");
    continue;
  }
  const targetArg = shellQuote(target);
  const commands = [
    { name: "brush builtin find", command: "find " + targetArg + " " + benchCase.findArgs },
    {
      name: "GNU find",
      command: gnuFindUsable ? shellQuote(gnuFind) + " " + targetArg + " " + benchCase.findArgs : null,
    },
    { name: "brush builtin fd", command: "fd -H -I -t f " + benchCase.fdArgs.join(" ") + " . " + targetArg },
    {
      name: "brush builtin rg --files",
      command: "rg --files -uu " + (benchCase.rgGlob ? "-g " + shellQuote(benchCase.rgGlob) + " " : "") + targetArg,
    },
  ];
  for (const tool of commands) {
    if (!tool.command) continue;
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
      suite: "find",
      case: benchCase.id,
      tool: tool.name,
      command: tool.command,
      ...result,
    });
  }
}

printTable(rows);
const file = await saveResults(RESULTS, "find", rows, {
  runs,
  warmups,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  gnuFind: gnuFindUsable ? gnuFind : null,
});
console.log("\nsaved " + path.relative(ROOT, file));
if (rows.length === 0) process.exit(1);
