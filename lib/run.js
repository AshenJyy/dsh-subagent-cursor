/**
 * One-shot Cursor child lifecycle: spawn the real ACP server through the
 * subprocess seam, publish only after initialization and fresh session
 * creation, flatten post-publication failures, and dispose to whole-range
 * quiescence.
 *
 * @module dsh-subagent-cursor/run
 * Adapted from DeepSeek Harness subagent-codex (MIT), tag dsh-v0.2.2-rc.3.
 */

import { randomUUID } from 'node:crypto'
import { CursorSessionStore } from './session.js'
import { writeFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
                                                        
                                                         
import {
  settleRunResult,
  subprocessRunHandle,
                      
                   
                            
                          
} from '@deepseek-ai/dsh-subagent'
             
                   
                    
                      
                                    
import {
  CursorAcpWire,
                              
} from './wire.js'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

                         
                
                 
                                   
             
              
                     

                                                                           

                              
                                    
                                          
                                          
                                                  
 

function failureDiagnostic(facts                    )         {
  const fields = [
    'product: Cursor',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ]         
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class CursorRunFailure extends Error {
           facts                    

  constructor(
    facts                    ,
    cause          ,
  ) {
    super(
      `subagent-cursor: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.facts = facts
    this.name = 'CursorRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function cursorStartupFailure(cause         )        {
  return new CursorRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/** Fully resolved inputs for one Cursor ACP server run. */
                                
                                                                          
                      
                                                                           
                         
                                                                        
                            
                                                                        
                                      
                                                                               
                                 
                                                   
                                                                 
                                                                              
                                                                           
 

function thrown(value         )        {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt                         )           {
  if (prompt.length === 0) {
    throw new Error('subagent-cursor: the one-shot task must contain only text blocks')
  }
  const texts           = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-cursor: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-cursor: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param wire - private ACP server protocol connection.
 * @param child - shared-service handle that owns the managed range.
 */
export async function disposeCursorChild(
  wire               ,
  child                  ,
)                {
  wire.close()

  let outcome                               
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error         ) {
    throw new CursorRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * Start the real `agent --force acp` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and fresh session creation.
 */
export async function startCursorRun(
  request                      ,
  spec               ,
)                       {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-cursor: request was aborted before ACP server startup')
  }

  const sessions = new CursorSessionStore(spec.configDir)
  try { await sessions.prepare() } catch (error         ) { throw cursorStartupFailure(error) }
  request.signal.throwIfAborted()
  let child                  
  try {
    child = spec.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error         ) {
    throw new CursorRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new CursorAcpWire(
    child.stdout                                           ,
    child.stdin                                          ,
    sessionId => sessions.claim(sessionId),
  )
  const onStderr = (chunk                 )       => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = ()       => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async ()                => {
    try {
      await disposeCursorChild(wire, child)
      try { await sessions.remove() } catch (error         ) {
        throw new CursorRunFailure({ stage: 'session-cleanup', category: 'unknown' }, error)
      }
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise      ((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts                                
  const processFailure                 = child.done.then       (
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new CursorRunFailure(processFailureFacts)
    },
    (error         ) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new CursorRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = ()       => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-cursor: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = ()       => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage                               = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'session-new'
    await Promise.race([wire.startSession(spec.cwd, request.signal), processFailure])
  } catch (error         ) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof CursorRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise      ((resolve) => { setImmediate(resolve) })
    }
    const failure = new CursorRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: error instanceof CursorRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError         ) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-cursor: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-cursor: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = ()                 => wire.collectOutput()
  let diagnostic                    
  const recordFailureDiagnostic = (facts                    )         => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts                    )                     => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error         )                 => {
      // Frames already queued by the exiting ACP server remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise      ((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result                          = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise      ((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error         ) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise      ((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof CursorRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof CursorRunFailure
          ? error
          : new CursorRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString           (randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
