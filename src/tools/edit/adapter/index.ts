/**
 * DSH edit tool — adapter that wires the verbatim OMP edit engine
 * (`src/tools/edit/omp/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All edit logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - picks the edit mode from the call shape (replace / patch / hashline /
 *    apply_patch), exactly like OMP's `EditTool.mode` resolution,
 *  - dispatches to the OMP execute functions and converts the
 *    `AgentToolResult` back to a DSH tool result.
 *
 * LSP/ACP/TUI are absent in DSH (plan.md §3): writethrough writes through
 * ctx.fs, diagnostics are never produced, and no TUI rendering happens.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { Settings } from '../../shared/omp/config/settings.ts'
import { getDefault } from '../../shared/omp/config/settings-schema.ts'
import type { ToolSession } from '../../shared/omp/tools/index.ts'
import type {
  FileDiagnosticsResult,
  WritethroughCallback,
  WritethroughDeferredHandle,
} from '../../shared/omp/lsp/index.ts'
import { executeReplace } from './omp/modes/replace.ts'
import { executePatchSingle, type PatchEditEntry } from './omp/modes/patch.ts'
import { executeHashlineSingle } from './omp/hashline/execute.ts'
import { expandApplyPatchToEntries } from './omp/modes/apply-patch.ts'
import type { RuntimeConfig } from '../../../config/settings.ts'
import {
  renderOmpPrompt,
  sanitizeApplyPatchPrompt,
  sanitizeHashlinePrompt,
  sanitizePatchPrompt,
  sanitizeReplacePrompt,
} from '../../shared/omp-prompt.ts'
import patchMd from './prompts/tools/patch.md' with { type: 'text' }
import applyPatchMd from './prompts/tools/apply-patch.md' with { type: 'text' }
import replaceMd from './prompts/tools/replace.md' with { type: 'text' }
import hashlinePromptMd from '../../hashline/omp-hashline/src/prompt.md' with { type: 'text' }

/** OMP 原版按模式渲染的 edit 描述（prompts/tools/*.md verbatim + hashline 引擎 prompt.md）。 */
const EDIT_MODE_DESCRIPTIONS = {
  replace: renderOmpPrompt(sanitizeReplacePrompt(replaceMd), {}),
  patch: renderOmpPrompt(sanitizePatchPrompt(patchMd), {}),
  apply_patch: renderOmpPrompt(sanitizeApplyPatchPrompt(applyPatchMd), {}),
  hashline: renderOmpPrompt(sanitizeHashlinePrompt(hashlinePromptMd), {}),
} as const

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  return { cwd, settings, enableLsp: false, hasEditTool: true }
}

/** LSP writethrough for DSH: write via ctx.fs (no LSP formatting/diagnostics). */
function createWritethrough(ctx: Context, exec: any): WritethroughCallback {
  return async (
    dst: string,
    content: string,
    signal?: AbortSignal,
    file?: { write(content: string): Promise<void> },
  ): Promise<FileDiagnosticsResult | undefined> => {
    if (file) {
      await file.write(content)
      return undefined
    }
    const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const target = await ctx.fs.resolve(dst, { cwd, signal })
    await ctx.fs.writeText(target, content, undefined, signal)
    return undefined
  }
}

/** Deferred-diagnostics handle factory (no LSP in DSH — inert). */
function beginDeferredDiagnostics(_path: string): WritethroughDeferredHandle {
  return {
    onDeferredDiagnostics: () => {},
    signal: new AbortController().signal,
    finalize: () => {},
  }
}

/** Extract the text content of an OMP AgentToolResult (throws on isError). */
function toText(result: AgentToolResult<any>): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (result.isError) {
    throw new Error(text || 'edit failed')
  }
  return text
}

/** Run one patch entry through the verbatim OMP patch engine. */
function runPatchEntry(options: {
  session: ToolSession
  path: string
  entry: PatchEditEntry
  signal?: AbortSignal
  writethrough: WritethroughCallback
  /**
   * OMP-faithful create policy: the JSON `patch` mode sanctions
   * `op: "create"` as full-file overwrite (allowCreateOverwrite: true), while
   * the Codex `apply_patch` envelope documents `*** Add File` as strictly
   * non-overwriting (left unset). Defaults to false (apply_patch contract).
   */
  allowCreateOverwrite?: boolean
}): Promise<AgentToolResult<any>> {
  return executePatchSingle({
    session: options.session,
    path: options.path,
    params: options.entry,
    signal: options.signal,
    batchRequest: undefined,
    allowFuzzy: true,
    fuzzyThreshold: 0.95,
    allowCreateOverwrite: options.allowCreateOverwrite ?? false,
    writethrough: options.writethrough,
    beginDeferredDiagnosticsForPath: beginDeferredDiagnostics,
  })
}

/**
 * Register the edit tool. Mode is resolved per call from the argument shape
 * (matching OMP's mode dispatch):
 *  - `input` present → hashline, or apply_patch when it starts with `***`
 *  - `patch` present → unified-diff patch mode
 *  - `edits` present (or old_string) → replace mode
 */
