/**
 * DSH edit tool — adapter that wires the verbatim OMP edit engine
 * (`src/tools/omp/edit/`) into DSH's `defineTool` contract.
 *
 * This file is pure glue. All edit logic lives in `omp/` (copied verbatim);
 * this adapter only:
 *  - builds an OMP `ToolSession` from the DSH exec context + tool-plus config,
 *  - exposes only the configured mode's parameter table (replace / patch /
 *    hashline / apply_patch) and still dispatches execution by call shape,
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
import { readEditFileText } from '../../omp/edit/read-file.ts'
import { normalizeToLF, stripBom } from '../../omp/edit/normalize.ts'
import { executeHashlineSingle } from '../../omp/edit/hashline/execute.ts'
import { expandApplyPatchToEntries } from '../../omp/edit/modes/apply-patch.ts'
import { executeApplyPatchPerFile, executeSinglePathEntries, resolveEditPath } from '../../omp/edit/dispatch.ts'
import { writethroughNoop } from '../../omp/tools/writethrough.ts'
import { formatPreflightError, preflightReplaceEntries } from './preflight.ts'
import { withClosestMatch } from './match-error.ts'
import { resolvePlanPath } from './tools/plan-mode-guard.ts'
import { attachOmpSessionState, persistOmpSessionState } from '../../shared/session-state.ts'
// Web 卡片投影（plan web-tool-cards §4.2）：只搬引擎已算好的 diff，不重新采样。
import { projectEditCardMeta } from '../../../web/host/edit.ts'
import type { CardDiffHunk } from '../../../web/contract.ts'
import type { RuntimeConfig } from '../../../config/settings.ts'
import {
  renderOmpPrompt,
  sanitizeApplyPatchPrompt,
  sanitizeHashlinePrompt,
  sanitizePatchPrompt,
  sanitizeReplacePrompt,
} from '../../shared/omp-prompt.ts'
import { createWriteChannel } from '../../shared/write-channel.ts'
import patchMd from './prompts/tools/patch.md' with { type: 'text' }
import applyPatchMd from './prompts/tools/apply-patch.md' with { type: 'text' }
import replaceMd from './prompts/tools/replace.md' with { type: 'text' }
// hashline 的描述与上游 Rust 引擎同源：native `editDescription('hashline')` 与
// 原 `hashline/engine/prompt.md` 逐字节相同（CRLF 归一后），因此不再 vendored md。
import { editDescription } from '../../hashline/native/index.ts'

/** OMP 原版按模式渲染的 edit 描述（prompts/tools/*.md verbatim + native hashline 描述）。 */
export const EDIT_MODE_DESCRIPTIONS = {
  replace: renderOmpPrompt(sanitizeReplacePrompt(replaceMd), {}),
  // 2026-11-22 A 方案反转：patch 模型面就是 OMP 的 `{ path, edits }`，所以提示词
  // 逐字渲染，不再改写 <parameters> 块（原先那段改写函数已删除）。
  patch: renderOmpPrompt(sanitizePatchPrompt(patchMd), {}),
  apply_patch: renderOmpPrompt(sanitizeApplyPatchPrompt(applyPatchMd), {}),
  hashline: renderOmpPrompt(sanitizeHashlinePrompt(editDescription('hashline')), {}),
} as const

type EditModeName = keyof typeof EDIT_MODE_DESCRIPTIONS

/**
 * 每种模式只暴露自己那一套参数（A 方案，2026-11-21；2026-11-22 反转 patch 部分）：
 * required 跟着模式走。patch 与 OMP 18.12.6 一致，收 `{ path, edits: Entry[] }`，
 * 不再有 `patch: string` 这条内部别名（用户拍板按 A 对齐）。
 */
