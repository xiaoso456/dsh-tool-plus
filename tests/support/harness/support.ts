/**
 * harness 公共件：路径、测试 profile 的搭建、dsh 进程的起停。
 *
 * 与 `mock-openai/` 同级（照 pi 的 `test/support/{harness,mock-openai}` 分层）：
 * mock 负责「假供应商说什么」，harness 负责「把真 dsh 拉起来、把工具跑一遍、把结果拍下来」。
 *
 * @module tests/support/harness
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件在 `<repo>/tests/support/harness/`）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** dsh 家目录。 */
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
/** 夹具目录：每次重跑前清空，跑完留着供回看。 */
export const SCRATCH = path.join(os.tmpdir(), 'tool-plus-e2e-scratch')
/** 夹具文件；剧本全程只动这一个。 */
export const FIXTURE = path.join(SCRATCH, 'fixture.ts')
/** 全工具场景的路径。 */
export const SCENARIO_PATH = path.join(REPO_ROOT, 'tests', 'support', 'mock-openai', 'scenarios', 'tool-plus-all-tools.json')
/**
 * 场景里的占位符替换表。**用正斜杠**：占位符会落进 `arguments` 这种「字符串里还是 JSON」的位置，
 * 反斜杠要按嵌套层数转义、极易错，正斜杠在 Windows 上 Node 与工具都认。
 */
export const SCENARIO_TOKENS: Record<string, string> = { '<scratch>': SCRATCH.replace(/\\/g, '/') }
/** 两个驱动都用它当任务标记：场景的主轮次靠它把「主对话」与「会话标题请求」分到不同桶。 */
export const TASK_MARKER = 'E2E-RUN'

/** 插件注册的全部工具名（`ast_grep` 默认关闭，靠 profile 补丁层打开）。 */
export const TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ast_grep', 'ast_edit']

/** dsh 可执行文件；`DSH_BIN` 可覆盖。 */
export const DSH_BIN = process.env.DSH_BIN ?? 'dsh'

/** 清空并重建夹具目录。 */
export function resetScratch(): void {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
}

function safeRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync(target)
  } catch {
    return undefined
  }
}

/** 测试 profile 的补丁层：把模型接到假供应商，并按需打开 ast_grep / 展开转写。 */
export function mockProfilePatch(
  url: string,
  options: { withPreset?: boolean; transcriptView?: string } = {},
): string {
  const preset = options.withPreset === true
    ? `- id: agent-preset-registry
  config:
    default: standard
    selectedDefault: tool-plus-standard

`
    : ''
  const chat = options.transcriptView === undefined
    ? ''
    : `- id: ui-chat
  config:
    transcriptView: ${options.transcriptView}

`
  return `# 由 tests/support/harness 生成，请勿手改：端到端测试专用的假供应商接线。
${preset}${chat}- id: tool-plus
  config:
    # ast_grep 默认关闭（OMP isToolActive 语义），这里显式打开以便端到端覆盖它。
    astGrepEnabled: true

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      mock:
        displayName: Mock
        apiKeyEnv: MOCK_LLM_KEY
        api: openai-completions
        baseURL: ${url}
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 100000
            input:
              - text

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mock
    model: mock-model

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: danger-full-access
`
}

/**
 * 建（或修好）一个指向本仓库的测试 profile。
 * @param name - profile 名（落在 `$DSH_HOME/profiles/<name>`）。
 * @param bundles - profile 的 bundle 顺序。
 * @param patch - `cordis.patch.yml` 的内容。
 * @returns profile 目录。
 */
export function prepareProfile(name: string, bundles: string[], patch: string): string {
  const dir = path.join(DSH_HOME, 'profiles', name)
  fs.mkdirSync(path.join(dir, 'node_modules', '@xiaoso'), { recursive: true })
  const link = path.join(dir, 'node_modules', '@xiaoso', 'dsh-tool-plus')
  const current = fs.existsSync(link) ? safeRealpath(link) : undefined
  if (current !== undefined && current !== REPO_ROOT) fs.unlinkSync(link)
  if (!fs.existsSync(link)) fs.symlinkSync(REPO_ROOT, link, 'junction')

  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { '@xiaoso/dsh-tool-plus': `link:${REPO_ROOT.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles, patchReload: 'startup' } },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  return dir
}

/** 跑一次 headless dsh（一次性任务），收齐 stdout/stderr 与退出码。 */
export function runDsh(profile: string, task: string, timeoutMs: number): Promise<{
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    const child = spawn(DSH_BIN, [profile, task], {
      cwd: REPO_ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, MOCK_LLM_KEY: 'mock-key' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\nspawn failed: ${String(error)}`, timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

/** 起一个 web 实例，等它打印出带 token 的地址。 */
export function startDshWeb(profile: string, port: number, timeoutMs = 180_000): Promise<{
  child: ChildProcess
  url: string
  output: () => string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH_BIN, [profile, '--port', String(port), '--no-open'], {
      cwd: REPO_ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, MOCK_LLM_KEY: 'mock-key' },
    })
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`web 实例 ${String(timeoutMs)}ms 内没给出地址；输出：\n${output}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolve({ child, url: match[0], output: () => output })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`web 实例提前退出（code=${String(code)}）；输出：\n${output}`))
    })
  })
}

/** 关掉 dsh 进程树（Windows 上必须整棵树，否则端口不放）。 */
export function killTree(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}

/** 取一行文本的首个非空行，用于日志与失败诊断。 */
export function firstLine(text: string | undefined): string {
  return String(text ?? '').split('\n').find((line) => line.trim() !== '')?.slice(0, 200) ?? '(空)'
}
