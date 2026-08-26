/**
 * DSH adapter for OMP `internal-urls/memory-protocol.ts` — 仅保留
 * `splitMemoryGlobPattern`（verbatim 纯解析函数，被 verbatim glob.ts 引用）；
 * memory:// 协议解析后端（MemoryProtocolHandler / mnemopi / hindsight /
 * AgentRegistry 记忆根）按 plan.md 判定整体删除——DSH 内部 URL 空路由
 * canHandle 恒 false，该后端运行时不可达。
 */
import { parseInternalUrl } from "../../../omp/internal-urls/parse.ts";
import { validateRelativePath } from "./skill-protocol";

export interface MemoryGlobPattern {
  baseUrl: string;
  globPattern: string;
}

/**
 * Decode percent-escapes in a raw glob-suffix segment, bracket-escaping any
 * glob metacharacter that was percent-encoded so it stays a literal filename
 * character instead of becoming glob syntax.
 */
function decodeGlobSuffixSegment(rawSegment: string): string {
  // Escape runs are decoded together so multi-byte UTF-8 sequences survive.
  return rawSegment.replace(/(?:%[0-9a-f]{2})+/gi, run => decodeURIComponent(run).replace(/[*?[{]/g, "[$&]"));
}

/**
 * Split a memory:// glob at its first wildcard after validating the complete
 * decoded path. The suffix is validated before filesystem globbing so `..`
 * cannot escape a safely resolved base directory.
 */
export function splitMemoryGlobPattern(input: string): MemoryGlobPattern {
  const urlMatch = input.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(\/.*)?$/i);
  if (!urlMatch) {
    throw new Error(`Invalid memory glob URL: ${input}`);
  }

  // Parse only the scheme and authority. A literal `?` in the path is glob
  // syntax, not a query delimiter, and must survive unchanged.
  const url = parseInternalUrl(urlMatch[1]);
  const namespace = url.rawHost || url.hostname;
  if (url.protocol !== "memory:" || namespace !== "root") {
    throw new Error(`Memory glob patterns require the root namespace: ${input}`);
  }

  const rawPathname = urlMatch[2] ?? "";
  if (/%(?:2f|5c)/i.test(rawPathname)) {
    throw new Error(`Encoded path separators are not allowed in memory:// glob patterns: ${input}`);
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(rawPathname.replace(/^\//, ""));
  } catch {
    throw new Error(`Invalid URL encoding in memory:// path: ${input}`);
  }

  try {
    validateRelativePath(relativePath);
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replace("skill://", "memory://"));
  }

  const rawSegments = rawPathname.replace(/^\//, "").split("/");
  const firstGlobIndex = rawSegments.findIndex(segment => ["*", "?", "[", "{"].some(char => segment.includes(char)));
  if (firstGlobIndex === -1) {
    throw new Error(`memory:// URL does not contain a glob pattern: ${input}`);
  }

  const rawBasePath = rawSegments.slice(0, firstGlobIndex).join("/") || ".";
  return {
    baseUrl: `memory://${namespace}/${rawBasePath}`,
    globPattern: rawSegments.slice(firstGlobIndex).map(decodeGlobSuffixSegment).join("/"),
  };
}
