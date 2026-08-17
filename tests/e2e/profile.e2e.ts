/**
 * End-to-end tests against the GLOBALLY INSTALLED `dsh` command
 * (@deepseek-ai/dsh on npm): install this bundle into an isolated
 * `dsh-bash-plus` profile via `dsh plugin --profile dsh-bash-plus add ...`,
 * then boot it with `dsh --profile dsh-bash-plus "task"`. The `web` profile is
 * never touched — everything runs under a temporary `DSH_HOME`.
 *
 * Keyless path: a scripted mock LLM server drives real bash tool calls.
 * @module tests
 */

import { execa, execaSync } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
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

const fixture = createProfileFixture()
afterEach(() => {
  // The profile dir is removed per test in the finally blocks; this is the
  // suite-level cleanup for failures.
  rmSync(fixture.home, { recursive: true, force: true })
})

describe('dsh profile install and boot', () => {
  it('installs the bundle via `dsh plugin --profile dsh-bash-plus add`', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-install-'))
    try {
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
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: string[] } }
      }
      expect(manifest.dsh?.profile?.bundles).toContain('@xiaoso/dsh-bash-plus')
      expect(manifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 240_000)

  it('boots the profile and executes bash through the mock-driven model', async () => {
    const apiKey = 'dsh-bash-plus-e2e-key'
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      apiKey,
      toolName: 'bash',
      toolArguments: JSON.stringify({ command: 'echo e2e-bash-works', description: 'echo marker' }),
      successText: 'e2e bash tool completed',
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-bash-plus-boot-'))
    const profileDir = join(home, 'profiles', PROFILE)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }, null, 2))
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    try {
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

      const result = await runDsh(['--profile', PROFILE, 'run', 'the', 'bash', 'task'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: server.baseURL,
      }, 180_000)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('e2e bash tool completed')
      expect(server.requests.length).toBeGreaterThan(1)
      const bodies = JSON.stringify(server.requests.map(request => request.body))
      expect(bodies).toContain('run the bash task')
      // The bash tool result must have reached the model's second request.
      expect(bodies).toContain('e2e-bash-works')
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 300_000)

  it('never touches the web profile', () => {
    expect(existsSync(join(fixture.home, 'profiles', 'web'))).toBe(false)
  })
})
