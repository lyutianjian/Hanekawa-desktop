import path from 'node:path'
import type { MemoryIndexWatch } from '../../harness/types.js'
import { readMemoryIndex } from './memoryPrompt.js'

/**
 * Tracks the `MEMORY.md` the model has seen — the conversation's opening
 * snapshot, then every delivered change — so another session's edit reaches
 * it as a diff instead of a rewritten prefix.
 */
export function createMemoryIndexWatch(memoryDir: string, opening: string): MemoryIndexWatch {
  const indexPath = path.join(memoryDir, 'MEMORY.md')
  let known = opening
  let ownWrite = false
  const take = (header: string): string | undefined => {
    const current = readMemoryIndex(memoryDir)
    const previous = known
    known = current
    return formatMemoryIndexChange(indexPath, header, previous, current)
  }
  return {
    take() {
      if (!ownWrite) return take(`changed in another session since you last saw it.`)
      ownWrite = false
      known = readMemoryIndex(memoryDir)
      return undefined
    },
    takeSinceOpening() {
      ownWrite = false
      known = opening
      return take(`has changed since the conversation began.`)
    },
    noteWrite(filePath) {
      if (path.resolve(filePath) === indexPath) ownWrite = true
    },
  }
}

export function formatMemoryIndexChange(indexPath: string, header: string, previous: string, current: string): string | undefined {
  const lines = (text: string) => text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  const before = lines(previous)
  const after = lines(current)
  const added = after.filter((line) => !before.includes(line))
  const removed = before.filter((line) => !after.includes(line))
  if (added.length === 0 && removed.length === 0) return undefined
  return [
    `${indexPath} ${header}`,
    ...(added.length > 0 ? ['', 'Added:', ...added] : []),
    ...(removed.length > 0 ? ['', 'Removed:', ...removed] : []),
  ].join('\n')
}
