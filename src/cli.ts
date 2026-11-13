/** Resolve the installed CLI without invoking shell launchers or auto-updaters. */
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

async function file(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

function normalizeEnv(source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [
    process.platform === 'win32' ? key.toUpperCase() : key, value,
  ]))
}

async function payload(directory: string): Promise<string[] | undefined> {
  const node = join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
  const entry = join(directory, 'index.js')
  if (await file(node) && await file(entry)) return [await realpath(node), await realpath(entry)]
  return undefined
}

async function installedPayload(directory: string): Promise<string[] | undefined> {
  const direct = await payload(directory)
  if (direct) return direct
  const versionsDir = join(directory, 'versions')
  let entries
  try { entries = await readdir(versionsDir, { withFileTypes: true }) } catch { return undefined }
  const versions = entries.filter(entry => entry.isDirectory()
    && /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
  for (const version of versions) {
    const found = await payload(join(versionsDir, version.name))
    if (found) return found
  }
  return undefined
}

async function resolveCandidate(candidate: string): Promise<string[] | undefined> {
  let info
  try { info = await stat(candidate) } catch { return undefined }
  if (info.isDirectory()) return installedPayload(candidate)
  if (!info.isFile()) return undefined
  const extension = extname(candidate).toLowerCase()
  if (process.platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extension)) {
    return installedPayload(dirname(candidate))
  }
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    const nativeNode = join(dirname(candidate), process.platform === 'win32' ? 'node.exe' : 'node')
    return [await file(nativeNode) ? await realpath(nativeNode) : process.execPath, await realpath(candidate)]
  }
  await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  return [await realpath(candidate)]
}

export async function resolveCursorLaunch(
  cliPath: string | undefined,
  model: string | undefined,
  overrides: Record<string, string>,
  cwd: string,
): Promise<{ argv: string[]; configDir: string; env: Record<string, string> }> {
  const env = normalizeEnv(overrides)
  const effective = { ...normalizeEnv(scrubbedParentEnv()), ...env }
  const childHome = process.platform === 'win32'
    ? effective.USERPROFILE || (effective.HOMEDRIVE && effective.HOMEPATH ? effective.HOMEDRIVE + effective.HOMEPATH : homedir())
    : effective.HOME || homedir()
  // These are Cursor's native paths.js rules, including XDG_CONFIG_HOME.
  const configDir = resolve(cwd, effective.CURSOR_CONFIG_DIR?.trim()
    ? effective.CURSOR_CONFIG_DIR
    : effective.XDG_CONFIG_HOME?.trim() ? join(effective.XDG_CONFIG_HOME, 'cursor') : join(childHome, '.cursor'))
  const candidates: string[] = []
  const pathNames = cliPath === undefined ? ['cursor-agent', 'agent'] : [cliPath]
  if (cliPath !== undefined && isAbsolute(cliPath)) {
    candidates.push(cliPath)
  } else {
    if (cliPath !== undefined && /[/\\]/.test(cliPath)) {
      throw new Error('subagent-cursor: cliPath must be absolute or a bare executable name')
    }
    if (cliPath === undefined) {
      if (process.platform === 'win32' && effective.LOCALAPPDATA) {
        candidates.push(join(effective.LOCALAPPDATA, 'cursor-agent'))
      } else {
        candidates.push(join(childHome, '.local', 'bin', 'cursor-agent'), join(childHome, '.local', 'bin', 'agent'))
      }
    }
    for (const directory of (effective.PATH ?? '').split(delimiter).filter(Boolean)) {
      // Never search an implicit cwd from an empty PATH segment.
      for (const name of pathNames) {
        const extensions = process.platform === 'win32' && !extname(name) ? ['.exe', '.cmd', '.ps1', ''] : ['']
        for (const extension of extensions) candidates.push(join(directory.replace(/^"|"$/g, ''), name + extension))
      }
    }
  }
  for (const candidate of candidates) {
    const command = await resolveCandidate(candidate)
    if (!command) continue
    return {
      argv: [...command, '--force', ...(model === undefined ? [] : ['--model', model]), 'acp'],
      configDir,
      // Pin the very same storage root for the child and the cleanup owner.
      env: { ...env, CURSOR_CONFIG_DIR: configDir },
    }
  }
  throw new Error('subagent-cursor: installed Cursor CLI payload not found; configure cliPath')
}
