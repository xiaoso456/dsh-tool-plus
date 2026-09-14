/**
 * `edit` 卡片的宿主投影与适配层接线（计划 §4.2）。
 *
 * meta = `{ kind:'edit', diffs:[{path, oldText, newText}] }`，数据全部来自引擎
 * 已经算好的 `details.diff` / `details.perFileResults[].diff`（零额外 I/O）。
 * 覆盖四种 edit 模式（replace 单段 / 多段、patch、apply_patch 多文件、
 * hashline）的 path 集合、截断（128 KiB，丢尾部文件，全丢光不产 meta）与
 * "编辑失败/空 diff 不产 meta"。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeEditTool, registerEdit } from '../../src/tools/edit/adapter/index.ts'
import { EDIT_META_MAX_BYTES, jsonByteLength, narrowEditCardMeta } from '../../src/web/contract.ts'
import { projectEditCardMeta } from '../../src/web/host/edit.ts'
import { canonicalSnapshotKey, getFileSnapshotStore } from '../../src/tools/omp/edit/file-snapshot-store.ts'
import { persistOmpSessionState } from '../../src/tools/shared/session-state.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-card-meta-')))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string, session?: object): any {
  return { agent: { session: session ?? { header: { cwd } } }, signal: undefined }
}

/** Exec whose session key already carries a hashline snapshot for `file`. */
function hashlineExec(cwd: string, file: string, seenLines: number[]): { exec: any; tag: string } {
  const sessionKey: any = { header: { cwd } }
  const seed: any = { cwd, hasEditTool: true }
  const tag = getFileSnapshotStore(seed).recordSnapshotFile(canonicalSnapshotKey(file), seenLines)
  if (!tag) throw new Error('could not mint hashline tag')
  persistOmpSessionState(sessionKey, seed)
  return { exec: execFor(cwd, sessionKey), tag }
}

/** Tool definition `registerEdit` hands to the host registry. */
function captureDefinition(): any {
  let definition: any
  registerEdit(
    { tools: { register: (value: any) => { definition = value; return () => {} } } } as never,
    (() => ({})) as never,
  )
  return definition
}

function pathSet(out: { diffs?: { path: string }[] }): string[] {
  return [...new Set((out.diffs ?? []).map(hunk => path.basename(hunk.path)))].sort()
}

/** A numbered diff whose single hunk is roughly `bytes` long. */
function bigNumberedDiff(bytes: number): string {
  const rows: string[] = []
  let total = 0
  let line = 1
  while (total < bytes) {
    rows.push(`+${line}|${'x'.repeat(200)}`)
    total += 203
    line += 1
  }
  return rows.join('\n')
}

