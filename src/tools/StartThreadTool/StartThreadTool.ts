import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
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
        })
        const where = started.branch === undefined ? 'in the shared directory' : `on branch ${started.branch}`
        return {
          ok: true,
          content: `Started thread ${started.threadId} ("${input.title}") ${where}. Model key: ${JSON.stringify(started.modelKey)}. It is running now; you will be woken when it reports.`,
          metadata: { display: { summary: `Started ${input.title}` } },
        }
      })
    },
  }
}
