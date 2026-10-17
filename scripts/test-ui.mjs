/** Run UI fixtures with their own cwd and the unified package's Vitest dependency. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--config', 'vitest.config.ts', '--configLoader', 'runner', ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('../ui/', import.meta.url)), stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
