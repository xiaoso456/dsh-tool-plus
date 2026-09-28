/**
 * 假 LLM 服务 CLI。
 *
 * 用法：`pnpm mock:llm -- --port 18990 --scenario tests/support/mock-openai/scenarios/tool-plus-all-tools.json`
 *
 * 起好后第一行打印 `MOCK_OPENAI_READY <url> scenario=<name>`，供脚本抓地址。
 *
 * @module tests/support/mock-openai
 */

import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScenarioFile } from './scenario.ts'
import { startMockOpenAI } from './server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

interface CliOptions {
  port: number
  host: string
  scenarioPath: string
  logFile: string | null
  quiet: boolean
  tokens: Record<string, string>
}

const USAGE = [
  '用法: tsx tests/support/mock-openai/cli.ts [options]',
  '  --port <n>        监听端口，默认 18990（0 = 系统分配）',
  '  --host <addr>     监听地址，默认 127.0.0.1',
  '  --scenario <p>    场景 JSON 路径，默认 scenarios/tool-plus-all-tools.json',
  '  --token <k=v>     场景里的占位符替换，可重复（如 --token <scratch>=C:/tmp/x）',
  '  --log <p>         日志文件路径（追加写入），默认不写文件',
  '  --quiet           不把日志打到 stdout（READY 行仍打印）',
  '  --help            显示本帮助',
].join('\n')

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 18990,
    host: '127.0.0.1',
    scenarioPath: resolve(HERE, 'scenarios/tool-plus-all-tools.json'),
    logFile: null,
    quiet: false,
    tokens: {},
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${String(arg)} 需要一个值`)
      index += 1
      return value
    }
    switch (arg) {
      case '--port': {
        const port = Number(next())
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port 非法：${String(port)}`)
        options.port = port
        break
      }
      case '--host': options.host = next(); break
      case '--scenario': options.scenarioPath = resolve(next()); break
      case '--log': options.logFile = resolve(next()); break
      case '--token': {
        const pair = next()
        const at = pair.indexOf('=')
        if (at <= 0) throw new Error(`--token 需要 k=v 形式：${pair}`)
        options.tokens[pair.slice(0, at)] = pair.slice(at + 1)
        break
      }
      case '--quiet': options.quiet = true; break
      case '--help': process.stdout.write(`${USAGE}\n`); process.exit(0); break
      default: throw new Error(`未知参数：${String(arg)}\n\n${USAGE}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const scenario = loadScenarioFile(options.scenarioPath, { tokens: options.tokens })
const logStream = options.logFile === null ? null : createWriteStream(options.logFile, { flags: 'a' })

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`
  logStream?.write(`${stamped}\n`)
  if (!options.quiet) console.log(stamped)
}

const server = await startMockOpenAI({
  scenario,
  port: options.port,
  host: options.host,
  log,
})

console.log(`MOCK_OPENAI_READY ${server.url} scenario=${scenario.name}`)
log(`mock-openai listening on ${server.url} (scenario=${scenario.name}, turns=${String(scenario.turns.length)})`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`mock-openai shutting down (${signal})`)
  await server.close()
  logStream?.end()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
