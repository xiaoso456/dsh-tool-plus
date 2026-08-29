/**
 * DSH edit tool — adapter that wires the verbatim OMP edit engine
 * (`src/tools/omp/edit/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All edit logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - picks the edit mode from the call shape (replace / patch / hashline /
 *    apply_patch), exactly like OMP's `EditTool.mode` resolution,
 *  - hands replace/apply_patch to the verbatim upstream dispatch layer
 *    (`omp/edit/dispatch.ts`，A-7/A-8：resolveEditPath 路径纠错 +
 *    executeSinglePathEntries / executeApplyPatchPerFile 聚合) and converts
 *    the `AgentToolResult` back to a DSH tool result.
 *
 * LSP/ACP/TUI are absent in DSH (plan.md 拍板#5/#8): writethrough writes through
 * ctx.fs, diagnostics are never produced, and no TUI rendering happens.
 */
import type { Context } from '@deepseek-ai/cordis'
// 加载 dsh-fs 对 Context 的模块增强（ctx.fs 类型）。原由 read-image 的
// side-effect import 提供，read_image 删除后在此显式声明（2026-08-28）。
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { Settings } from '../../omp/config/settings.ts'
import { getDefault } from '../../omp/config/settings-schema.ts'
import type { ToolSession } from '../../omp/tools/index.ts'
import type { WritethroughCallback } from '../../omp/tools/writethrough.ts'
import { DEFAULT_FUZZY_THRESHOLD, executeReplace } from '../../omp/edit/modes/replace.ts'
import { executePatchSingle, type PatchEditEntry } from '../../omp/edit/modes/patch.ts'
import { executeHashlineSingle } from '../../omp/edit/hashline/execute.ts'
import { expandApplyPatchToEntries } from '../../omp/edit/modes/apply-patch.ts'
import { executeApplyPatchPerFile, executeSinglePathEntries, resolveEditPath } from '../../omp/edit/dispatch.ts'
import { writethroughNoop } from '../../omp/tools/writethrough.ts'
import { attachOmpSessionState, persistOmpSessionState } from '../../shared/session-state.ts'
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
import hashlinePromptMd from '../../hashline/engine/prompt.md' with { type: 'text' }

/**
 * S-14c：patch.md 是 OMP JSON patch 入口的 verbatim 提示词，其 <parameters>
 * 块教模型发 `{ path, edits: Entry[] }` 形状；而 DSH schema（registerEdit）只收
 * `patch: string`（unified-diff 文本 + `file_path` 定位文件），create/delete/
 * rename 走 `input` 的 `*** Begin Patch` 信封（apply_patch 模式）。此处把该块
 * 重写为与 schema 一致的参数说明，其余段落（hunk/anchor 语法、critical、avoid）
 * 保持 verbatim。sanitize 本体在 shared/omp-prompt.ts（不动）。
 */
function rewritePatchParametersForSchema(description: string): string {
  const block = /<parameters>[\s\S]*?<\/parameters>/.exec(description)
  if (!block) return description
  return description.replace(
    block[0],
    [
      '<parameters>',
      '- `file_path` (string, required): the file to patch.',
      '- `patch` (string, required): unified diff applied to that file — one or more hunks, each beginning with `@@` (anchor optional); hunk body lines start with a space (context), `+` (add), or `-` (remove); every hunk must contain at least one change.',
      '- Creating, deleting or renaming files is not available in patch mode: pass an `input` string with a Codex `*** Begin Patch` envelope instead (`*** Add File:`, `*** Delete File:`, `*** Update File:` with `*** Move to:`).',
      '</parameters>',
    ].join('\n'),
  )
}
/** OMP 原版按模式渲染的 edit 描述（prompts/tools/*.md verbatim + hashline 引擎 prompt.md）。 */
export const EDIT_MODE_DESCRIPTIONS = {
  replace: renderOmpPrompt(sanitizeReplacePrompt(replaceMd), {}),
  patch: rewritePatchParametersForSchema(renderOmpPrompt(sanitizePatchPrompt(patchMd), {})),
  apply_patch: renderOmpPrompt(sanitizeApplyPatchPrompt(applyPatchMd), {}),
  hashline: renderOmpPrompt(sanitizeHashlinePrompt(hashlinePromptMd), {}),
} as const

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  const session: ToolSession = { cwd, settings, hasEditTool: true }
  // 恢复本 DSH session 上次调用保存的 OMP 引擎状态（冲突注册表等，T11-2）。
  attachOmpSessionState(session, exec?.agent?.session)
  return session
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

