import { randomUUID } from 'node:crypto'
import type { ModelProvider, ModelRequest, ToolResultRecord, ToolUseSummaryRecord, TokenUsage } from './types.js'
import { toolUseSummaryCacheSource } from './cacheBreakDetection.js'
import { requestModel } from './requestUsage.js'

export interface SummarizeToolUseParams {
  onUsage?(usage: TokenUsage, model: string): void
  provider: ModelProvider
  model: string
  promptCacheRetention?: 'in_memory' | '24h'
  toolResults: ToolResultRecord[]
  /**
   * Project root, so the `tool_use_summary` cache source is bound to it. Two
   * projects summarizing in one process would otherwise share a baseline.
   */
  cwd?: string
}

export interface SummarizeToolUseResult {
  record: ToolUseSummaryRecord
  usage?: TokenUsage
}

/**
 * Generates a concise summary of a batch of tool results using a model call.
 *
 * The summary is a short, git-commit-style label that captures what the tool
 * calls accomplished. This record is persisted alongside session records so
 * future context windows can reference tool activity without replaying every
 * individual result.
 */
export async function summarizeToolUse(params: SummarizeToolUseParams): Promise<SummarizeToolUseResult> {
  const { provider, model, promptCacheRetention, toolResults } = params

  const toolUseIds = toolResults.map((r) => r.toolUseId)
  const snippets = toolResults.map((r) => {
    const status = r.ok ? 'ok' : 'error'
    const preview = r.content.slice(0, 500)
    return `[${r.tool}:${status}] ${preview}`
  })

  const request: ModelRequest = {
    model,
    promptCacheRetention,
    promptCaching: false,
    cacheSource: toolUseSummaryCacheSource(params.cwd),
    system: 'You are a summarizer. Produce a single concise line (max 120 chars) describing what these tool calls accomplished. No preamble, no explanation — just the summary line.',
    messages: [
      {
        id: randomUUID(),
        role: 'user',
        content: snippets.join('\n'),
        createdAt: new Date().toISOString(),
      },
    ],
  }

  const { response, usage } = await requestModel(provider, request, params.onUsage)
  const summary = response.content.trim().split('\n')[0]?.slice(0, 120) ?? 'tool use'

  return {
    record: {
      id: randomUUID(),
      type: 'tool_use_summary',
      summary,
      toolUseIds,
      createdAt: new Date().toISOString(),
      model,
    },
    usage,
  }
}
