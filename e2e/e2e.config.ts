/**
 * e2e 通道的主配置。
 *
 * 位置即项目根：e2e 框架把「选中的配置文件所在目录」当作项目根，测试 glob、
 * output、app.command 的 cwd 全部相对它。所以这份文件放在 `e2e/`，用例落在
 * `e2e/tests/`，产物落在 `e2e/.e2e/`——放仓库根会和项目自己的 `tests/` 撞名，
 * 且会把 `.e2e` 产物目录撒在根上。
 *
 * 框架**不加载** `.env`，所以这里显式读；缺失是正常情况（CI 里靠真实环境变量）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/** 配置文件所在目录 == 框架认定的项目根。取不到就以 cwd 兜底，别让配置加载炸在路径上。 */
const PROJECT_ROOT = ((): string => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
})()

const ENV_FILE = path.join(PROJECT_ROOT, '.env')
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

/** 仓库根（配置在 `e2e/` 下）。 */
const REPO_ROOT = path.resolve(PROJECT_ROOT, '..')

/**
 * 产物**多落一份**到稳定目录：`.e2e/results/...` 每次 run 都会重写，而证据是留给人回看的
 * （仓库自带的 GUI 驱动就是写进 `docs/plan/` 下的固定路径）。`docs/*` 整体 gitignore，不进 git 也不进 npm 包。
 */
const EVIDENCE_DIR = path.resolve(process.env.E2E_EVIDENCE_DIR ?? path.join(REPO_ROOT, 'docs', 'e2e-evidence'))

/**
 * 页面侧的错误收集器。
 *
 * 框架当前**不提供** `page.on('pageerror')`（迁移文档把 console/pageerror 监听列为 missing），
 * 只把未捕获异常记进 appLog 与 trace 页、不据此判失败。所以要自己收：`initScripts` 在每个文档
 * 开头注入这段，用例末尾读数组并断言为空。
 *
 * 写成字符串而不是函数：函数要被序列化进页面（还不能闭包任何东西），字符串没这层意外。
 */
const PAGE_ERROR_COLLECTOR = `
globalThis.__dshE2ePageErrors = [];
addEventListener('error', function (event) { globalThis.__dshE2ePageErrors.push(String(event.message || event.error || 'error')); });
addEventListener('unhandledrejection', function (event) { globalThis.__dshE2ePageErrors.push('unhandledrejection: ' + String(event.reason)); });
`

/** 空值和模板里的占位符都当作「没配」——占位符当真值会让 agent 用例以鉴权错误失败，掩盖真正原因。 */
const PLACEHOLDERS = new Set(['', 'sk-REPLACE_ME'])
const envValue = (name: string): string | undefined => {
  const raw = process.env[name]?.trim()
  return raw === undefined || PLACEHOLDERS.has(raw) ? undefined : raw
}

const baseURL = envValue('E2E_MODEL_BASE_URL')
const apiKey = envValue('E2E_MODEL_API_KEY')
const modelId = envValue('E2E_MODEL_ID')
/**
 * 三项齐全才组装模型；缺一项整个 `agents` 键都不出现。框架没有隐式默认模型：
 * 少了它，只有 `agent.*` 用例会以 MODEL_UNAVAILABLE 失败，其余用例照跑。
 */
const model = baseURL !== undefined && apiKey !== undefined && modelId !== undefined
  ? createOpenAICompatible({ name: 'e2e-model', baseURL, apiKey }).chatModel(modelId)
  : undefined

