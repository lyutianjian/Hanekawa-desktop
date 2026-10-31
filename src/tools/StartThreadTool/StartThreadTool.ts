import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { VALID_EFFORT_LEVELS } from '../../config/effort.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded } from '../coordinationShared.js'
import { DESCRIPTION, START_THREAD_TOOL_NAME } from './prompt.js'

export { START_THREAD_TOOL_NAME }

export const startThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1),
  background: z.string().trim().min(80, 'background must be at least 80 characters: the thread sees nothing else of this conversation'),
  writesCode: z.boolean(),
  model: z.string().trim().min(1).optional().describe('Exact model key from the tool description. Omit to use the global thread default.'),
  effort: z.enum(VALID_EFFORT_LEVELS).optional().describe('Reasoning effort for this thread. Omit to use the global thread default. A level the chosen model does not accept is moved to the nearest one it does.'),
})

export function createStartThreadTool(host: CoordinationHost): Tool {
  return {
    name: START_THREAD_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: startThreadInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'StartThread',
    async execute(rawInput, context) {
      const input = startThreadInputSchema.parse(rawInput)
      return guarded('StartThread', async () => {
        const caller = callerOf(context)
        const started = await host.startThread(caller, {
          title: input.title,
          brief: input.brief,
          background: input.background,
          writesCode: input.writesCode,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        })
        const where = started.branch === undefined ? 'in the shared directory' : `on branch ${started.branch}`
        return {
          ok: true,
          content: `Started thread ${started.threadId} ("${input.title}") ${where}. Model key: ${JSON.stringify(started.modelKey)}, effort: ${started.effort}. It is running now; you will be woken when it reports.`,
          metadata: { display: { summary: `Started ${input.title}` } },
        }
      })
    },
  }
}