/** DSH edit 工具输出形状（output.schema 镜像）。 */
export interface EditToolOutput {
  text: string
}

/**
 * 把 dispatch 聚合结果转成 DSH 输出。成功：保留引擎 per-entry 摘要原文；
 * 失败：抛出完整聚合文案，并在“失败即末条目”的空档补上游同款未应用指引。
 *
 * 上游 executeSinglePathEntries / executeApplyPatchPerFile 的 NOT-applied 指引
 * 只覆盖失败条目**之后**的未应用条目；失败发生在末条目时（无后续条目）不再
 * 输出，而失败条目本身同样未被应用——此处按上游同款句式补点名（A-7 契约：
 * 错误信息三要素 already applied / NOT applied / re-issue only 齐全）。
 */
function toEditToolResult(
  result: AgentToolResult<any>,
  entryCount: number,
  failedEntry: number | undefined,
  failedPath?: string,
): EditToolOutput {
  const text = result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  if (result.isError) {
    const supplement =
      entryCount > 1 && failedEntry !== undefined && failedEntry === entryCount
        ? failedPath !== undefined
          ? `\nFiles NOT applied: ${failedPath}; re-read the affected files and re-issue only the failed and unapplied files.`
          : `\nEntry ${failedEntry} was NOT applied; re-read the file and re-issue only the failed and unapplied entries.`
        : ''
    throw new Error(`${text || 'edit failed'}${supplement}`)
  }
  return { text }
}

/**
 * S-13：edit.fuzzyThreshold 解析——上游 settings 面原样放行显式 0/负值
 * （0 = 接受任意置信度的最佳匹配，refs edit/index.ts:112 同款语义），仅
 * undefined/非数值回退引擎默认 0.95。env 层（上游 PI_EDIT_FUZZY* 环境变量
 * 串解析）有意不移植：DSH 无该环境变量面，面板字段是唯一入口。
 */
