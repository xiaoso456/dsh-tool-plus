/**
 * Real-environment smoke test for the ported OMP tools (read/write/edit).
 *
 * Loads the BUILT bundle (lib/index.mjs) with the real service stack
 * (same as tests/boot), then drives the tools through ctx.tools.execute
 * exactly like the harness does, in a throwaway temp cwd.
 *
 * Edit-mode coverage: replace (single + not-found), patch (unified diff),
 * hashline (PUT range / PUT >N insert / CUT / stale-tag rejection /
 * multi-section), apply_patch (Update File / Add File / Add-overwrite
 * rejection / Delete File / Move to / multi-file envelope).
 *
 * Run:  pnpm build && node scripts/smoke-tools.mjs
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import * as ToolPlus from '../lib/index.mjs'

const signal = new AbortController().signal
let callCounter = 0
const results = []
let failed = 0

function ok(name, cond, extra = '') {
  const pass = !!cond
  if (!pass) failed++
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

async function run(ctx, name, args, agent) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

function textOf(result) {
  const blocks = result.content ?? result
  return (blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '').toString()
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'tool-plus-smoke-'))
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(SessionStore),
    await ctx.plugin(LocalJobRegistry),
    await ctx.plugin(ToolTasks),
    await ctx.plugin(BashEnvPlugin),
    await ctx.plugin(LocalFileSystem, { cwd: work }),
    // hashline 模式专用驱动：read 输出 [path#TAG] 头 + edit hashline input 用例
    // 依赖 edit.mode=hashline。DSH 默认是 replace（plan.md 拍板#15，与 OMP 默认
    // hashline 不同）——默认 replace 的验证见真实 dsh 回归。
    await ctx.plugin(ToolPlus, { editMode: 'hashline' }),
  ]
  const agent = {
    id: 'smoke-session',
    ctx: ctx[Symbol.for('fiber')] ?? ctx,
    inject: () => {},
    session: { id: 'smoke-session', header: { version: 0, id: 'smoke-session', createdAt: Date.now(), cwd: work } },
  }
  ctx.agents.register(agent)

  // ── write ────────────────────────────────────────────────────────────────
  let r = await run(ctx, 'write', { path: 'a.txt', content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n' }, agent)
  ok('write 新建文件', !r.isError && existsSync(join(work, 'a.txt')), textOf(r).slice(0, 80))

  r = await run(ctx, 'write', { path: 'a.txt', content: 'v2-line1\nv2-line2\nv2-line3\nv2-line4\nv2-line5\nv2-line6\nv2-line7\nv2-line8\nv2-line9\nv2-line10\n' }, agent)
  ok('write 覆盖文件', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('v2-line1'))

  // ── read ─────────────────────────────────────────────────────────────────
  r = await run(ctx, 'read', { path: 'a.txt' }, agent)
  const t1 = textOf(r)
  ok('read 全文', !rError(r) && t1.includes('v2-line1') && t1.includes('v2-line10'))

  r = await run(ctx, 'read', { path: 'a.txt:5' }, agent)
  const t2 = textOf(r)
  // OMP: :N reads from line N with 1 leading context line, up to defaultLimit
  // rows → lines 4..10 here; lines 1-3 must be absent. (line regex, not
  // substring — 'v2-line10' contains 'v2-line1'.)
  const hasLine = (n) => new RegExp(`(^|\\n)\\d+:v2-line${n}(\\n|$)`).test(t2)
  ok('read :N 上下文窗口', !rError(r) && hasLine(5) && hasLine(4) && !hasLine(1) && !hasLine(3))

  r = await run(ctx, 'read', { path: 'a.txt:raw:5-5' }, agent)
  const t2b = textOf(r)
  ok('read :raw:N-N 精确单行', !rError(r) && t2b.includes('v2-line5') && !t2b.includes('v2-line4') && !t2b.includes('v2-line6'))

  r = await run(ctx, 'read', { path: 'a.txt:3-4' }, agent)
  const t3 = textOf(r)
  ok('read :N-M 区间', !rError(r) && t3.includes('v2-line3') && t3.includes('v2-line4'))

  r = await run(ctx, 'read', { path: 'a.txt:raw' }, agent)
  const t4 = textOf(r)
  ok('read :raw 原样', !rError(r) && t4.includes('v2-line1') && !/\d+: /.test(t4))

  r = await run(ctx, 'read', { path: 'a.txt:1-1,3-3' }, agent)
  const t5 = textOf(r)
  ok('read 多区间', !rError(r) && t5.includes('v2-line1') && t5.includes('v2-line3') && !t5.includes('v2-line2'))

  r = await run(ctx, 'read', { path: 'no-such-file.txt' }, agent)
  ok('read 不存在文件报错', rError(r) || textOf(r).includes('not found') || textOf(r).includes('No such'), textOf(r).slice(0, 60))

  r = await run(ctx, 'read', { path: '.' }, agent)
  ok('read 目录列表', !rError(r) && (textOf(r).includes('a.txt') || textOf(r).includes('📄')), textOf(r).slice(0, 60))

  // ── edit: replace ────────────────────────────────────────────────────────
  r = await run(ctx, 'edit', { file_path: 'a.txt', old_string: 'v2-line2', new_string: 'v2-line2-EDITED' }, agent)
  ok('edit replace', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('v2-line2-EDITED'))

  r = await run(ctx, 'edit', { file_path: 'a.txt', old_string: '不存在的内容', new_string: 'x' }, agent)
  ok('edit replace 未命中报错', rError(r) || textOf(r).toLowerCase().includes('not found') || textOf(r).includes('occurrence'), textOf(r).slice(0, 80))

  // ── edit: patch (unified diff) ───────────────────────────────────────────
  const patch = '--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n-v2-line1\n-v2-line2-EDITED\n+v2-line1-PATCHED\n+v2-line2-EDITED\n'
  r = await run(ctx, 'edit', { file_path: 'a.txt', patch }, agent)
  ok('edit patch unified diff', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('v2-line1-PATCHED'), textOf(r).slice(0, 80))

  // ── edit: hashline ───────────────────────────────────────────────────────
  // OMP model-visible flow: `read` mints the [path#TAG] snapshot header
  // (hashline display mode), then `edit {input}` anchors on that tag.
  const tagOf = (text, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = text.match(new RegExp(`\\[${escaped}#([0-9A-F]{4})\\]`))
    return m ? m[1] : null
  }

  r = await run(ctx, 'read', { path: 'a.txt' }, agent)
  let tag = tagOf(textOf(r), 'a.txt')
  ok('hashline read 输出 [path#TAG] 头', !!tag, textOf(r).slice(0, 40).replace(/\n/g, '\\n'))

  // PUT N.=M: replace inclusive lines 3-4
  r = await run(ctx, 'edit', { input: `[a.txt#${tag}]\nPUT 3.=4:\n+hl-line3\n+hl-line4\n` }, agent)
  const afterPut = readFileSync(join(work, 'a.txt'), 'utf8')
  ok('edit hashline PUT 区间替换', !rError(r) && afterPut.includes('hl-line3') && afterPut.includes('hl-line4') && !afterPut.includes('v2-line3'), textOf(r).slice(0, 80))

  // PUT >N: insert body rows after line 2 (pure addition)
  r = await run(ctx, 'read', { path: 'a.txt' }, agent)
  tag = tagOf(textOf(r), 'a.txt')
  r = await run(ctx, 'edit', { input: `[a.txt#${tag}]\nPUT >2:\n+hl-ins-a\n+hl-ins-b\n` }, agent)
  ok('edit hashline PUT >N 插入', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('hl-ins-a'), textOf(r).slice(0, 80))

  // CUT N.=M: delete line 5 (which is now hl-line3)
  r = await run(ctx, 'read', { path: 'a.txt' }, agent)
  tag = tagOf(textOf(r), 'a.txt')
  r = await run(ctx, 'edit', { input: `[a.txt#${tag}]\nCUT 5.=5\n` }, agent)
  const afterCut = readFileSync(join(work, 'a.txt'), 'utf8')
  ok('edit hashline CUT 删除行', !rError(r) && !afterCut.includes('hl-line3') && afterCut.includes('hl-line4'), textOf(r).slice(0, 80))

  // Stale tag → rejected (live content no longer hashes to the tag)
  r = await run(ctx, 'edit', { input: '[a.txt#0000]\nPUT 3.=3:\n+whatever\n' }, agent)
  ok('edit hashline 过期 tag 拒绝', rError(r) || /hash|stale|mismatch|snapshot/i.test(textOf(r)), textOf(r).slice(0, 100))

  // Multi-section: two files in one input, both preflighted then committed
  r = await run(ctx, 'write', { path: 'b.txt', content: 'b1\nb2\nb3\n' }, agent)
  ok('write b.txt 预备', !rError(r), textOf(r).slice(0, 60))
  r = await run(ctx, 'read', { path: 'a.txt' }, agent)
  const tagA = tagOf(textOf(r), 'a.txt')
  r = await run(ctx, 'read', { path: 'b.txt' }, agent)
  const tagB = tagOf(textOf(r), 'b.txt')
  r = await run(ctx, 'edit', { input: `[a.txt#${tagA}]\nPUT 1.=1:\n+a1-hl\n[b.txt#${tagB}]\nPUT 1.=1:\n+b1-hl\n` }, agent)
  ok('edit hashline 多节(两文件)', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('a1-hl') && readFileSync(join(work, 'b.txt'), 'utf8').includes('b1-hl'), textOf(r).slice(0, 120))

  // ── edit: apply_patch (Codex envelope) ───────────────────────────────────
  // *** Update File — unified diff hunk body
  const apUpdate = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@ -1,1 +1,1 @@',
    '-a1-hl',
    '+a1-ap',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apUpdate }, agent)
  ok('edit apply_patch Update File', !rError(r) && readFileSync(join(work, 'a.txt'), 'utf8').includes('a1-ap'), textOf(r).slice(0, 80))

  // *** Add File — strict non-overwriting create
  const apAdd = [
    '*** Begin Patch',
    '*** Add File: added.txt',
    '+hello from add',
    '+second line',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apAdd }, agent)
  ok('edit apply_patch Add File', !rError(r) && readFileSync(join(work, 'added.txt'), 'utf8').includes('hello from add'), textOf(r).slice(0, 80))

  // *** Add File over an existing file → rejected (apply_patch is strictly non-overwriting)
  const apAddOver = [
    '*** Begin Patch',
    '*** Add File: a.txt',
    '+clobber',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apAddOver }, agent)
  ok('edit apply_patch Add File 已存在拒绝', rError(r) || /already exists/i.test(textOf(r)), textOf(r).slice(0, 100))

  // *** Delete File
  const apDel = [
    '*** Begin Patch',
    '*** Delete File: added.txt',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apDel }, agent)
  ok('edit apply_patch Delete File', !rError(r) && !existsSync(join(work, 'added.txt')), textOf(r).slice(0, 80))

  // *** Update File + *** Move to — diff applies to source, result lands at dest
  const apMove = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '*** Move to: a-moved.txt',
    '@@ -1,1 +1,1 @@',
    '-a1-ap',
    '+a1-moved',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apMove }, agent)
  ok(
    'edit apply_patch Move to',
    !rError(r) &&
      existsSync(join(work, 'a-moved.txt')) &&
      !existsSync(join(work, 'a.txt')) &&
      readFileSync(join(work, 'a-moved.txt'), 'utf8').includes('a1-moved'),
    textOf(r).slice(0, 80),
  )

  // Multi-file envelope in one call (Add + Update)
  const apMulti = [
    '*** Begin Patch',
    '*** Add File: c.txt',
    '+c1',
    '*** Update File: b.txt',
    '@@ -1,1 +1,1 @@',
    '-b1-hl',
    '+b1-ap',
    '*** End Patch',
  ].join('\n')
  r = await run(ctx, 'edit', { input: apMulti }, agent)
  ok('edit apply_patch 多文件信封', !rError(r) && existsSync(join(work, 'c.txt')) && readFileSync(join(work, 'b.txt'), 'utf8').includes('b1-ap'), textOf(r).slice(0, 120))

  // ── archive write + read ─────────────────────────────────────────────────
  r = await run(ctx, 'write', { path: 'bundle.zip:inner.txt', content: 'zip member content\n' }, agent)
  ok('write 归档成员(从零建zip)', !rError(r), textOf(r).slice(0, 80))

  r = await run(ctx, 'read', { path: 'bundle.zip:inner.txt' }, agent)
  ok('read 归档成员', !rError(r) && textOf(r).includes('zip member content'), textOf(r).slice(0, 80))

  r = await run(ctx, 'read', { path: 'bundle.zip' }, agent)
  ok('read 归档根目录', !rError(r) && textOf(r).includes('inner.txt'), textOf(r).slice(0, 80))

  // ── sqlite write + read ──────────────────────────────────────────────────
  const { DatabaseSync } = await import('node:sqlite')
  const sdb = new DatabaseSync(join(work, 'db.sqlite'))
  sdb.exec('CREATE TABLE users (name TEXT, key TEXT)')
  sdb.close()
  r = await run(ctx, 'write', { path: 'db.sqlite:users', content: '{"name":"alice"}' }, agent)
  ok('write sqlite 行', !rError(r), textOf(r).slice(0, 80))
  r = await run(ctx, 'read', { path: 'db.sqlite:users' }, agent)
  ok('read sqlite 表', !rError(r) && textOf(r).includes('alice'), textOf(r).slice(0, 80))

  // ── grep ─────────────────────────────────────────────────────────────────
  writeFileSync(join(work, 'grepme.txt'), 'alpha one\nalpha two\nbeta one\nGAMMA\n')
  r = await run(ctx, 'grep', { pattern: 'alpha', path: 'grepme.txt' }, agent)
  const gt = textOf(r)
  ok('grep 匹配行(*N[:|]行)', !rError(r) && /\*\d+[:|]alpha one/.test(gt) && /\*\d+[:|]alpha two/.test(gt) && !/\*\d+[:|]beta/.test(gt), gt.slice(0, 100))

  r = await run(ctx, 'grep', { pattern: 'ALPHA', path: 'grepme.txt' }, agent)
  ok('grep 默认大小写敏感', !rError(r) && /No matches found/i.test(textOf(r)), textOf(r).slice(0, 80))

  r = await run(ctx, 'grep', { pattern: 'ALPHA', path: 'grepme.txt', case: false }, agent)
  ok('grep case:false 忽略大小写', !rError(r) && /alpha one/i.test(textOf(r)), textOf(r).slice(0, 80))

  r = await run(ctx, 'grep', { pattern: 'no-such-token-zzz', path: 'grepme.txt' }, agent)
  ok('grep 无匹配不报错', !rError(r), textOf(r).slice(0, 60))

  // ── glob ─────────────────────────────────────────────────────────────────
  r = await run(ctx, 'glob', { path: '*.txt' }, agent)
  ok('glob *.txt 匹配', !rError(r) && textOf(r).includes('grepme.txt'), textOf(r).slice(0, 100))

  r = await run(ctx, 'glob', { path: '*.nope' }, agent)
  ok('glob 无匹配不报错', !rError(r), textOf(r).slice(0, 60))

  // ── ast_edit（DSH resolve 通道：预览后真实落盘，plan.md 拍板#14） ───────
  writeFileSync(join(work, 'code.ts'), 'function oldName() {\n  return 1;\n}\noldName();\n')
  r = await run(ctx, 'ast_edit', { ops: [{ pat: 'oldName', out: 'newName' }], paths: ['code.ts'] }, agent)
  const at = textOf(r)
  const codeAfter = readFileSync(join(work, 'code.ts'), 'utf8')
  ok('ast_edit 落盘输出 Applied 报告', !rError(r) && /Applied \d+ replacement/.test(at), at.slice(0, 140))
  ok('ast_edit 真实落盘(newName 替换 oldName)', codeAfter.includes('newName') && !codeAfter.includes('oldName'), codeAfter.slice(0, 60))

  // ── ast_grep（AST 只读查询） ────────────────────────────────────────────
  r = await run(ctx, 'ast_grep', { pat: 'newName', path: 'code.ts' }, agent)
  const agt = textOf(r)
  ok('ast_grep 查询落盘后的 AST 匹配', !rError(r) && /newName/.test(agt), agt.slice(0, 140))
  ok('ast_grep 只读不修改文件', readFileSync(join(work, 'code.ts'), 'utf8').includes('newName') && !readFileSync(join(work, 'code.ts'), 'utf8').includes('oldName'))

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const f of fibers.reverse()) await f.dispose()
  rmSync(work, { recursive: true, force: true })

  console.log('\n===== SMOKE RESULTS =====')
  for (const line of results) console.log(line)
  console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
  process.exit(failed === 0 ? 0 : 1)
}

function rError(r) {
  return r?.isError === true
}

main().catch(err => {
  console.error('SMOKE CRASHED:', err)
  process.exit(1)
})