export function registerEdit(ctx: Context, getConfig: () => RuntimeConfig): () => void {
  // 返回 disposer：editMode 热更新时重注册以刷新按模式选择的描述（见 src/index.ts）。
  return ctx.tools.register(defineTool({
    name: 'edit',
    // "是什么模式，就给什么描述"（用户拍板 2026-08-25）：按配置 editMode
    // 选 OMP 原版模式提示词（replace/patch/apply_patch/hashline 四份 md）。
    // DSH 描述静态，配置变更后需重启生效。
    description:
      EDIT_MODE_DESCRIPTIONS[getConfig().editMode as keyof typeof EDIT_MODE_DESCRIPTIONS] ??
      EDIT_MODE_DESCRIPTIONS.replace,
    parameters: {
      file_path: { type: 'string', description: 'Path to the file to edit (required in replace/patch mode; hashline/apply_patch carry their paths inside `input`)' },
      old_string: { type: 'string', description: 'Literal text to replace (replace mode; required without edits/patch/input)' },
      new_string: { type: 'string', description: 'Replacement text (replace mode; empty string deletes)' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring exactly one (replace mode)' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            oldText: { type: 'string', required: true },
            newText: { type: 'string', required: true },
          },
        },
        description: 'Multi-segment replacements (replace mode; alternative to old_string/new_string)',
      },
      patch: { type: 'string', description: 'Unified diff patch text to apply (patch mode; alternative to old_string/edits)' },
      input: { type: 'string', description: 'Hashline patch input, or Codex *** Begin Patch envelope (hashline/apply_patch mode)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    async execute(args: any, exec: any) {
      const cfg = getConfig()
      const session = createToolSession(exec, cfg)
      const writethrough = createWritethrough(ctx, exec)
      const signal = exec?.signal

      // ---- hashline / apply_patch mode ------------------------------------
      // (OMP-faithful: these modes carry their paths inside `input` — the
      // `[PATH#TAG]` section headers / `*** <File|Move>:` envelope markers —
      // so no top-level file_path is required.)
      if (typeof args.input === 'string' && args.input.trim().length > 0) {
        const isApplyPatch = /^\s*\*\*\* Begin Patch/.test(args.input)
        if (isApplyPatch) {
          const entries = expandApplyPatchToEntries({ input: args.input })
          const texts: string[] = []
          for (const entry of entries) {
            const result = await runPatchEntry({
              session,
              path: entry.path,
              entry: { op: entry.op, rename: entry.rename, diff: entry.diff },
              signal,
              writethrough,
              // apply_patch contract: `*** Add File` is strictly non-overwriting.
            })
            texts.push(
              result.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map(b => b.text)
                .join('\n'),
            )
            if (result.isError) throw new Error(texts.join('\n') || 'apply_patch failed')
          }
          return { text: texts.join('\n') }
        }
        const result = await executeHashlineSingle({
          session,
          input: args.input,
          signal,
          batchRequest: undefined,
          writethrough,
          beginDeferredDiagnosticsForPath: beginDeferredDiagnostics,
        })
        return { text: toText(result) }
      }

      const filePath: string = args.file_path ?? args.path ?? ''
      if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('file_path must be a non-empty string')
      }

      // ---- patch mode (unified diff) ---------------------------------------
      if (typeof args.patch === 'string' && args.patch.trim().length > 0) {
        const result = await runPatchEntry({
          session,
          path: filePath,
          entry: { op: 'update', diff: args.patch },
          signal,
          writethrough,
          // JSON patch mode: `op: "create"` doubles as the documented
          // full-file overwrite (OMP index.ts patch mode).
          allowCreateOverwrite: true,
        })
        return { text: toText(result) }
      }

      // ---- replace mode (single or multi-segment) -------------------------
      const editsInput: { oldText: string; newText: string }[] =
        Array.isArray(args.edits) && args.edits.length > 0
          ? args.edits
          : typeof args.old_string === 'string'
            ? [{ oldText: args.old_string, newText: String(args.new_string ?? '') }]
            : []
      if (editsInput.length === 0) {
        throw new Error('edit: provide old_string/new_string, edits[], patch, or input')
      }
      let totalReplacements = 0
      for (const edit of editsInput) {
        const result = await executeReplace({
          session,
          path: filePath,
          params: { old_string: edit.oldText, new_string: edit.newText, replace_all: args.replace_all ?? false },
          signal,
          batchRequest: undefined,
          allowFuzzy: true,
          fuzzyThreshold: 0.95,
          writethrough,
          beginDeferredDiagnosticsForPath: beginDeferredDiagnostics,
        })
        totalReplacements += (result.details as any)?.replacements ?? 0
        if (result.isError) {
          const first = result.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
          throw new Error(first?.text ?? 'edit failed')
        }
      }
      return { text: `Edited ${filePath}: ${totalReplacements} replacement(s)` }
    },
  }))
}
