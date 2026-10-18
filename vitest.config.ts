import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@slackline/shared': `${root}packages/shared/src/index.ts`,
      '@slackline/graph': `${root}packages/graph/src/index.ts`,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration suites share one test graph — never run them in parallel.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
