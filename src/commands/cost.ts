import type { CommandDefinition, CommandUsage } from './types.js'

export const costCommand: CommandDefinition = {
  name: 'cost',
  description: 'Show token usage and cost',
  run: async (_args, context) => {
    const usage = context.getUsage?.()
    if (!usage) {
      context.writeLine('Usage information not available.')
      return
    }
    const summary = await context.getSessionMetricsSummary?.()
    const cost = describeCost(usage)

    if (context.openCommandView) {
      const sections = [{
        title: 'Usage',
        rows: [
          { label: 'Cache read', value: usage.cacheReadInputTokens.toLocaleString() },
          { label: 'Cache write', value: (usage.cacheCreationInputTokens ?? 0).toLocaleString() },
          { label: 'Input tokens', value: usage.inputTokens.toLocaleString() },
          { label: 'Output tokens', value: usage.outputTokens.toLocaleString() },
          {
            label: 'Total cost',
            value: cost ?? 'Unavailable (missing pricing)',
            tone: cost ? 'normal' as const : 'warning' as const,
          },
        ],
      }]
      if (summary) {
        sections.push({
          title: 'Prompt cache',
          rows: [
            { label: 'Cache hit rate', value: formatPercent(summary.totalCacheHitRate) },
            { label: 'Total turns', value: summary.totalTurns.toLocaleString() },
            { label: 'First break turn', value: formatNullableInteger(summary.firstBreakTurnCount) },
            { label: 'Cache breaks', value: summary.cacheBreakCount.toLocaleString() },
            { label: 'Avg compact interval', value: formatTurns(summary.averageCompactIntervalTurns) },
          ],
        })
      }
      context.openCommandView({
        kind: 'info',
        title: 'Session usage',
        subtitle: 'Token consumption, cost, and prompt-cache health',
        sections,
      })
      return
    }

    const lines = [
      'Session usage:',
      `  Cache read:    ${usage.cacheReadInputTokens.toLocaleString()}`,
      `  Cache write:   ${(usage.cacheCreationInputTokens ?? 0).toLocaleString()}`,
      `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
      `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
      `  Total cost:    ${cost ?? 'unavailable (missing pricing)'}`,
    ]
    if (summary) {
      lines.push(
        '',
        'Session cache:',
        `  Cache hit rate:        ${formatPercent(summary.totalCacheHitRate)}`,
        `  Total turns:           ${summary.totalTurns.toLocaleString()}`,
        `  First break turn:      ${formatNullableInteger(summary.firstBreakTurnCount)}`,
        `  Cache breaks:          ${summary.cacheBreakCount.toLocaleString()}`,
        `  Avg compact interval:  ${formatTurns(summary.averageCompactIntervalTurns)}`,
      )
    }
    context.writeLine(lines.join('\n'))
  },
}

/** `USD 0.31 + CNY 2.1 (excludes earlier requests)`, or undefined when nothing was priced. */
function describeCost(usage: CommandUsage): string | undefined {
  const amounts = Object.entries(usage.cost?.amounts ?? {})
  if (amounts.length === 0) return undefined
  const notes = [
    ...(usage.cost?.unpriced ? ['some requests unpriced'] : []),
    ...(usage.cost?.legacy ? ['excludes earlier requests'] : []),
  ]
  const total = amounts.map(([currency, amount]) => `${currency} ${formatCost(amount)}`).join(' + ')
  return notes.length > 0 ? `${total} (${notes.join('; ')})` : total
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function formatPercent(value: number | null): string {
  if (value === null) return 'n/a'
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`
}

function formatNullableInteger(value: number | null): string {
  return value === null ? 'n/a' : value.toLocaleString()
}

function formatTurns(value: number | null): string {
  if (value === null) return 'n/a'
  const rounded = Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)
  return `${rounded} turns`
}
