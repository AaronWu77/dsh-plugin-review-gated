import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = process.env.DSH_ROOT
if (!root) throw new Error('Set DSH_ROOT to the read-only DSH checkout')
const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile).config
const aliases = Object.entries(config.compilerOptions.paths as Record<string, string[]>).map(([key, paths]) => ({
  find: new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)') + '$'),
  replacement: resolve(root, paths[0]!).replaceAll('\\', '/').replace('*', '$1'),
}))
const { standardDecoratorPlugin, vitestExecArgv } = await import(/* @vite-ignore */ pathToFileURL(resolve(root, 'vitest.shared.ts')).href)
export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  // Host source fixtures and the feature must share the renderer's React identity.
  resolve: { alias: [...['react/jsx-dev-runtime', 'react/jsx-runtime', 'react-dom/client', 'react-dom', 'react', '@testing-library/react'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: createRequire(resolve(root, 'packages/test-support/client-runtime/package.json')).resolve(name) })), ...aliases] },
  cacheDir: resolve('dist/.vite'),
  oxc: { jsx: { runtime: 'automatic' } },
  test: { execArgv: vitestExecArgv, include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'], environment: 'node', testTimeout: 20000, hookTimeout: 20000 },
})
