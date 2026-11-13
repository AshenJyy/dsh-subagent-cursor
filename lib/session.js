/** Remove only this run's newly allocated native ACP session after process exit. */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const CURSOR_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function missing(error         )          {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

export class CursorSessionStore {
                   root        
          existing = new Set        ()
          canonicalRoot                    
          sessionId                    

  constructor(configDir        ) {
    if (!isAbsolute(configDir)) throw new Error('subagent-cursor: session root must be absolute')
    this.root = resolve(configDir, 'acp-sessions')
  }

  async prepare()                {
    try {
      this.canonicalRoot = await realpath(this.root)
      this.existing = new Set(await readdir(this.root))
    } catch (error         ) {
      if (!missing(error)) throw error
    }
  }

  claim(sessionId        )       {
    if (!CURSOR_SESSION_ID.test(sessionId) || this.existing.has(sessionId)
      || (this.sessionId !== undefined && this.sessionId !== sessionId)) {
      throw new Error('subagent-cursor: invalid or pre-existing session identity')
    }
    this.sessionId = sessionId
  }

  async remove()                {
    const id = this.sessionId
    if (id === undefined) return
    const target = resolve(this.root, id)
    // Guard every recursive removal with an exact, single-child containment check.
    if (!CURSOR_SESSION_ID.test(id) || dirname(target) !== this.root || relative(this.root, target) !== id) {
      throw new Error('subagent-cursor: refused session cleanup outside its storage root')
    }
    try {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('subagent-cursor: session is not an ordinary directory')
      const root = await realpath(this.root)
      if (this.canonicalRoot !== undefined && root !== this.canonicalRoot) {
        throw new Error('subagent-cursor: session storage root changed during execution')
      }
      const actual = await realpath(target)
      if (actual !== join(root, id) || dirname(actual) !== root) {
        throw new Error('subagent-cursor: session cleanup resolved outside its storage root')
      }
      await rm(target, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
      this.sessionId = undefined
    } catch (error         ) {
      if (missing(error)) { this.sessionId = undefined; return }
      throw error
    }
  }
}