export function resolveFuzzyThreshold(raw: unknown): number {
  return typeof raw === 'number' ? raw : DEFAULT_FUZZY_THRESHOLD
}
/** 完整执行链路（defineTool.execute 与单测共用，镜像 read 的 executeReadTool）。 */
export async function executeEditTool(exec: any, cfg: RuntimeConfig, args: any, ctx: Context | null): Promise<EditToolOutput> {
  const session = createToolSession(exec, cfg)
  // 无宿主 ctx（直调/单测）时退回 OMP 原生直写通道；宿主环境恒有 ctx.fs 沙箱通道。
  const writethrough = ctx ? createWritethrough(ctx, exec) : writethroughNoop
  const cwd = session.cwd
  const signal = exec?.signal
  // fuzzy 配置补线：面板 edit.fuzzyMatch/edit.fuzzyThreshold 经 Settings 门面
  // （OMP_KEY_TO_FIELD）直达引擎，替代原硬编码 true/0.95。S-13：显式 0/负值
  // 原样放行（0 = 接受任意置信度的最佳匹配），仅 undefined/非数值回退引擎
  // 默认 0.95；env 层（上游 PI_EDIT_FUZZY*）有意不移植。
  const allowFuzzy = session.settings.get('edit.fuzzyMatch') !== false
  const fuzzyThreshold = resolveFuzzyThreshold(session.settings.get('edit.fuzzyThreshold'))

  try {
    // ---- hashline / apply_patch mode ------------------------------------
    // (OMP-faithful: these modes carry their paths inside `input` — the
    // `[PATH#TAG]` section headers / `*** <File|Move>:` envelope markers —
    // so no top-level file_path is required.)
    if (typeof args.input === 'string' && args.input.trim().length > 0) {
      const isApplyPatch = /^\s*\*\*\* Begin Patch/.test(args.input)
      if (isApplyPatch) {
        // A-7：apply_patch 多文件聚合改走上游 dispatch（executeApplyPatchPerFile），
        // 保留引擎 per-file 文本与 diff，失败输出已应用/未应用文件清单。
        const entries = expandApplyPatchToEntries({ input: args.input })
        // Resolve each authored path once per patch so paired hunks (e.g. delete
        // then re-add of the same file) share the same workspace target.
        const resolvedTargets = new Map<string, Promise<string>>()
        const resolveOnce = (authoredPath: string, mustExist: boolean): Promise<string> => {
          let pending = resolvedTargets.get(authoredPath)
          if (!pending) {
            pending = resolveEditPath(session, authoredPath, { mustExist, signal })
            resolvedTargets.set(authoredPath, pending)
          }
          return pending
        }
        let failedFile: number | undefined
        const perFile = entries.map((entry, idx) => {
          const { path: entryPath, ...patchParams } = entry
          return {
            path: entryPath,
            run: async () => {
              try {
                const targetPath = await resolveOnce(entryPath, patchParams.op !== 'create')
                return await runPatchEntry({
                  session,
                  path: targetPath,
                  entry: patchParams,
                  signal,
                  writethrough,
                  allowFuzzy,
                  fuzzyThreshold,
                  // apply_patch contract: `*** Add File` is strictly non-overwriting.
                })
              } catch (err) {
                failedFile = idx + 1
                throw err
              }
            },
          }
        })
        const result = await executeApplyPatchPerFile(perFile, undefined, cwd, signal)
        return toEditToolResult(
          result,
          entries.length,
          failedFile,
          failedFile !== undefined ? entries[failedFile - 1]?.path : undefined,
        )
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
      // A-8 后继：执行前与 replace/apply_patch 同款走 resolveEditPath 路径纠错
      // （refs tools/edit/index.ts:556-560 三模式统一；本模式恒 op:update，
      // mustExist 恒 true）。无近邻时原样返回，由引擎报 File not found。
      const targetPath = await resolveEditPath(session, filePath, { mustExist: true, signal })
      const result = await runPatchEntry({
        session,
        path: targetPath,
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
    // A-8：执行前统一 resolveEditPath（mustExist stat 失败后
    // findUniqueWorkspaceSuffix 工作区唯一后缀纠错）——上游 replace 模式语义。
    const targetPath = await resolveEditPath(session, filePath, { mustExist: true, signal })
    // A-7：多段编辑聚合改走上游 dispatch（executeSinglePathEntries），保留引擎
    // per-entry resultText 与聚合 diff；failedEntry 供末条目失败的指引补线。
    let failedEntry: number | undefined
    const runs = editsInput.map((edit, idx) => async () => {
      try {
        return await executeReplace({
          session,
          path: targetPath,
          params: { old_string: edit.oldText, new_string: edit.newText, replace_all: args.replace_all ?? false },
          signal,
          allowFuzzy,
          fuzzyThreshold,
          writethrough,
        })
      } catch (err) {
        failedEntry = idx + 1
        throw err
      }
    })
    const result = await executeSinglePathEntries(targetPath, runs, undefined, undefined, cwd, signal)
    return toEditToolResult(result, editsInput.length, failedEntry)
  } finally {
    // 引擎可能惰性新建了 ConflictHistory 等状态，写回共享存储供下次调用恢复。
    persistOmpSessionState(exec?.agent?.session, session)
  }
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
      // 完整执行链路见 executeEditTool（defineTool.execute 与单测共用）。
      return executeEditTool(exec, getConfig(), args, ctx)
    },
  }))
}
