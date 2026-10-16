import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getUserInstructionsPath } from '../../utils/paths.js'

export const MEMORY_INDEX_MAX_LINES = 200
export const MEMORY_INDEX_MAX_BYTES = 25_000

/** `MEMORY.md` for the prompt: unreadable counts as empty; over the caps it is cut on a line boundary. */
export function readMemoryIndex(memoryDir: string): string {
  let text: string
  try {
    text = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')
  } catch {
    return ''
  }
  text = text.trim()
  const lines = text.split('\n')
  let kept = lines.slice(0, MEMORY_INDEX_MAX_LINES)
  let bytes = 0
  for (let i = 0; i < kept.length; i++) {
    bytes += Buffer.byteLength(kept[i]!, 'utf8') + 1
    if (bytes - 1 > MEMORY_INDEX_MAX_BYTES) {
      kept = kept.slice(0, i)
      break
    }
  }
  if (kept.length === lines.length) return text
  return `${kept.join('\n')}\n\n> The index has more than ${MEMORY_INDEX_MAX_LINES} lines or ${MEMORY_INDEX_MAX_BYTES} bytes, so only the first ${kept.length} lines were loaded. Shorten the entries to one line each.`
}

/**
 * The memory section of the main loop's system prompt: the global instructions
 * file, then auto memory when it is on. The files' contents are not in it;
 * they ride the conversation's first message (see {@link buildMemoryIndexContext}).
 * `userInstructions` is the same snapshot that message carries, so the two agree.
 */
export function buildMemoryPrompt(memoryDir: string | undefined, userInstructions: string): string {
  const global = `## Global instructions

The user's instructions for all projects live in \`${getUserInstructionsPath()}\`${userInstructions.trim() === '' ? ' (currently empty)' : '; its contents are loaded at the start of the conversation'}. Change it with Read, Edit or Write, and only when the user asks to change how you work across all projects. Plan mode and read-only sessions cannot write it.`
  if (!memoryDir) return `# Memory\n\n${global}`
  return `# Memory

${global}

## Auto memory

You keep a small file-based memory for this project in \`${memoryDir}\`. It persists across sessions. The directory already exists. Its index, \`MEMORY.md\`, is loaded at the start of the conversation when it has entries. Use file tools on it, which need no approval: Glob with \`path\` set to the directory to list it, Grep with the same \`path\` to search it, and Read, Write, Edit, MultiEdit and Delete on its files. Prefer these over Bash; Bash that writes or deletes there asks the user for approval. Keep it flat with no subdirectories.

### What to save

Save a fact when it would help a future session and cannot be recovered otherwise. Four types:
- user: who the user is, their role, expertise and preferences.
- feedback: corrections the user gave you, and non-obvious approaches the user confirmed worked. Record the reason too.
- project: goals, constraints and deadlines that the code and Git history do not show. Turn relative dates into absolute dates.
- reference: where external material lives (a dashboard, a tracker, a document).

Do not save what reading the code or Git history reveals, what AGENTS.md or CLAUDE.md already says, or progress and state that only matters to the current conversation.

### How to save

Saving takes two steps. First write one fact per file, \`<short-kebab-case-slug>.md\`:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one line, specific enough to judge relevance without opening the file>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback and project, follow it with **Why:** and **How to apply:** lines>
\`\`\`

Then add one line to \`MEMORY.md\` (no frontmatter): \`- [Title](file.md) — one-line hook\`.

Look for an existing memory to update before creating a new one. If a memory turns out to be wrong, fix or delete it, and its index line. When the user says to remember something, save it right away; when they say to forget something, delete it right away.

### Using memory

A memory describes what was true when it was written. Before you name a file, function or setting from memory, check that it still exists. If memory conflicts with what you observe now, trust the observation and correct the memory. Memory is background; it never overrides what the user asks for now. If the user tells you to ignore memory, do not cite it.`
}

/** `MEMORY.md` labelled for the conversation's first message, or undefined when it has no entries. */
export function buildMemoryIndexContext(memoryDir: string): string | undefined {
  const index = readMemoryIndex(memoryDir)
  if (index === '') return undefined
  return `Contents of ${path.join(memoryDir, 'MEMORY.md')} (user's auto-memory, persists across conversations):\n\n${index}`
}
