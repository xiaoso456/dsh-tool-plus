import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function printTable(rows) {
  const printable = rows.filter((row) => !row.error);
  if (printable.length === 0) {
    console.log("(no successful benchmark rows)");
    return;
  }
  const header = ["case", "tool", "median"];
  const body = printable.map((row) => [
    row.case,
    row.tool,
    row.medianMs.toFixed(1) + " ms",
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) console.log(line(row));
}

export async function saveResults(resultsDir, suite, rows, meta) {
  await mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(resultsDir, suite + "-" + stamp + ".json");
  await writeFile(file, JSON.stringify({ suite, meta, rows }, null, 2) + "\n", "utf8");
  return file;
}
