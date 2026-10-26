import type { ModelCatalogEntry } from '../../config/modelCatalog.js'
import { formatModelCatalog } from '../modelCatalog.js'

export const START_THREAD_TOOL_NAME = 'StartThread'

export function buildStartThreadDescription(models: readonly ModelCatalogEntry[], defaultModel?: string): string {
  return `${DESCRIPTION}\n\n${formatModelCatalog(models)}\nDefault thread model: ${defaultModel ? JSON.stringify(defaultModel) : 'unavailable; choose a listed key'}.`
}

export const DESCRIPTION = `Start a new thread: a separate session that works on one goal in this project while you stay free to talk to the user.\n\nParameters:\n- \`title\` — a short name for the thread.\n- \`brief\` — the task in your own words: name the files or area it may touch and what done looks like.\n- \`background\` — at least 80 characters of context the thread cannot get anywhere else (the user's goal, decisions already made, constraints). The thread sees only the background and the brief, not this conversation.\n- \`writesCode\` — true when the thread will change files. It then works in its own git worktree and branch, so parallel threads do not collide; false for research or review in the shared directory.\n- \`model\` — optional model key; omit to use the global thread default.\n\nReturns the threadId. The thread runs on its own; you are woken when it reports, so do not poll. Open one thread per independent goal. Not available: choosing a thread's permission mode or working directory.`
