import { defineConfig } from 'vitest/config'

/**
 * Unit + keyless composition-boot tests. All @deepseek-ai/* imports resolve
 * through the installed npm packages (exports → lib), so no tsconfig paths
 * plugin is needed.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts', 'tests/boot/**/*.spec.ts'],
    testTimeout: 60_000,
  },
})
