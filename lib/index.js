/**
 * Cursor one-shot provider for DeepSeek Harness 0.2.2-rc.3.
 * Adapted from DeepSeek's MIT-licensed subagent-codex provider.
 */
                                                  
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite, assertUsableCwd, NO_START_CAPABILITIES,
                                                           
} from '@deepseek-ai/dsh-subagent'
import { resolveCursorLaunch } from './cli.js'
import { DEFAULT_DISPOSE_GRACE_MS, cursorStartupFailure, startCursorRun } from './run.js'

export const name = 'subagent-cursor'
export const inject = ['subagents', 'subprocess']

                         
                                      
                       
                                                                                  
                  
                                                                       
                
                                                               
                              
                                                                                     
                         
 

export const Config            = z.object({
  providerName: z.string().min(1).default('cursor'),
  cliPath: z.string().min(1),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

                                                                                                                           

class CursorProvider                             {
           capabilities = NO_START_CAPABILITIES
           inheritsParentContext = false

           name        
                   ctx         
                   config                

  constructor(name        , ctx         , config                ) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  async start(request                              ) {
    request.signal.throwIfAborted()
    let cwd        
    let launch                                                 
    try {
      cwd = assertUsableCwd('subagent-cursor', 'child cwd', request.cwd)
      launch = await resolveCursorLaunch(this.config.cliPath, this.config.model, this.config.env, cwd)
      request.signal.throwIfAborted()
    } catch (error         ) {
      if (request.signal.aborted) throw new Error('subagent-cursor: aborted before startup')
      throw cursorStartupFailure(error)
    }
    return startCursorRun(request, {
      cwd,
      argv: launch.argv,
      configDir: launch.configDir,
      env: launch.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, reason) => this.ctx.logger.warn(
        `subagent-cursor "${this.name}": child run failed (${reason}): ${error.message}`,
      ),
    })
  }
}

export function apply(ctx         , config        )       {
  const resolved                 = {
    providerName: config.providerName ?? 'cursor',
    ...(config.cliPath === undefined ? {} : { cliPath: config.cliPath }),
    ...(config.model === undefined ? {} : { model: config.model }),
    env: { ...config.env },
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  for (const value of [resolved.providerName, resolved.cliPath, resolved.model]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error('subagent-cursor: names, model and cliPath must be non-empty strings')
    }
  }
  assertPositiveFinite('subagent-cursor', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-cursor: disposeGraceMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  ctx.subagents.registerProvider(new CursorProvider(resolved.providerName, ctx, resolved))
}
