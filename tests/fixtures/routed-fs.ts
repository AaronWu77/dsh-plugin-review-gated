/** Local fixture filesystem with one unmapped routed workspace alias. */
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { Config } from '@deepseek-ai/dsh-fs-local'
import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
export default class RoutedFileSystem extends LocalFileSystem {
  private readonly routedRoot: string
  constructor(ctx: Context, config: Config) { super(ctx, config); this.routedRoot = resolve(config.cwd ?? process.cwd()) }
  override processPathFromHostPath(hostPath: string): string | undefined {
    return resolve(hostPath) === this.routedRoot ? undefined : super.processPathFromHostPath(hostPath)
  }
}
