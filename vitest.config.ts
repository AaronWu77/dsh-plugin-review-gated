import { defineConfig } from 'vitest/config'

export default defineConfig({ cacheDir: '.local/vite-cache', test: { cache: false, include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 } })