describe('edit 卡片投影：契约形状', () => {
  it('单文件：path + oldText/newText（删行+上下文 / 增行+上下文）', () => {
    const meta = projectEditCardMeta({
      path: '/w/a.ts',
      diff: ' 1|alpha\n-2|beta\n+2|BETA\n 3|gamma',
    })
    expect(meta).toEqual({
      kind: 'edit',
      diffs: [{ path: '/w/a.ts', oldText: 'alpha\nbeta\ngamma', newText: 'alpha\nBETA\ngamma' }],
    })
    expect(narrowEditCardMeta(meta)).not.toBeNull()
  })

  it('多文件：遍历 perFileResults，每个文件一条（多段则多条）', () => {
    const meta = projectEditCardMeta({
      diff: 'ignored-multi-file-join',
      perFileResults: [
        { path: '/w/a.ts', diff: ' 1|alpha\n-2|beta\n+2|BETA' },
        { path: '/w/b.ts', diff: '-1|one\n+1|ONE' },
      ],
    })
    expect(meta?.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(meta?.diffs[1]).toEqual({ path: '/w/b.ts', oldText: 'one', newText: 'ONE' })
  })

  it('纯新增：oldText 为 null', () => {
    const meta = projectEditCardMeta({ path: '/w/new.ts', diff: '+1|const a = 1\n+2|const b = 2' })
    expect(meta?.diffs[0]).toEqual({
      path: '/w/new.ts',
      oldText: null,
      newText: 'const a = 1\nconst b = 2',
    })
    expect(narrowEditCardMeta(meta)).not.toBeNull()
  })

  it('move（重命名）：只记目标为新建（oldText:null），源侧不记', () => {
    const meta = projectEditCardMeta({
      path: '/w/moved.ts',
      move: '/w/moved.ts',
      sourcePath: '/w/original.ts',
      diff: ' 1|alpha\n-2|beta\n+2|BETA',
    })
    expect(meta?.diffs).toEqual([
      { path: '/w/moved.ts', oldText: null, newText: 'alpha\nBETA' },
    ])
  })

  it('没有 diff / diff 为空 / 解不出 hunk → null', () => {
    expect(projectEditCardMeta({ path: '/w/a.ts' })).toBeNull()
    expect(projectEditCardMeta({ path: '/w/a.ts', diff: '' })).toBeNull()
    expect(projectEditCardMeta({ path: '/w/a.ts', diff: 'not a diff' })).toBeNull()
    expect(projectEditCardMeta({ diff: ' 1|alpha\n-2|beta\n+2|BETA' })).toBeNull()
    expect(projectEditCardMeta({ path: '/w/a.ts', perFileResults: [] })).toBeNull()
    expect(projectEditCardMeta({})).toBeNull()
  })

  it('畸形输入不抛异常，也不产 undefined 值', () => {
    for (const bad of [42, 'x', [], () => {}, { perFileResults: 'nope' }, { path: 1, diff: 2 }]) {
      expect(() => projectEditCardMeta(bad as never)).not.toThrow()
    }
    const meta = projectEditCardMeta({
      perFileResults: [
        { path: '/w/a.ts', diff: ' 1|alpha\n-2|beta\n+2|BETA' },
        { path: '', diff: ' 1|x' },
        { path: '/w/c.ts', diff: '' },
      ],
    })
    expect(meta?.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts'])
    expect(JSON.stringify(meta)).not.toContain('undefined')
  })
})

describe('edit 卡片投影：128 KiB 上限', () => {
  it('丢尾部文件：两条 70 KiB 只留第一条', () => {
    const meta = projectEditCardMeta({
      perFileResults: [
        { path: '/w/a.ts', diff: bigNumberedDiff(70 * 1024) },
        { path: '/w/b.ts', diff: bigNumberedDiff(70 * 1024) },
        { path: '/w/c.ts', diff: bigNumberedDiff(70 * 1024) },
      ],
    })
    expect(meta).not.toBeNull()
    expect(meta!.diffs.map(hunk => hunk.path)).toEqual(['/w/a.ts'])
    expect(jsonByteLength(meta)).toBeLessThanOrEqual(EDIT_META_MAX_BYTES)
    expect(narrowEditCardMeta(meta)).not.toBeNull()
  })

  it('全丢光则不产 meta（单条就超限）', () => {
    const meta = projectEditCardMeta({
      perFileResults: [{ path: '/w/a.ts', diff: bigNumberedDiff(200 * 1024) }],
    })
    expect(meta).toBeNull()
  })
})

describe('edit 适配层接线：四种模式', () => {
  it('replace 单段：diffs path 集合 = 目标文件，文本/内容可读', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const out = await executeEditTool(
      execFor(dir),
      {} as never,
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      null,
    )
    expect(pathSet(out)).toEqual(['a.ts'])
    expect(out.diffs![0].oldText).toBe('alpha\nbeta\ngamma')
    expect(out.diffs![0].newText).toBe('alpha\nBETA\ngamma')
    expect(out.text).toMatch(/^Successfully replaced text in .+\.$/)
  })

  it('replace 多段：diffs path 集合 = 目标文件', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const out = await executeEditTool(
      execFor(dir),
      {} as never,
      {
        file_path: file,
        edits: [
          { oldText: 'alpha', newText: 'ALPHA' },
          { oldText: 'gamma', newText: 'GAMMA' },
        ],
      },
      null,
    )
    expect(pathSet(out)).toEqual(['a.ts'])
    const newText = out.diffs!.map(hunk => hunk.newText).join('\n')
    expect(newText).toContain('ALPHA')
    expect(newText).toContain('GAMMA')
  })

  it('patch：diffs path 集合 = 目标文件', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const out = await executeEditTool(
      execFor(dir),
      {} as never,
      { file_path: file, patch: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma' },
      null,
    )
    expect(pathSet(out)).toEqual(['a.ts'])
    expect(out.diffs!.map(hunk => hunk.oldText).join('\n')).toContain('beta')
    expect(out.diffs!.map(hunk => hunk.newText).join('\n')).toContain('BETA')
  })

  it('apply_patch 多文件：diffs path 集合 = 两个文件', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'alpha\n')
    fs.writeFileSync(path.join(dir, 'b.ts'), 'beta\n')

    const out = await executeEditTool(
      execFor(dir),
      {} as never,
      {
        input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-alpha\n+ALPHA\n*** Update File: b.ts\n@@\n-beta\n+BETA\n*** End Patch',
      },
      null,
    )
    expect(pathSet(out)).toEqual(['a.ts', 'b.ts'])
  })

  it('hashline：diffs path 集合 = 目标文件', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const { exec, tag } = hashlineExec(dir, file, [1, 2, 3])
    const out = await executeEditTool(
      exec,
      {} as never,
      { input: `[a.ts#${tag}]\nPUT 2-2:\n+const b = 2;` },
      null,
    )
    expect(pathSet(out)).toEqual(['a.ts'])
    expect(out.diffs!.map(hunk => hunk.newText).join('\n')).toContain('const b = 2;')
  })

  it('回归：失败文案一字未变（缺 file_path）', async () => {
    const dir = tmpDir()
    await expect(
      executeEditTool(execFor(dir), {} as never, { old_string: 'a', new_string: 'b' }, null),
    ).rejects.toThrow('file_path must be a non-empty string')
  })

  it('presentationMeta：有 diffs 才产 meta，没有就走兜底（null）', () => {
    const definition = captureDefinition()
    expect(definition.output.schema.properties).toHaveProperty('diffs')
    expect(definition.output.render({}, { text: 'ok' })).toEqual([{ type: 'text', text: 'ok' }])

    const diffs = [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }]
    expect(definition.output.presentationMeta({}, { text: 'ok', diffs })).toEqual({ kind: 'edit', diffs })
    expect(definition.output.presentationMeta({}, { text: 'ok' })).toBeNull()
    expect(definition.output.presentationMeta({}, { text: 'ok', diffs: [] })).toBeNull()
  })
})
