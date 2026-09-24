import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  define: { __SLIM__: JSON.stringify(false) },
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
