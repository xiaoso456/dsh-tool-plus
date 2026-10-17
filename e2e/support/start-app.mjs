/**
 * e2e 启动接线：把「假 LLM 供应商 + 隔离的测试 profile + dsh web」包成一个前台进程，
 * 由 e2e 框架的 `app.command` 拉起（见 `e2e/e2e.config.ts` 的 `executable: 'node'`）。
 *
 * 用法（框架传进来的 cwd 就是 `e2e/`）：
 *   node --experimental-transform-types support/start-app.mjs --port <端口>
 * `--port 0` 表示由系统分配空闲端口。
 *
 * 为什么不是「一条命令就够」：被测对象是外部的 dsh CLI，不是本仓库的 dev server。
 * 它要三样东西才起得来——一个指向假供应商的测试 profile、一个隔离的 harness home、
 * 一个进程级随机的启动令牌；这些都在这里准备好。
 *
 * `--experimental-transform-types` 是为了能直接 import 仓库里已有的两个 TS 套件
 * （`tests/support/harness/support.ts`、`tests/support/mock-openai/`），避免把它们的
 * 逻辑再抄一份——Node 22 默认的 strip-only 模式不支持它们用的参数属性语法。
 *
 * @module e2e/support/start-app
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const USAGE = [
  '用法: node --experimental-transform-types support/start-app.mjs --port <端口>',
  '',
  '  起一个隔离的 dsh web 测试实例，并把带启动令牌的地址发布到运行时文件。',
  '',
  '  --port <端口>  必填；0 表示由系统分配一个空闲端口。',
  '  -h, --help     显示这段说明。',
].join('\n')

function fail(message) {
  process.stderr.write(`start-app: ${message}\n\n${USAGE}\n`)
  process.exit(2)
}

/** 只认 --port：多余的参数一律报错并附用法，免得把拼错的参数当成「默认行为」静默吞掉。 */
function parseArgs(argv) {
  let port
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    }
    if (arg === '--port') {
      const raw = argv[index + 1]
      if (raw === undefined) fail('--port 需要一个值')
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) fail(`--port 非法：${String(raw)}`)
      port = parsed
      index += 1
      continue
    }
    fail(`未知参数：${String(arg)}`)
  }
  if (port === undefined) fail('缺少 --port')
  return { port }
}

/**
 * 运行时目录放系统临时区（仓库里既有的 e2e 驱动同样这么做）：进程号、随机令牌、
 * 隔离 home 都在这里，不该让它出现在工作区里被误当成源码。
 */
const RUNTIME_ROOT = path.join(os.tmpdir(), 'dsh-tool-plus-e2e')
/**
 * 隔离的 harness home。dsh 的会话、凭据、agent 预设、插件清单都落在各自的 harness home 下，
 * 指到这里就不会读也不会写开发者 `~/.dsh` 里的这些东西。
 */
const E2E_HOME = path.join(RUNTIME_ROOT, 'home')
const PROFILE = 'tool-plus-e2e-web'
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xiaoso/dsh-tool-plus']
const SCENARIO_PATH = path.join(REPO_ROOT, 'tests', 'support', 'mock-openai', 'scenarios', 'tool-plus-all-tools.json')
/** 场景里的 `<scratch>` 占位符。用正斜杠：它会落进 JSON 字符串里，反斜杠要按层数转义，极易错。 */
const TOKENS = {
  '<scratch>': path.join(RUNTIME_ROOT, 'scratch').replace(/\\/g, '/'),
  '<fixtures>': path.join(REPO_ROOT, 'e2e', 'fixtures').replace(/\\/g, '/'),
}
const READY_TIMEOUT_MS = Number(process.env.START_APP_TIMEOUT_MS ?? '180000')
const TOKEN_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u

/** 开发者真正的 harness home：只从它借共享的 bundle 仓库。 */
function realDshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv === '' ? path.join(os.homedir(), '.dsh') : fromEnv
}