export default {
  /** 相对项目根；显式写死，免得默认值随框架版本漂移。 */
  tests: 'tests/**/*.e2e.ts',

  targets: [
    {
      name: 'dsh-web',
      engine: web({ initScripts: [PAGE_ERROR_COLLECTOR] }),
      app: {
        /**
         * 端口 0 让框架挑一个空闲端口，再由 `{port}` 展开给启动命令。写死端口会被上一轮
         * 没退干净的实例占住（EADDRINUSE）；这一条同时保证测试实例永不占用开发者正在用的端口。
         */
        url: 'http://127.0.0.1:0',
        /**
         * 就绪探针故意打不带 token 的根路径：宿主对未认证的索引请求回 401，落在框架
         * 认可的 200-499 里即为就绪。带 token 的地址是进程级随机串，配置期无从得知。
         */
        readyUrl: 'http://127.0.0.1:{port}/',
        command: {
          /**
           * 用 `node` 直跑入口，不经 shell、不经 pnpm/powershell 的 .cmd shim：框架本就
           * 不通过 shell 解析 `executable`，而 shim 在 Windows 上会弹黑窗。
           */
          executable: 'node',
          /**
           * `--experimental-transform-types`：启动脚本要直接 import 仓库里已有的
           * `tests/support/{harness,support.ts}` 与 `tests/support/mock-openai/`，而它们用了
           * 参数属性等非「仅擦除」语法，Node 22 默认的 strip-only 模式载不动。
           */
          args: ['--experimental-transform-types', 'support/start-app.mjs', '--port', '{port}'],
          /**
           * 子进程环境是白名单制的，`DSH_HOME` 不在白名单里。开发者把 harness home 挪过位置时，
           * 启动脚本要靠它找到共享的 bundle 仓库；没设就不传，让两边都用 `~/.dsh` 这个默认值。
           */
          env: process.env.DSH_HOME === undefined ? {} : { DSH_HOME: process.env.DSH_HOME },
          /** dsh 首次启动要装 profile；给足 3 分钟，别让慢启动被当成 APP_UNREACHABLE。 */
          startupTimeout: 180_000,
          shutdownTimeout: 15_000,
          /** 不写 log 的话子进程输出会被丢弃——启动期炸了将完全不可见。 */
          log: '.e2e/logs/app.log',
        },
      },
      /** 显式留 trace：失败时能拿到逐步证据，而不是只有一张最终截图。 */
      trace: 'on',
      /**
       * 录像常开。这条通道的产物就是给人看的——GUI 的行为只有录下来才能回看，
       * 而这里跑的都不依赖模型（秒级），录一轮的代价换一份能倒回去查的证据，划算。
       */
      video: 'on',
    },
  ],

  /** 单文件串行跑：被测的是一个共享状态的 GUI 实例，并行只会互相抢会话。 */
  workers: 1,
  /** 不重试：失败要留下现场，重试会把现场盖掉。 */
  retries: 0,
  /**
   * 写死 cache 模式：CI/沙箱的 shell 常带 CI=true，那会把「默认」的 cache 降级成只读，
   * 还会改并行度与重试次数，同一份配置在不同机器上行为就不一样了。
   */
  cache: 'read-write',
  /** 相对项目根；显式写死，别落在仓库根。 */
  output: '.e2e',
  /**
   * 每个产物完成即在稳定目录留一份副本（`.e2e/` 那份照旧，报告仍指向它）。
   * **按 runId 分目录**：不按轮隔离的话，上一轮失败留下的 `002-failure.png` 会和这一轮通过的文件
   * 混在同一个目录里，谁也说不清哪张是当前的。失败**不会**拖垮这一轮（框架就是这么定的），所以这里只管尽力写。
   */
  artifacts: {
    store: {
      async put(artifact) {
        const target = path.resolve(EVIDENCE_DIR, artifact.runId, artifact.path)
        if (!target.startsWith(`${EVIDENCE_DIR}${path.sep}`)) return { ref: 'skipped' }
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, artifact.bytes)
        return { ref: target }
      },
    },
  },
  timeout: 120_000,

  ...(model === undefined
    ? {}
    : {
        agents: {
          default: {
            model,
            system: 'You are a QA agent for the DeepSeek Harness web UI. Verify every outcome on screen before claiming it.',
          },
        },
      }),
} satisfies E2EConfig
