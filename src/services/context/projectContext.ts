import { readFileSync } from 'node:fs'
import { readFile, access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getUserInstructionsPath } from '../../utils/paths.js'

/**
 * The instruction file names, in preference order. **First match wins per
 * directory**: a repo that keeps `AGENTS.md` and `CLAUDE.md` in sync would
 * otherwise send the same guide twice in every request.
 */
const CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
]

/** The first of `names` that exists in `dir`, or undefined. */
async function firstExisting(dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const filePath = join(dir, name)
    if (await exists(filePath)) return filePath
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function discoverContextFiles(cwd: string): Promise<string[]> {
  // Collected cwd first, returned root-first: the walk goes upwards, but the
  // prompt reads downwards, and the nearest file is the most specific one, so
  // it has to come last to override its ancestors.
  const found: string[] = []
  let dir = cwd
  const visited = new Set<string>()

  while (dir !== resolve(dir, '..') && !visited.has(dir)) {
    visited.add(dir)
    const contextFile = await firstExisting(dir, CONTEXT_FILES)
    if (contextFile) found.push(contextFile)
    dir = resolve(dir, '..')
  }

  return found.reverse()
}

/** Sync: a runtime snapshots it per session while it is being built. */
export function readUserInstructions(): string {
  try {
    return readFileSync(getUserInstructionsPath(), 'utf-8')
  } catch {
    return ''
  }
}

/** Blank content removes the file rather than leaving an empty one behind. */
export async function writeUserInstructions(content: string): Promise<void> {
  const path = getUserInstructionsPath()
  if (content.trim() === '') {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

export async function loadProjectContext(cwd: string): Promise<string> {
  return composeProjectContext(readUserInstructions(), await loadProjectEntries(cwd))
}

async function loadProjectEntries(cwd: string): Promise<string[]> {
  const files = await discoverContextFiles(cwd)
  const entries: string[] = []
  for (const file of files) {
    let content = ''
    try {
      content = (await readFile(file, 'utf-8')).trim()
    } catch {}
    if (content === '') continue
    entries.push(labelled(file, 'project instructions, checked into the codebase', content))
  }
  return entries
}

export function composeProjectContext(userInstructions: string, projectEntries: readonly string[]): string {
  const user = userInstructions.trim()
  const entries = user === ''
    ? [...projectEntries]
    : [labelled(getUserInstructionsPath(), "user's private global instructions for all projects", user), ...projectEntries]
  if (entries.length === 0) return ''

  // The user's file and the project's are independent, not layers: each entry
  // says what it is and none is described as overriding another.
  return [
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
    ...entries,
  ].join('\n\n')
}

function labelled(path: string, description: string, content: string): string {
  return `Contents of ${path} (${description}):\n\n${content}`
}

// Project instruction files per cwd, labelled. A single-slot cache thrashed
// once two projects were open at the same time, re-reading every CLAUDE.md on
// each alternating turn. The global file is not in it: each session snapshots
// that one itself (see `createRuntimeFactory`).
const entriesByCwd = new Map<string, string[]>()

export async function getProjectEntries(cwd: string): Promise<string[]> {
  let entries = entriesByCwd.get(cwd)
  if (entries === undefined) {
    entries = await loadProjectEntries(cwd)
    entriesByCwd.set(cwd, entries)
  }
  return entries
}

export function clearProjectContextCache(cwd?: string): void {
  if (cwd === undefined) {
    entriesByCwd.clear()
    return
  }
  entriesByCwd.delete(cwd)
}
