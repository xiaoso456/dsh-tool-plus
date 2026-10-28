import { performance } from "node:perf_hooks";

/** Quote one argument for the POSIX-ish brush shell. */
export function shellQuote(value) {
  const text = String(value);
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * Create one persistent brush shell. All benchmark commands run through the
 * same shell so the builtins (grep/find/fd/rg) are the ones agents actually
 * get, not whatever happens to be on PATH.
 */
export async function createShell() {
  const { Shell } = await import("@oh-my-pi/pi-natives");
  const sessionEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  );
  return new Shell({ sessionEnv });
}

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Measure one shell command, discarding output. Exit 1 is accepted because
 * grep/rg use it for "no matches"; anything else means the tool is missing or
 * the command line is wrong.
 */
export async function measureShellCommand(shell, command, options = {}) {
  const { cwd = process.cwd(), warmups = 1, runs = 5, allowedExitCodes = [0, 1] } = options;
  const samples = [];
  let exitCode = null;
  for (let i = 0; i < warmups + runs; i += 1) {
    const started = performance.now();
    const result = await shell.run({ command: command + " > /dev/null 2>&1", cwd }, () => {});
    const elapsed = performance.now() - started;
    exitCode = result.exitCode;
    if (i === 0 && !allowedExitCodes.includes(exitCode)) {
      return { error: "exit " + exitCode, exitCode };
    }
    if (i >= warmups) samples.push(elapsed);
  }
  return {
    medianMs: median(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samples,
    runs: samples.length,
    exitCode,
  };
}

/** Measure an in-process native call (also with a warmup run). */
export async function measureNative(fn, options = {}) {
  const { warmups = 1, runs = 5 } = options;
  const samples = [];
  for (let i = 0; i < warmups + runs; i += 1) {
    const started = performance.now();
    await fn();
    const elapsed = performance.now() - started;
    if (i >= warmups) samples.push(elapsed);
  }
  return {
    medianMs: median(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samples,
    runs: samples.length,
    exitCode: 0,
  };
}
