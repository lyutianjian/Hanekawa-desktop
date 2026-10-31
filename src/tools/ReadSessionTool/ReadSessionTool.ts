import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { ReadSessionInput, SessionReferenceHost } from '../../runtime/protocol/sessionReferences.js'
import { parseSessionReference } from '../../runtime/sessionReferenceText.js'
import { DESCRIPTION, READ_SESSION_TOOL_NAME } from './prompt.js'

const timestamp = z.string().datetime({ offset: true }).describe('ISO timestamp filtering saved session update time.')
export const readSessionInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search').describe('Find saved conversations.'),
    query: z.string().max(1024).describe('Title query, or literal case-insensitive content keyword, up to 1024 characters.'),
    scope: z.enum(['title', 'content', 'all']).optional().describe('Default title; content/all scan saved visible messages.'),
    projectRoot: z.string().optional().describe('Filter to a known project identifier.'),
    updatedAfter: timestamp.optional(),
    updatedBefore: timestamp.optional(),
    cursor: z.string().optional().describe('Continue the same query and filters.'),
    limit: z.number().int().min(1).max(20).optional().describe('Maximum hits; default 10.'),
  }).strict(),
  z.object({
    action: z.literal('read').describe('Read saved visible conversation history.'),
    ref: z.string().refine((value) => parseSessionReference(value) !== undefined, 'Expected a complete session UUID or standard session URI.').describe('Complete UUID or hanekawa://session/<UUID>.'),
    cursor: z.string().optional().describe('Continue a read page; excludes from and anchorMessageId.'),
    from: z.enum(['latest', 'start']).optional().describe('First page direction, default latest; excludes anchorMessageId.'),
    anchorMessageId: z.string().min(1).optional().describe('Read near a message ID returned by search.'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum displayed items; default 20.'),
    includeTools: z.boolean().optional().describe('Include historical visible tool calls/results without executing them.'),
  }).strict(),
]).superRefine((input, context) => {
  if (input.action === 'search') {
    if (input.scope !== undefined && input.scope !== 'title' && !input.query.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: 'Content search requires a nonempty keyword.' })
    }
    if (input.updatedAfter && input.updatedBefore && Date.parse(input.updatedAfter) > Date.parse(input.updatedBefore)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAfter'], message: 'updatedAfter must not be later than updatedBefore.' })
    }
  } else if ((input.cursor !== undefined && (input.from !== undefined || input.anchorMessageId !== undefined))
    || (input.from !== undefined && input.anchorMessageId !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor, from and anchorMessageId are mutually exclusive.' })
  }
})

function target(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const value = input as { action?: unknown; query?: unknown; ref?: unknown }
  if (value.action === 'search') return typeof value.query === 'string' && value.query.trim() ? value.query.trim() : '最近会话'
  if (typeof value.ref !== 'string') return ''
  return parseSessionReference(value.ref)?.slice(0, 8) ?? value.ref
}

export function createReadSessionTool(host?: SessionReferenceHost): Tool {
  return {
    name: READ_SESSION_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: readSessionInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    // Source content is capped separately; leave room for escaped JSON and metadata.
    maxResultSizeChars: 180_000,
    userFacingName: (input) => (input as { action?: unknown } | undefined)?.action === 'search' ? '查找会话' : '读取会话',
    getToolUseSummary: target,
    getActivityDescription: (input) => `${(input as { action?: unknown } | undefined)?.action === 'search' ? '查找会话' : '读取会话'} ${target(input)}`.trim(),
    shouldDisplayResult: () => true,
    async execute(rawInput, context) {
      const input = readSessionInputSchema.parse(rawInput) as ReadSessionInput
      if (!host) return { ok: false, content: '当前运行环境未配置会话读取服务。', errorCode: 'precondition_failed' }
      const callContext = { sessionId: context.sessionId, signal: context.abortSignal }
      const result = input.action === 'search'
        ? await host.search(input, callContext)
        : await host.read(input, callContext)
      const summary = 'results' in result
        ? `找到 ${result.results.length} 个会话${result.complete ? '' : ' · 尚未搜索完'}`
        : `${result.session.title} · ${result.items.length} 条内容${result.page.hasMore ? ' · 还有后续页' : ''}`
      const redact = context.redactToolOutput ?? ((text: string) => text)
      return {
        ok: true,
        content: redact(JSON.stringify(result)),
        metadata: { display: {
          summary: redact(summary),
          headerSuffix: 'results' in result ? `${result.results.length} 个会话` : `${result.items.length} 条内容${result.page.hasMore ? ' · 还有后续页' : ''}`,
          detail: redact(JSON.stringify(result, null, 2)),
        } },
      }
    },
  }
}
