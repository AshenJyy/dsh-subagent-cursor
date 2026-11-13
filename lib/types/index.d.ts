import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export declare const name = 'subagent-cursor'
export declare const inject: string[]
export interface Config {
  providerName?: string
  cliPath?: string
  model?: string
  env?: Record<string, string>
  disposeGraceMs?: number
}
export declare const Config: z<Config>
export declare function apply(ctx: Context, config: Config): void
