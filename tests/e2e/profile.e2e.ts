/**
 * End-to-end tests against the GLOBALLY INSTALLED `dsh` command
 * (@deepseek-ai/dsh on npm): install this bundle into an isolated
 * `dsh-bash-plus` profile via `dsh plugin --profile dsh-bash-plus add ...`,
 * then boot it with `dsh --profile dsh-bash-plus "task"`. The `web` profile is
 * never touched — everything runs under a temporary `DSH_HOME`.
 *
 * Keyless path: a scripted mock LLM server calls the real `bash` tool through
 * the booted harness, and each scenario asserts on the wire bodies the model
 * next received (the tool-result markdown / markers).
 * @module tests
 */

import { execa, execaSync } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterEach, describe, expect, it } from 'vitest'

/** The dsh profile name this suite installs into and boots. */
const PROFILE = 'dsh-bash-plus'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const bundleDir = fileURLToPath(new URL('../..', import.meta.url))
const dshBin = resolveGlobalDshBin()

/** Resolve the globally installed `dsh` bin (npm global root → @deepseek-ai/dsh). */
function resolveGlobalDshBin(): string {
  const globalRoot = execaSync('npm', ['root', '-g']).stdout.trim()
  const manifest = JSON.parse(readFileSync(join(globalRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as {
    bin?: Record<string, string> | string
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (bin === undefined) throw new Error('global @deepseek-ai/dsh declares no dsh bin')
  return resolve(join(globalRoot, '@deepseek-ai', 'dsh', bin))
}

interface ProfileFixture {
  home: string
  profileDir: string
}

/** Temp DSH_HOME with a pre-seeded `dsh-bash-plus` profile manifest. */
function createProfileFixture(): ProfileFixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-e2e-'))
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2))
  // Mirror initProfile's pnpm settings so `dsh plugin`'s pnpm run behaves like
  // an initialized profile (hoisted linker, no auto peers).
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return { home, profileDir }
}

function seedProfile(home: string): void {
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

async function installBundle(home: string): Promise<void> {
  const install = await execa(process.execPath, [
    dshBin,
    'plugin',
    '--profile',
    PROFILE,
    'add',
    `link:${bundleDir}`,
  ], {
    timeout: 180_000,
    killSignal: 'SIGKILL',
    reject: false,
    env: { ...process.env, DSH_HOME: home },
    extendEnv: false,
  })
  expect(install.exitCode, install.stderr).toBe(0)
}

function runDsh(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs = 120_000,
): Promise<{ stdout: string; code: number; stderr: string }> {
  return execa(process.execPath, [dshBin, ...args], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    reject: false,
    env: { ...process.env, ...env },
    extendEnv: false,
  }).then(result => ({ stdout: result.stdout, code: result.exitCode ?? -1, stderr: result.stderr }))
}

/** Boot the profile against a mock LLM and return the captured wire bodies. */
async function runMockBoot(
  home: string,
  apiKey: string,
  server: MockLlmServer,
  patchPath?: string,
): Promise<{ stdout: string; code: number; stderr: string }> {
  const args = ['--profile', PROFILE]
  if (patchPath !== undefined) args.push('--patch', patchPath)
  args.push('run', 'the', 'bash', 'task')
  return runDsh(args, {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: server.baseURL,
  }, 180_000)
}

/**
 * Install the bundle and drive one scripted bash tool call end to end: the
 * mock's `tool_call_success` asks for `bash` with `toolArguments`, the harness
 * executes it against real bash, and the assertion inspects every request
 * body the model received (which include the tool result).
 */
async function scenario(toolArguments: string, assertBodies: (bodies: string) => void, patch?: { autoBackgroundMs: number }): Promise<void> {
  const apiKey = 'dsh-bash-plus-e2e-key'
  const server = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    apiKey,
    toolName: 'bash',
    toolArguments,
    successText: 'e2e bash tool completed',
  })
  const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-boot-'))
  seedProfile(home)
  let patchPath: string | undefined
  try {
    await installBundle(home)
    if (patch !== undefined) {
      patchPath = join(home, 'timeout-patch.yml')
      writeFileSync(patchPath, '- id: bash-plus\n  config:\n    autoBackgroundMs: 0\n')
    }
    const result = await runMockBoot(home, apiKey, server, patchPath)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('e2e bash tool completed')
    expect(server.requests.length).toBeGreaterThan(1)
    const bodies = JSON.stringify(server.requests.map(request => request.body))
    assertBodies(bodies)
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const fixture = createProfileFixture()
afterEach(() => {
  rmSync(fixture.home, { recursive: true, force: true })
})

describe('dsh profile install and boot', () => {
  it('installs the bundle via `dsh plugin --profile dsh-bash-plus add`', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-install-'))
    try {
      await installBundle(home)
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: string[] } }
      }
      expect(manifest.dsh?.profile?.bundles).toContain('@xiaoso/dsh-bash-plus')
      expect(manifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 240_000)

  it('composes the patch: official bash tools disabled, bash-plus injected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-compose-'))
    seedProfile(home)
    try {
      await installBundle(home)
      const result = await runDsh(['--profile', PROFILE, '--dump-config'], { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('@xiaoso/dsh-bash-plus')
      expect(result.stdout).toContain('tool-bash')
      expect(result.stdout).toContain('tool-pwsh')
      expect(result.stdout).toContain('disabled: true')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 240_000)

  it('boots the profile and delivers a foreground result to the model', async () => {
    await scenario(
      JSON.stringify({ command: 'echo e2e-bash-works', description: 'echo marker' }),
      (bodies) => {
        expect(bodies).toContain('run the bash task')
        expect(bodies).toContain('e2e-bash-works')
      },
    )
  }, 300_000)

  it('reports a non-zero exit marker from the real subprocess', async () => {
    await scenario(
      JSON.stringify({ command: 'exit 3', description: 'exit non-zero' }),
      (bodies) => {
        expect(bodies).toContain('[exit code: 3]')
      },
    )
  }, 300_000)

  it('passes multi-line command output through to the model', async () => {
    await scenario(
      JSON.stringify({ command: 'printf "alpha\\nbeta\\ngamma\\n"', description: 'print lines' }),
      (bodies) => {
        expect(bodies).toContain('alpha')
        expect(bodies).toContain('gamma')
      },
    )
  }, 300_000)

  it('hands back a background job id for run_in_background', async () => {
    await scenario(
      JSON.stringify({ command: 'echo bg-ack-marker && sleep 1', description: 'background echo', run_in_background: true }),
      (bodies) => {
        expect(bodies).toMatch(/Backgrounded as job bash-\d+/)
      },
    )
  }, 300_000)

  it('surfaces a foreground timeout marker (auto-background disabled via patch)', async () => {
    await scenario(
      JSON.stringify({ command: 'sleep 5', description: 'sleep long', timeoutMs: 1000 }),
      (bodies) => {
        expect(bodies).toContain('[timed out after 1000ms]')
      },
      { autoBackgroundMs: 0 },
    )
  }, 300_000)

  it('never touches the web profile', () => {
    expect(existsSync(join(fixture.home, 'profiles', 'web'))).toBe(false)
  })
})
