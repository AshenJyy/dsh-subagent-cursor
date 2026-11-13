/** Cursor ACP v1 adapter over the Harness's shared JSON-RPC line transport. */
                                                     
                                                        
                                                               
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { CURSOR_SESSION_ID } from './session.js'

                                         
                                         
                                           
                                                                                                             
                              
 

function object(value         )             {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subagent-cursor: invalid ACP object')
  }
  return value              
}

function text(value         )         {
  if (typeof value !== 'string') throw new Error('subagent-cursor: invalid ACP text')
  return value
}

function thrown(value         )        {
  return value instanceof Error ? value : new Error('subagent-cursor: protocol failure')
}

async function raceAbort   (pending            , signal             )             {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw new Error('subagent-cursor: request cancelled')
  }
  const cancellation = Promise.withResolvers       ()
  const onAbort = ()       => { cancellation.reject(new Error('subagent-cursor: request cancelled')) }
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await Promise.race([pending, cancellation.promise]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

export class CursorAcpWire {
                   transport                      
                   fatal = Promise.withResolvers       ()
          sessionId                    
          active = false
          cancelled = false
          closed = false
          inputEnded = false
          terminalObserved = false
          failure                         = { stage: 'prompt-start', category: 'unknown' }
          diagnostic                    
          currentText = ''
          lastText = ''
          boundary = false
          messageId                    
                   input          
                   claimSession                             

  constructor(
    input          ,
    output          ,
    claimSession                             ,
  ) {
    this.input = input
    this.claimSession = claimSession
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleRequest(method, params))
    this.transport.onNotification((method, params) => {
      try { this.handleNotification(method, params) }
      catch (error         ) { this.fail(thrown(error)) }
    })
    input.on('error', this.onStreamError)
    input.on('end', this.onEnd)
    output.on('error', this.onStreamError)
  }

  start()       { this.transport.start() }

  async initialize(signal             )                {
    const response = object(await this.guarded(this.transport.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-subagent-cursor', version: '0.2.2-rc.3' },
    }, signal), signal))
    if (response.protocolVersion !== 1) throw new Error('subagent-cursor: unsupported ACP protocol version')
    object(response.agentCapabilities)
    // Cursor reads its existing credentials at startup. Calling authenticate
    // when signed out would open a browser and block unattended execution.
    // session/new reports missing native authentication as a startup failure.
  }

  async startSession(cwd        , signal             )                {
    signal.throwIfAborted()
    // Retain any returned identity before an abort race is settled so cleanup
    // can own a session whose response was already in flight.
    const pending = this.transport.request('session/new', { cwd, mcpServers: [] }).then(value => {
      const response = object(value)
      const id = text(response.sessionId)
      if (!CURSOR_SESSION_ID.test(id)) throw new Error('subagent-cursor: invalid native session id')
      this.claimSession(id)
      this.sessionId = id
    })
    await this.guarded(pending, signal)
  }

  async runTurn(texts                   , signal             )                          {
    if (!this.sessionId || this.active || this.terminalObserved) throw new Error('subagent-cursor: invalid prompt lifecycle')
    this.active = true
    this.failure = { stage: 'prompt', category: 'unknown' }
    try {
      const response = object(await this.guarded(this.transport.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: texts.map(value => ({ type: 'text', text: value })),
      }, signal), signal))
      this.terminalObserved = true
      const output = this.collectOutput()
      switch (response.stopReason) {
        case 'end_turn':
          if (!output.length) {
            this.failure = { stage: 'prompt', category: 'invalid-result' }
            throw new Error('subagent-cursor: completed without an answer')
          }
          return { output, stopReason: 'completed' }
        case 'cancelled':
          return { output, stopReason: 'aborted' }
        case 'max_tokens':
          this.failure = { stage: 'prompt', category: 'limit' }
          return { output, stopReason: 'max-tokens' }
        case 'max_turn_requests':
          this.failure = { stage: 'prompt', category: 'limit' }
          return { output, stopReason: 'error' }
        case 'refusal':
          this.failure = { stage: 'prompt', category: 'access-policy' }
          return { output, stopReason: 'refusal' }
        default:
          this.failure = { stage: 'prompt', category: 'invalid-result' }
          throw new Error('subagent-cursor: invalid ACP stop reason')
      }
    } catch (error         ) {
      if (this.failure.category === 'unknown' && error !== null && typeof error === 'object' && 'code' in error) {
        this.failure = {
          stage: 'prompt',
          category: error.code === -32000 ? 'access-policy' : 'product-error',
        }
      }
      throw error
    } finally {
      this.active = false
    }
  }

  interrupt()       {
    this.cancelled = true
    if (!this.sessionId || !this.active || this.closed) return
    try {
      this.transport.notify('session/cancel', { sessionId: this.sessionId })
      void this.transport.flush().catch(() => {})
    } catch { /* Managed process teardown is authoritative. */ }
  }

  collectOutput()                 {
    const answer = this.currentText.trim() ? this.currentText : this.lastText
    return answer.trim() ? [{ type: 'text', text: answer }] : []
  }

  collectDiagnostic()                     { return this.diagnostic }
  collectFailure()                         { return this.failure }
  endedBeforeTerminal()          { return this.inputEnded && !this.terminalObserved }

  close()       {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onEnd)
    this.transport.close()
  }

          guarded   (pending            , signal             )             {
    return raceAbort(Promise.race([this.fatal.promise, pending]), signal)
  }

          fail(error       )       {
    this.failure = { stage: this.active ? 'prompt' : 'prompt-start', category: 'transport' }
    this.fatal.reject(error)
  }

                   onStreamError = ()       => {
    this.fail(new Error('subagent-cursor: ACP stream failure'))
  }

                   onEnd = ()       => {
    this.inputEnded = true
    if (!this.terminalObserved) this.fail(new Error('subagent-cursor: ACP stream closed before completion'))
  }

          handleNotification(method        , raw            )       {
    if (method !== 'session/update') return
    const params = object(raw)
    if (params.sessionId !== this.sessionId || !this.active || this.terminalObserved) return
    const update = object(params.update)
    if (update.sessionUpdate === 'tool_call') {
      // Only new calls are boundaries: late tool_call_update notifications can
      // overlap final text and must not split that text.
      this.boundary = true
      return
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const content = object(update.content)
    if (content.type !== 'text') return
    const chunk = text(content.text)
    if (!chunk.length) return
    const id = typeof update.messageId === 'string' ? update.messageId : undefined
    if (this.boundary || (id !== undefined && this.messageId !== undefined && id !== this.messageId)) {
      if (this.currentText.trim()) this.lastText = this.currentText
      this.currentText = ''
    }
    this.boundary = false
    this.messageId = id
    this.currentText += chunk
  }

          async handleRequest(method        , raw            )                   {
    try {
      const params = object(raw)
      if (method === 'session/request_permission') {
        if (this.cancelled || !this.active) return { outcome: { outcome: 'cancelled' } }
        if (params.sessionId !== this.sessionId) throw new Error('subagent-cursor: permission request belongs to another session')
        if (!Array.isArray(params.options)) throw new Error('subagent-cursor: invalid permission choices')
        const options = params.options.map(object)
        // A native ask-question fallback is a question, not a tool approval.
        const skip = options.find(option => option.optionId === '__ask_question_skip__')
        const allow = skip ?? options.find(option => option.kind === 'allow_once')
        if (!allow || typeof allow.optionId !== 'string') return { outcome: { outcome: 'cancelled' } }
        if (skip) this.diagnostic = 'Cursor unattended decision: interactive question skipped.'
        // --force authorizes execution; avoid persisting allow-always rules.
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
      if (method === 'cursor/ask_question') {
        this.diagnostic = 'Cursor unattended decision: interactive question skipped.'
        return { outcome: this.cancelled ? { outcome: 'cancelled' } : { outcome: 'skipped', reason: 'Unattended one-shot task; use the supplied instructions.' } }
      }
      if (method === 'cursor/create_plan') {
        return { outcome: { outcome: this.cancelled ? 'cancelled' : 'accepted' } }
      }
      throw new Error('subagent-cursor: unsupported ACP server request')
    } catch (error         ) {
      this.fail(thrown(error))
      throw error
    }
  }
}