/**
 * 把 dsh 的共享 bundle 仓库（`<home>/profiles/node_modules`）以 junction 借到隔离 home 里。
 * 防的是：为了一个测试实例把 200 多个包再装一遍；同时仓库是只读借用，不往开发者那边写。
 */
function linkSharedStore() {
  const shared = path.join(realDshHome(), 'profiles', 'node_modules')
  if (!fs.existsSync(shared)) {
    fail(`找不到共享 bundle 仓库：${shared}\n先用 dsh 起过一次（或 dsh plugin add 装过插件），或用 DSH_HOME 指向正确的 harness home。`)
  }
  const link = path.join(E2E_HOME, 'profiles', 'node_modules')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const current = fs.existsSync(link) ? fs.realpathSync.native(link) : undefined
  if (current === fs.realpathSync.native(shared)) return
  if (current !== undefined) fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(shared, link, 'junction')
}

/**
 * dsh 的入口 JS。**不走 `dsh.cmd` shim**：shim 要经 shell，Windows 上会弹黑窗。
 * 从 node 所在的目录按全局布局找，再退回 PATH 的每一项。
 */
function resolveDshEntry() {
  const override = (process.env.DSH_ENTRY ?? '').trim()
  if (override !== '') return override
  const nodeDir = path.dirname(process.execPath)
  const suffix = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const candidates = [
    path.join(nodeDir, 'node_modules', suffix),
    path.join(nodeDir, '..', 'lib', 'node_modules', suffix),
  ]
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim() !== '') candidates.push(path.join(dir, 'node_modules', suffix))
  }
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/** 整棵进程树一起收：宿主会自己拉子进程（bash 运行时等），只杀父进程会留下占着端口的孤儿。 */
function killTree(pid) {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* 已经退出 */
  }
}

const options = parseArgs(process.argv.slice(2))

/**
 * 夹具目录**每轮清空**：上一轮跑成功留下的 `fixture.ts` 会让「写入/ast_edit 没落盘」这类回归
 * 被读回的内容掩盖掉（场景的收尾轮次只要求读回的文件里含 `name + GREETING`，残留文件照样满足）。
 * 仓库自带的 headless 驱动同样是每轮 `resetScratch()`，两边对齐。
 */
const SCRATCH = path.join(RUNTIME_ROOT, 'scratch')
fs.rmSync(SCRATCH, { recursive: true, force: true })
fs.mkdirSync(SCRATCH, { recursive: true })
linkSharedStore()

/**
 * 必须在 import `support.ts` 之前设好：它按模块加载时的环境决定 profile 建在哪个 home 下。
 */
process.env.DSH_HOME = E2E_HOME

const { prepareProfile, mockProfilePatch } = await import('../../tests/support/harness/support.ts')
const { loadScenarioFile, startMockOpenAI } = await import('../../tests/support/mock-openai/index.ts')

const dshEntry = resolveDshEntry()
if (dshEntry === undefined) {
  fail('找不到 dsh 的入口 JS。用 DSH_ENTRY 指定，例如 DSH_ENTRY=<node 全局目录>/node_modules/@deepseek-ai/dsh/lib/bin.js')
}

/** 假供应商：端口 0 由系统分配，测试实例的模型调用不外网、也不需要真密钥。 */
const mock = await startMockOpenAI({
  scenario: loadScenarioFile(SCENARIO_PATH, { tokens: TOKENS }),
  port: 0,
  log: (line) => process.stdout.write(`[mock] ${line}\n`),
})

/**
 * 测试专用接线只写进隔离 home 里的 profile，**不改 dsh 自己的配置文件、不改仓库里的任何东西**：
 * 运行结束后没有任何需要人工还原的改动。
 */
