/**
 * 端到端驱动（headless 版）：假供应商按场景驱动真 dsh 把插件 8 个工具跑一遍，跑完硬断言。
 *
 * 断言从**假供应商侧收到的请求记录**里取——那是宿主真实发出的东西，比解析 dsh 的 stdout 可靠：
 * 每一步的工具结果都在下一次请求的 `role: "tool"` 消息里。
 *
 * 用法：`pnpm e2e`（`DSH_BIN` 覆盖 dsh 命令，`E2E_TIMEOUT_MS` 覆盖超时）。
 * 需要 GUI 截图的同一套场景见 `capture-web.ts`（`pnpm e2e:web`）。
 *
 * 前置：全局装了 dsh；本仓库已 `pnpm build`——profile 是指向仓库根的 junction，宿主直接加载 `lib/`。
 *
 * @module tests/support/harness
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadScenarioFile, startMockOpenAI } from '../mock-openai/index.ts'
import {
  FIXTURE,
  mockProfilePatch,
  prepareProfile,
  resetScratch,
  runDsh,
  SCENARIO_PATH,
  SCENARIO_TOKENS,
  firstLine,
  TASK_MARKER,
  TOOL_NAMES,
} from './support.ts'

const PROFILE = 'tool-plus-e2e'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? '300000')

/**
 * 每一步的期望：`turn` 是场景里的轮次名，`expect` 是**工具结果里必须出现**的东西。
 * 断言的是效果（文件真被写了、真被改了），不是工具的措辞。
 */
const EXPECTATIONS: ReadonlyArray<{ turn: string; tool: string; expect?: RegExp }> = [
  { turn: '01-bash', tool: 'bash', expect: /MOCK_E2E_BASH_OK/ },
  { turn: '02-write', tool: 'write' },
  { turn: '03-read', tool: 'read', expect: /GREETING/ },
  { turn: '04-edit', tool: 'edit' },
  { turn: '05-read-after-edit', tool: 'read', expect: /'HELLO'/ },
  { turn: '06-grep', tool: 'grep', expect: /GREETING/ },
  { turn: '07-glob', tool: 'glob', expect: /fixture\.ts/ },
  { turn: '08-ast-grep', tool: 'ast_grep', expect: /greet/ },
  { turn: '09-ast-edit', tool: 'ast_edit' },
  { turn: '10-read-after-ast-edit', tool: 'read', expect: /name \+ GREETING/ },
  { turn: '11-final', tool: '(final)' },
]

interface ChatBody {
  messages?: Array<{ role?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string }; name?: string }>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : '')).join('')
  }
  return ''
}

/** 一次请求里已经回灌的工具结果（按序）。 */
function toolResultsOf(body: unknown): string[] {
  const messages = (body as ChatBody).messages ?? []
  return messages.filter((message) => message.role === 'tool').map((message) => textOf(message.content))
}

/** 会话暴露给模型的工具名。 */
function toolNamesOf(body: unknown): string[] {
  return ((body as ChatBody).tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name)
    .filter((name): name is string => typeof name === 'string')
}

async function main(): Promise<void> {
  resetScratch()
  const scenario = loadScenarioFile(SCENARIO_PATH, { tokens: SCENARIO_TOKENS })
  const mock = await startMockOpenAI({
    scenario,
    log: (line) => { process.stdout.write(`[e2e] ${line}\n`) },
  })
  const profileDir = prepareProfile(
    PROFILE,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@xiaoso/dsh-tool-plus'],
    mockProfilePatch(mock.url),
  )
  process.stdout.write(`[e2e] mock ${mock.url} scenario=${scenario.name} turns=${String(scenario.turns.length)}\n`)
  process.stdout.write(`[e2e] profile ${profileDir}\n[e2e] scratch ${path.dirname(FIXTURE)}\n\n`)

  const run = await runDsh(PROFILE, TASK_MARKER, TIMEOUT_MS)
  await mock.close()

  // 只留主对话的轮次：会话标题请求走 `00-title`，兜底走 `unexpected-extra-request`。
  const protocol = mock.requests.filter((row) =>
    row.turn !== undefined && row.turn !== 'unexpected-extra-request' && row.turn !== '00-title')
  const turns = protocol.map((row) => row.turn)
  const checks: Array<[string, boolean, string]> = [
    ['dsh 退出码为 0', run.code === 0, `exit=${String(run.code)}${run.timedOut ? ' (timed out)' : ''}`],
    [`场景跑完 ${String(EXPECTATIONS.length)} 轮`, turns.length === EXPECTATIONS.length, `实际 ${turns.length} 轮：${turns.join(' → ')}`],
    ['脚本没有被耗尽', !turns.includes('script_exhausted'), turns.join(' → ')],
  ]

  const firstTools = toolNamesOf(protocol[0]?.body)
  checks.push(['工具面由本插件接管（有 bash，无 pwsh）', firstTools.includes('bash') && !firstTools.includes('pwsh'), firstTools.join(', ')])
  checks.push([`${String(TOOL_NAMES.length)} 个工具全部注册`, TOOL_NAMES.every((name) => firstTools.includes(name)), firstTools.join(', ')])

  for (const [index, expectation] of EXPECTATIONS.entries()) {
    const next = protocol[index + 1]
    const results = next === undefined ? [] : toolResultsOf(next.body)
    const result = results.at(-1)
    checks.push([
      `步骤 ${String(index + 1)} ${expectation.tool}`,
      turns[index] === expectation.turn,
      `期望轮次 ${expectation.turn}，实际 ${String(turns[index])}`,
    ])
    if (expectation.expect !== undefined) {
      checks.push([
        '        结果符合预期',
        expectation.expect.test(result ?? ''),
        firstLine(result),
      ])
    }
  }

  const finalState = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : ''
  checks.push([
    '夹具最终态符合预期（磁盘独立核验）',
    /'HELLO'/.test(finalState) && /name \+ GREETING/.test(finalState),
    finalState.replace(/\n/g, ' ⏎ '),
  ])

  let failed = 0
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1
    process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${name}\n`)
    if (!ok) process.stdout.write(`        期望/实际：${detail}\n`)
  }

  if (failed > 0) {
    process.stdout.write('\n[e2e] 每轮拿到的最后一个工具结果：\n')
    protocol.forEach((row, index) => {
      const results = toolResultsOf(row.body)
      process.stdout.write(`  ${String(index + 1)} ${String(row.turn)} → ${firstLine(results.at(-1))}\n`)
    })
    process.stdout.write(`\n[e2e] dsh stderr:\n${run.stderr}\n[e2e] dsh stdout 尾部:\n${run.stdout.slice(-4000)}\n`)
  } else {
    process.stdout.write(`\n[e2e] ${String(checks.length)} 项全过：假供应商 → dsh → 本插件 8 个工具 → 结果回灌，闭环成立。\n`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

await main()