function editParametersForMode(mode: EditModeName): Record<string, any> {
  if (mode === 'patch') {
    return {
      path: { type: 'string', required: true, description: 'Path to the file to edit; applies to every entry.' },
      edits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: ['update', 'create', 'delete'], description: 'Operation; defaults to update.' },
            rename: { type: 'string', description: 'New path for update (moves the file).' },
            diff: { type: 'string', description: 'Unified hunks for update; full file content for create; omitted for delete.' },
          },
        },
        description: 'One or more edits applied to the path, in order.',
      },
    }
  }
  if (mode === 'replace') {
    return {
      path: { type: 'string', required: true, description: 'Path to the file to edit' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace; must appear exactly once unless replace_all is true' },
      new_string: { type: 'string', required: true, description: 'Replacement text; pass an empty string to delete' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring exactly one' },
    }
  }
  if (mode === 'apply_patch') {
    return {
      input: { type: 'string', required: true, description: 'Codex *** Begin Patch envelope' },
    }
  }
  return {
    input: { type: 'string', required: true, description: 'Hashline patch input' },
  }
}

/** Build the OMP ToolSession facade over a DSH exec context. */
function createToolSession(exec: any, cfg: RuntimeConfig): ToolSession {
  const cwd: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const settings = new Settings(cfg, getDefault)
  const session: ToolSession = { cwd, settings, hasEditTool: true }
  // 恢复本 DSH session 上次调用保存的 OMP 引擎状态（冲突注册表等，T11-2）。
  attachOmpSessionState(session, exec?.agent?.session)
  return session
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
 * `edits` 这个参数名被两种模式共用：replace 的条目是 `{oldText, newText}`，patch 的
 * 条目是 `{op?, rename?, diff?}`。两种模式不会同时暴露参数表，但执行层靠形状分派
 * （registerEdit 的 A 方案），所以这里按「有没有 replace 的字段」判别。
 */
function entriesLookLikeReplace(entries: readonly any[]): boolean {
  return entries.some((entry: any) => entry !== null && typeof entry === 'object' && ('oldText' in entry || 'newText' in entry))
}

/** DSH edit 工具输出形状（output.schema 镜像）。 */
export interface EditToolOutput {
  text: string
  /** 卡片用 diff（已按 EDIT_META_MAX_BYTES 截断；空/不可解析时不带该键）。 */
  diffs?: CardDiffHunk[]
}

/**
 * 把成功结果带上卡片投影（纯展示用；投影不抛异常，null → 不产 meta）。
 * 错误路径不经此函数，保证报错文案一字不变。
 */
function withEditCard(result: AgentToolResult<any>, text: string): EditToolOutput {
  const diffs = projectEditCardMeta(result.details)?.diffs
  return diffs === undefined ? { text } : { text, diffs }
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
  return withEditCard(result, text)
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
  // 写通道由实验项 writeBackend 选择：默认 DSH 原子写（方案A），可切 OMP 原生直写。
  const writethrough = ctx ? createWriteChannel(ctx, exec, cfg) : writethroughNoop
  const cwd = session.cwd
  const signal = exec?.signal
  // fuzzy 配置补线：面板 edit.fuzzyMatch/edit.fuzzyThreshold 经 Settings 门面
  // （OMP_KEY_TO_FIELD）直达引擎，替代原硬编码 true/0.95。S-13：显式 0/负值
  // 原样放行（0 = 接受任意置信度的最佳匹配），仅 undefined/非数值回退引擎
  // 默认 0.95；env 层（上游 PI_EDIT_FUZZY*）有意不移植。
  const allowFuzzy = session.settings.get('edit.fuzzyMatch') !== false
  const fuzzyThreshold = resolveFuzzyThreshold(session.settings.get('edit.fuzzyThreshold'))

  try {
    // hashline / apply_patch mode
    // (OMP-faithful: these modes carry their paths inside `input` — the
    // `[PATH#TAG]` section headers / `*** <File|Move>:` envelope markers —
    // so no top-level path is required.)
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
      return withEditCard(result, toText(result))
    }

    // `path` is the model-facing name (OMP); `file_path` stays as a legacy
    // alias so old direct/PTC calls keep the current precedence.
    const filePath: string = args.file_path ?? args.path ?? ''
    if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('path (or file_path) must be a non-empty string')
    }

    // patch mode (OMP 18.12.6 shape: { path, edits: [{ op?, rename?, diff? }] })
    //
    // 2026-11-22 反转 A 方案：`patch: string` 这条内部别名一并删除（用户拍板按 A 对齐）。
    // 条目形状与 apply_patch 共用同一个引擎入口（executePatchSingle），差别只在信封。
    const patchEntries: any[] | undefined =
      Array.isArray(args.edits) && args.edits.length > 0 && !entriesLookLikeReplace(args.edits)
        ? args.edits
        : undefined
    if (patchEntries !== undefined) {
      // 上游 patch 模式是「单文件 + 多条目」：`path` 对所有条目生效。
      //
      // mustExist 按条目语义分流：`op: create` 是建新文件，绝不能走「唯一后缀纠错」
      // （否则会把 dir/new.txt 纠到别的目录同名文件上）；update/delete 必须存在，
      // 因此保留与 replace 同款的工作区后缀纠错（A-8）。混合调用按「需要存在」处理，
      // 由引擎报出准确原因。
      const allCreate = patchEntries.every((e: any) => (e?.op ?? 'update') === 'create')
      const targetPath = await resolveEditPath(session, filePath, { mustExist: !allCreate, signal })
      const runs = patchEntries.map((entry: any) => async () =>
        runPatchEntry({
          session,
          path: targetPath,
          entry,
          signal,
          writethrough,
          allowFuzzy,
          fuzzyThreshold,
          // JSON patch 的 `op: "create"` 是文档化的整文件覆盖（与 apply_patch 的
          // `*** Add File` 严格不覆盖刻意不同）。
          allowCreateOverwrite: true,
        }),
      )
      const result = await executeSinglePathEntries(targetPath, runs, undefined, undefined, cwd, signal)
      return toEditToolResult(result, patchEntries.length, undefined)
    }

    // replace mode (single or internal multi-segment)
    // `edits` 在 replace 模式是内部批量路径（模型面只暴露 old_string/new_string）；
    // 单条路径必须显式给出 new_string，缺失时不能当成空串删除。
    const hasEdits = Array.isArray(args.edits) && args.edits.length > 0
    if (hasEdits) {
      // 走到这里说明条目带 oldText/newText（patch 形状在上面已被形状分派拦走），
      // 所以下面按 replace 语义校验；混合形状会落到逐条的字段缺失报错上。
      // 内部批量路径同样不能把缺失的 newText 当成空串删除。
      for (const [idx, entry] of args.edits.entries()) {
        if (typeof entry?.oldText !== 'string' || typeof entry?.newText !== 'string') {
          throw new Error(`edit: edits[${idx}] requires string oldText and newText; pass "" to delete.`)
        }
      }
    }
    if (!hasEdits && typeof args.old_string === 'string' && typeof args.new_string !== 'string') {
      throw new Error('edit: new_string is required when old_string is provided; pass "" to delete.')
    }
    const editsInput: { oldText: string; newText: string }[] = hasEdits
      ? args.edits
      : typeof args.old_string === 'string'
        ? [{ oldText: args.old_string, newText: args.new_string }]
        : []
    if (editsInput.length === 0) {
      throw new Error('edit: provide old_string/new_string, patch, or input')
    }
    // A-8：执行前统一 resolveEditPath（mustExist stat 失败后
    // findUniqueWorkspaceSuffix 工作区唯一后缀纠错）——上游 replace 模式语义。
    const targetPath = await resolveEditPath(session, filePath, { mustExist: true, signal })
    // 实验性：多条目预检（设置页「实验性」tab 的 multiEditPreflight，默认关闭）。
    // 关闭时这一块不存在，行为与上游逐条应用逐条写盘完全一致。
    if (cfg.multiEditPreflight && editsInput.length > 1) {
      // 与 executeReplace 同口径：先把调用方路径解析成绝对路径再读，否则相对路径
      // 会按进程 cwd 解析，读错文件或直接 File not found。
      const absolutePath = resolvePlanPath(session, targetPath)
      const { text } = stripBom(await readEditFileText(absolutePath, filePath))
      const preflight = preflightReplaceEntries(normalizeToLF(text), editsInput, {
        allowFuzzy,
        threshold: fuzzyThreshold,
        replaceAll: args.replace_all ?? false,
      })
      if (preflight.failures.length > 0) {
        throw new Error(formatPreflightError(filePath, editsInput.length, preflight.failures))
      }
    }
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
        // 实验性：详细匹配失败提示（detailedMatchFailure，默认开启）。
        // 只往报错消息里补 closest 块，不改成功/失败语义。
        throw cfg.detailedMatchFailure ? withClosestMatch(err) : err
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
 * Register the edit tool. The exposed parameter table follows `editMode`
 * (A 方案，patch 于 2026-11-22 起与 OMP 一致收 `{path, edits}`); execution
 * dispatches by argument shape:
 *  - `input` present → hashline, or apply_patch when it starts with `***`
 *  - `edits` with patch fields (`op`/`diff`/`rename`) → patch mode
 *  - `edits` with `oldText`/`newText`, or `old_string` → replace mode
 */
export function registerEdit(ctx: Context, getConfig: () => RuntimeConfig): () => void {
  // 返回 disposer：editMode 热更新时重注册，同时刷新描述和参数表（见 src/index.ts）。
  const editMode = (getConfig().editMode ?? 'replace') as EditModeName
  return ctx.tools.register(defineTool({
    name: 'edit',
    // "是什么模式，就给什么描述"（用户拍板 2026-08-25）：按配置 editMode
    // 选 OMP 原版模式提示词（replace/patch/apply_patch/hashline 四份 md）。
    // DSH 描述和参数表都是静态的，配置变更由 index.ts 重注册刷新。
    description: EDIT_MODE_DESCRIPTIONS[editMode] ?? EDIT_MODE_DESCRIPTIONS.replace,
    parameters: editParametersForMode(editMode),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                newText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value.text ?? '') }],
      // 只有跑成功的顶层调用才到这里；没有 diffs → 不产 meta（null，客户端走兜底）。
      // 不能返回 undefined：宿主对 undefined 判 non-lossless JSON 并改写成 isError。
      presentationMeta: (_args: any, value: any) =>
        (Array.isArray(value?.diffs) && value.diffs.length > 0
          ? { kind: 'edit', diffs: value.diffs }
          : null) as any,
    },
    async execute(args: any, exec: any) {
      // 完整执行链路见 executeEditTool（defineTool.execute 与单测共用）。
      return executeEditTool(exec, getConfig(), args, ctx)
    },
  }))
}
