import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { glob, type GlobMatch } from "@oh-my-pi/pi-natives";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Register DSH `glob` tool — OMP parallel walker, mtime-sorted, no TUI.
 * Keeps: parallel walker, depth bound, mtime sort, early stop, multi-root.
 * Removes: TUI rendering.
 */
export function registerGlob(ctx: Context): void {
  ctx.tools.register(
    (defineTool as any)({
      name: "glob",
      description:
        "Fast file discovery using pi-natives parallel walker (mtime-sorted, respects .gitignore, depth-bounded, early-stop). Pattern is a glob (e.g. \"**/*.ts\"). Use `path` as search root (defaults to session cwd); multiple roots can be \";\" separated. Results are mtime-desc, path-asc, grouped by directory.",
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description: 'Glob pattern to match (e.g. "**/*.ts", "*.js", "src/**/*.tsx")',
        },
        path: {
          type: "string",
          description:
            'Search root directory — single path or ";"-delimited list of roots (e.g. "src; tests"). Defaults to session cwd (".").',
        },
        limit: {
          type: "number",
          description: "Max results to return (1-200, default 200). Results are truncated from the head (most recent first).",
        },
        hidden: {
          type: "boolean",
          description: "Include hidden files (default true, OMP parity).",
        },
        gitignore: {
          type: "boolean",
          description: "Respect .gitignore (default true).",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
      },
      async execute(args: { pattern: string; path?: string; limit?: number; hidden?: boolean; gitignore?: boolean }, exec: any): Promise<string> {
        const pattern = (args.pattern ?? "").trim();
        if (!pattern) throw new Error("`pattern` is required and must be a non-empty glob");

        const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd();

        const requestedLimit = args.limit ?? DEFAULT_LIMIT;
        if (requestedLimit !== undefined && (!Number.isFinite(requestedLimit) || requestedLimit <= 0)) {
          throw new Error("`limit` must be a positive number");
        }
        const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit ?? DEFAULT_LIMIT)));

        const includeHidden = args.hidden ?? true;
        const useGitignore = args.gitignore ?? true;

        // Multi-root ";" separated (OMP glob.ts parity)
        const rawRoots: string[] = (() => {
          const p = args.path?.trim();
          if (!p) return ["."];
          return p
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);
        })();

        const absoluteRoots = rawRoots.map((r) => (path.isAbsolute(r) ? path.normalize(r) : path.resolve(cwd, r)));

        // Build combined abort signal with 5s timeout (OMP DEFAULT_GLOB_TIMEOUT_MS)
        const execSignal: AbortSignal | undefined = exec?.signal;
        const timeoutSignal: AbortSignal =
          typeof (AbortSignal as any).timeout === "function"
            ? (AbortSignal as any).timeout(DEFAULT_TIMEOUT_MS)
            : (() => {
                const c = new AbortController();
                setTimeout(() => c.abort(new Error("glob timeout")), DEFAULT_TIMEOUT_MS);
                return c.signal;
              })();
        const combinedSignal: AbortSignal =
          execSignal && typeof (AbortSignal as any).any === "function"
            ? (AbortSignal as any).any([execSignal, timeoutSignal])
            : execSignal ?? timeoutSignal;

        const toCwdRelative = (absPath: string): string => {
          const rel = path.relative(cwd, absPath) || ".";
          return rel.split(path.sep).join("/");
        };

        const formatMatchPath = (matchPath: string, base: string): string => {
          // matchPath is relative to base (with "/") per pi-natives GlobMatch.path
          const abs = path.isAbsolute(matchPath) ? matchPath : path.resolve(base, matchPath);
          return toCwdRelative(abs);
        };

        type Scored = { rel: string; mtime: number };

        // Run each root concurrently — per-plan §5.2 multi-root, per-path walker keeps scans bounded
        const perRootResults = await Promise.all(
          absoluteRoots.map(async (root): Promise<Scored[]> => {
            // Fast existence check — mirror OMP partitionExistingPaths tolerance for multi-root:
            // skip missing roots, error only if single root is missing
            try {
              const st = await fs.promises.stat(root);
              if (!st.isDirectory()) {
                // If pattern points at a file, pi-natives would handle it; but for explicit file root
                // without glob, treat as single file match if exists
                if (absoluteRoots.length === 1) throw new Error(`Path is not a directory: ${root}`);
                return [];
              }
            } catch (e: any) {
              if (e?.code === "ENOENT" || e?.message?.includes("not a directory")) {
                if (absoluteRoots.length === 1) throw new Error(`Path not found: ${root}`);
                return [];
              }
              throw e;
            }

            const streamed: Scored[] = [];
            const seen = new Set<string>();
            const onMatch = (_err: Error | null, m: GlobMatch | null) => {
              if (!m?.path) return;
              if (combinedSignal.aborted) return;
              const rel = formatMatchPath(m.path, root);
              if (seen.has(rel)) return;
              seen.add(rel);
              streamed.push({ rel, mtime: m.mtime ?? 0 });
            };

            try {
              const res = await glob(
                {
                  pattern,
                  path: root,
                  hidden: includeHidden,
                  gitignore: useGitignore,
                  sortByMtime: true,
                  maxResults: effectiveLimit,
                  timeoutMs: DEFAULT_TIMEOUT_MS,
                  signal: combinedSignal,
                } as any,
                onMatch as any,
              );
              // Native already mtime-sorted; prefer result.matches but fall back to streamed for timeout partials
              if (res?.matches?.length) {
                const fromResult: Scored[] = [];
                const dedup = new Set<string>();
                for (const m of res.matches) {
                  if (!m.path) continue;
                  const rel = formatMatchPath(m.path, root);
                  if (dedup.has(rel)) continue;
                  dedup.add(rel);
                  fromResult.push({ rel, mtime: m.mtime ?? 0 });
                }
                // If streaming collected more (shouldn't), merge; otherwise use result
                return fromResult.length ? fromResult : streamed;
              }
              return streamed;
            } catch (err: any) {
              if (err?.name === "AbortError" || combinedSignal.aborted) {
                const isTimeout = (timeoutSignal as any).aborted && !execSignal?.aborted;
                if (isTimeout) {
                  // Return partial streamed matches instead of throwing — worst case is blind retry
                  return streamed;
                }
                throw err;
              }
              throw err;
            }
          }),
        );

        const isTimeout = (timeoutSignal as any).aborted && !execSignal?.aborted;

        // Merge per-root: dedup across roots, global mtime desc path asc re-sort (OMP parity)
        const seenGlobal = new Set<string>();
        const merged: Scored[] = [];
        for (const group of perRootResults) {
          for (const e of group) {
            if (seenGlobal.has(e.rel)) continue;
            seenGlobal.add(e.rel);
            merged.push(e);
          }
        }
        merged.sort((a, b) => {
          if (b.mtime !== a.mtime) return b.mtime - a.mtime;
          return a.rel.localeCompare(b.rel);
        });

        const sortedRels = merged.map((e) => e.rel);

        // Early empty
        if (sortedRels.length === 0) {
          if (isTimeout) {
            return `Glob timed out after ${DEFAULT_TIMEOUT_MS / 1000}s before finding any matches — the scan is incomplete, NOT proof of absence. Scope the search to a deeper directory (e.g. sub/dir/*.ext instead of *.ext at a huge root).`;
          }
          return "No files found";
        }

        // Apply limit 200 truncateHead (OMP DEFAULT_LIMIT / MAX_LIMIT)
        const truncated = sortedRels.length > effectiveLimit;
        const limited = truncated ? sortedRels.slice(0, effectiveLimit) : sortedRels;
        const totalBeforeTruncate = sortedRels.length;

        // Spill full sorted result (the limited head, up to 200) to temp file for >100 notice
        let spillPath: string | undefined;
        if (limited.length > 100 || truncated || isTimeout) {
          try {
            const spillText = limited.join("\n");
            const file = path.join(os.tmpdir(), `dsh-glob-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
            await fs.promises.writeFile(file, spillText, "utf-8");
            spillPath = file;
          } catch {
            // non-fatal
          }
        }

        // Group by directory for rendering
        const formatGrouped = (paths: string[]): string => {
          if (paths.length === 0) return "";
          // Build dir -> files map, sorted
          const groups = new Map<string, string[]>();
          for (const p of paths) {
            const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
            const arr = groups.get(dir) ?? [];
            arr.push(p);
            groups.set(dir, arr);
          }
          const sortedDirs = [...groups.keys()].sort((a, b) => {
            if (a === ".") return -1;
            if (b === ".") return 1;
            return a.localeCompare(b);
          });
          const lines: string[] = [];
          for (const dir of sortedDirs) {
            const files = groups.get(dir)!;
            // header
            if (dir === ".") lines.push("# ./");
            else lines.push(`# ${dir}/`);
            for (const f of files.sort()) lines.push(f);
            lines.push("");
          }
          if (lines.length && lines[lines.length - 1] === "") lines.pop();
          return lines.join("\n");
        };

        // Sampling across top levels when >100 (OMP sampleAcrossTopLevel parity, simplified)
        const sampleAcrossTopLevels = (paths: string[], n: number): string[] => {
          if (paths.length <= n) return paths;
          const byTop = new Map<string, string[]>();
          for (const p of paths) {
            const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : ".";
            const arr = byTop.get(top) ?? [];
            arr.push(p);
            byTop.set(top, arr);
          }
          const tops = [...byTop.keys()].sort((a, b) => {
            if (a === ".") return -1;
            if (b === ".") return 1;
            return a.localeCompare(b);
          });
          // Round-robin: first give each top one slot, then round-robin remainder
          const result: string[] = [];
          const cursors = new Map<string, number>();
          for (const t of tops) cursors.set(t, 0);
          // First pass: one per top
          for (const t of tops) {
            if (result.length >= n) break;
            const arr = byTop.get(t)!;
            const idx = cursors.get(t)!;
            if (idx < arr.length) {
              result.push(arr[idx]!);
              cursors.set(t, idx + 1);
            }
          }
          // Round-robin remainder
          let progressed = true;
          while (result.length < n && progressed) {
            progressed = false;
            for (const t of tops) {
              if (result.length >= n) break;
              const arr = byTop.get(t)!;
              const idx = cursors.get(t)!;
              if (idx < arr.length) {
                result.push(arr[idx]!);
                cursors.set(t, idx + 1);
                progressed = true;
              }
            }
          }
          // Preserve original mtime order for sampled set? Keep sampled in mtime order intersection
          const sampledSet = new Set(result);
          return paths.filter((p) => sampledSet.has(p)).slice(0, n);
        };

        let displayPaths: string[];
        let notice: string | undefined;

        if (limited.length <= 100) {
          displayPaths = limited;
        } else {
          displayPaths = sampleAcrossTopLevels(limited, 100);
          const totalMsg = truncated ? `${totalBeforeTruncate} (showing top ${effectiveLimit} by mtime)` : `${limited.length}`;
          notice = `Showing ${displayPaths.length} of ${totalMsg} paths (sorted by mtime, most recent first). Full sorted result stored at: ${spillPath ?? "(spill failed)"}`;
        }

        if (isTimeout && limited.length > 0) {
          const seconds = DEFAULT_TIMEOUT_MS % 1000 === 0 ? `${DEFAULT_TIMEOUT_MS / 1000}` : (DEFAULT_TIMEOUT_MS / 1000).toFixed(1);
          const timeoutNotice = `glob timed out after ${seconds}s; returning ${limited.length} partial matches — results are incomplete, scope to a deeper directory instead of retrying blindly`;
          notice = notice ? `${timeoutNotice}\n${notice}` : timeoutNotice;
        } else if (truncated && displayPaths.length <= 100) {
          // Still need to surface truncation even when not sampling
          const truncNotice = `Results truncated to ${effectiveLimit} (of ${totalBeforeTruncate} total matches). Full sorted result stored at: ${spillPath ?? "(spill failed)"}`;
          notice = notice ? `${notice}\n${truncNotice}` : truncNotice;
        } else if (isTimeout) {
          // Already handled empty above
        }

        const body = formatGrouped(displayPaths);
        if (notice) return `${body}\n\n${notice}`;
        return body;
      },
    }),
  );
}

// Alias for lib/types expectation
export const applyGlobTool = registerGlob;
export default registerGlob;
