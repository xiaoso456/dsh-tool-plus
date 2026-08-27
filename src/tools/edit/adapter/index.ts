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
 * LSP/ACP/TUI are absent in DSH (plan.md 拍板#5/#8): writethrough writes through
 * ctx.fs, diagnostics are never produced, and no TUI rendering happens.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from '../../omp/tools/index.ts'
import type { WritethroughCallback } from '../../omp/tools/writethrough.ts'
import { executeReplace } from '../../omp/edit/modes/replace.ts'
import { executePatchSingle, type PatchEditEntry } from '../../omp/edit/modes/patch.ts'
import { executeHashlineSingle } from '../../omp/edit/hashline/execute.ts'
import { expandApplyPatchToEntries } from '../../omp/edit/modes/apply-patch.ts'
import type { RuntimeConfig } from '../../../config/settings.ts'
import {
  renderOmpPrompt,
  sanitizeApplyPatchPrompt,
  sanitizeHashlinePrompt,
  sanitizePatchPrompt,
  sanitizeReplacePrompt,
} from '../../shared/omp-prompt.ts'
import { resolveSandboxPolicy } from '../../shared/sandbox-policy.ts'
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
  return { cwd, settings, hasEditTool: true }
}

/** File-write channel for DSH (方案A, 2026-08-27): every edit mode funnels
 * through `ctx.fs` with the per-call sandbox policy resolved from the session
 * (official tool-fs semantics). The OMP engines pass a `file` handle for
 * patch/hashline modes — previously this adapter wrote through that handle
 * (OMP node-fs direct write), bypassing the host's sandbox fence entirely,
 * while replace mode went through `ctx.fs` WITHOUT the policy argument and
 * was denied by the deployment fallback. Both defects are fixed here: the
 * handle is ignored and the policy is always attached. */
export function createWritethrough(ctx: Context, exec: any): WritethroughCallback {
  return async (
    dst: string,
    content: string,
    signal?: AbortSignal,
    _file?: { write(content: string): Promise<void> },
  ): Promise<void> => {
    const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const target = await ctx.fs.resolve(dst, { cwd, signal })
    const sandboxPolicy = resolveSandboxPolicy(ctx, exec)
    await ctx.fs.writeText(target, content, undefined, signal, sandboxPolicy)
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
   *   allowFuzzy? / fuzzyThreshold?：面板 edit.fuzzyMatch / edit.fuzzyThreshold
   *   经 Settings 门面直达引擎；undefined = 引擎默认（true / 0.95）。
   */
  allowCreateOverwrite?: boolean
  allowFuzzy?: boolean
  fuzzyThreshold?: number
}): Promise<AgentToolResult<any>> {
  return executePatchSingle({
    session: options.session,
    path: options.path,
    params: options.entry,
    signal: options.signal,
    allowFuzzy: options.allowFuzzy ?? true,
    fuzzyThreshold: options.fuzzyThreshold ?? 0.95,
    allowCreateOverwrite: options.allowCreateOverwrite ?? false,
    writethrough: options.writethrough,
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
      // fuzzy 配置补线：面板 edit.fuzzyMatch/edit.fuzzyThreshold 经 Settings
      // 门面（OMP_KEY_TO_FIELD）直达引擎，替代原硬编码 true/0.95。
      const allowFuzzy = session.settings.get('edit.fuzzyMatch') !== false
      const fuzzyThresholdRaw = session.settings.get('edit.fuzzyThreshold')
      const fuzzyThreshold = typeof fuzzyThresholdRaw === 'number' && fuzzyThresholdRaw > 0 ? fuzzyThresholdRaw : 0.95

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
              allowFuzzy,
              fuzzyThreshold,
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
          writethrough,
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
          allowFuzzy,
          fuzzyThreshold,
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
          allowFuzzy,
          fuzzyThreshold,
          writethrough,
        })
        // 引擎 details 无 replacements 字段（计数只在 resultText："Successfully
        // replaced N occurrences in ..." / "Successfully replaced text in ..."），
        // 从文本回解计数；单命中句式计 1。
        const text = toText(result)
        const occ = /replaced (\d+) occurrences/.exec(text)
        totalReplacements += occ ? Number(occ[1]) : text.startsWith('Successfully replaced') ? 1 : 0
        if (result.isError) {
          const first = result.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
          throw new Error(first?.text ?? 'edit failed')
        }
      }
      return { text: `Edited ${filePath}: ${totalReplacements} replacement(s)` }
    },
  }))
}