/**
 * 测试 profile 的起始补丁 ＝ 仓库里那份假供应商接线，外加一条测试专用的设置：
 * 把「预览版说明」浮层直接确认掉（`ui-settings-general` 的 `welcomeNoticeVersion`）。
 *
 * 不预置会怎样：浮层在每个浏览器上下文第一次打开时弹出，且它起来时作曲区的发送键是
 * disabled；宿主把它自己的确认状态写回 profile 的补丁层，而 `prepareProfile` 每轮都
 * 重写这份文件，于是**每轮的首条用例都要重新踩一次**（等它、关它），后面的用例又白等。
 * 版本号必须与宿主 dsh-client-ui-settings-models 里的 `WELCOME_NOTICE_VERSION` 精确相等；
 * 宿主哪天改了，浮层会回来，用例侧留了兜底（见 tests/support/dsh-web.ts）。
 */
const PROFILE_PATCH = `${mockProfilePatch(mock.url, { withPreset: true, transcriptView: 'verbose' })}
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
`

prepareProfile(PROFILE, BUNDLES, PROFILE_PATCH)

const child = spawn(
  process.execPath,
  [dshEntry, PROFILE, '--port', String(options.port), '--no-open'],
  {
    cwd: REPO_ROOT,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: E2E_HOME, MOCK_LLM_KEY: 'mock-key' },
  },
)

/**
 * 发布点：令牌是进程级随机串，配置期无从得知，只能由起来之后的这里交出去。
 * 文件名按**实际**监听到的端口取——框架传的是它自己挑好的具体端口，但 `--port 0`（手工起）时
 * 请求值与实际值不同，按请求值命名会让测试按 `app.baseUrl` 找不到。
 */
function endpointFileFor(port) {
  return path.join(RUNTIME_ROOT, `app-endpoint-${String(port)}.txt`)
}

/** 先清掉同名旧文件：端口被系统回收后可能又分给这一轮，留着上一轮的令牌会让测试拿到一个失效地址。 */
if (options.port !== 0) fs.rmSync(endpointFileFor(options.port), { force: true })

let output = ''
let ready = false
let stopping = false

const readyTimer = setTimeout(() => {
  process.stderr.write(`start-app: ${String(READY_TIMEOUT_MS)}ms 内没拿到带令牌的地址；已收输出：\n${output}\n`)
  void shutdown(1)
}, READY_TIMEOUT_MS)

async function shutdown(code) {
  if (stopping) return
  stopping = true
  clearTimeout(readyTimer)
  killTree(child.pid)
  try {
    await mock.close()
  } catch {
    /* 关服务失败不该改变退出码 */
  }
  process.exit(code)
}

function onData(chunk) {
  const text = chunk.toString()
  process.stdout.write(text)
  if (ready) return
  /* 累积后再匹配：地址可能被切成两个 chunk，逐块匹配会看漏。 */
  output += text
  const match = TOKEN_URL.exec(output)
  if (match === null) return
  ready = true
  clearTimeout(readyTimer)
  const actualPort = Number(new URL(match[0]).port)
  const endpointFile = endpointFileFor(actualPort)
  fs.rmSync(endpointFile, { force: true })
  // 一并发布夹具目录：用例要能像 headless 驱动那样**独立读盘**核最终态（别只信界面）。
  fs.writeFileSync(endpointFile, JSON.stringify({
    url: match[0],
    port: actualPort,
    mockUrl: mock.url,
    scratch: SCRATCH.replace(/\\/g, '/'),
  }, null, 2))
  process.stdout.write(`START_APP_READY ${match[0]}\n`)
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('error', (error) => {
  process.stderr.write(`start-app: 起 dsh 失败：${String(error)}\n`)
  void shutdown(1)
})
child.on('exit', (code) => {
  process.stderr.write(`start-app: dsh 退出（code=${String(code)}）\n`)
  void shutdown(code ?? 1)
})
process.on('SIGTERM', () => { void shutdown(0) })
process.on('SIGINT', () => { void shutdown(0) })
