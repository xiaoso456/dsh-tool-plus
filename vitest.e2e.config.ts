import { defineConfig } from 'vitest/config'

/**
 * End-to-end tests against the GLOBALLY INSTALLED `dsh` command
 * (@deepseek-ai/dsh on npm): install this bundle into an isolated
 * `dsh-bash-plus` profile via `dsh plugin --profile dsh-bash-plus add ...`,
 * then boot it with `dsh --profile dsh-bash-plus "task"`. Longer timeouts:
 * each scenario spawns real `dsh` processes.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
