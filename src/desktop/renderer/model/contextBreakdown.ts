import type { ContextBreakdown, ContextCategoryKey } from '../../../harness/contextBreakdown.js'
import { formatTokens } from './usage.js'

/** Each key is also the swatch's class suffix: `ctx-swatch-<key>`. */
export type ContextRowKey = ContextCategoryKey | 'buffer' | 'free'

export interface ContextPopoverRow {
  readonly key: ContextRowKey
  readonly label: string
  readonly tokens: string
  readonly percent: string
  /** Share of the model window, for the bar. */
  readonly ratio: number
}

export interface ContextPopoverListItem {
  readonly label: string
  /** The untruncated text, for the hover title. */
  readonly full: string
  readonly tokens: string
  readonly muted: boolean
}

export interface ContextPopoverView {
  /** The ring's own figure: used against the usable window. */
  readonly percent: string
  readonly usage: string
  readonly rows: readonly ContextPopoverRow[]
  readonly deferred: readonly { readonly label: string; readonly tokens: string }[]
  readonly mcpTools: readonly ContextPopoverListItem[]
  readonly memoryFiles: readonly ContextPopoverListItem[]
  readonly note?: string
}

const LABELS: Record<ContextRowKey, string> = {
  system: '系统提示词',
  tools: '内置工具',
  mcpTools: 'MCP 工具',
  skills: '技能',
  memory: '记忆文件',
  messages: '对话消息',
  buffer: '压缩预留',
  free: '剩余空间',
}

const PATH_HEAD = 8
const PATH_TAIL = 18

/**
 * The popover's rows. The percentages are of the model window, so the rows —
 * the compaction reserve and the free space included — add up to the whole
 * bar; the lead percentage stays the ring's, measured against the usable part.
 */
export function contextPopoverView(
  breakdown: ContextBreakdown,
  contextWindow: number,
  usableContextWindow: number,
): ContextPopoverView {
  const window = Math.max(contextWindow, usableContextWindow, 1)
  const row = (key: ContextRowKey, tokens: number): ContextPopoverRow => ({
    key,
    label: LABELS[key],
    tokens: formatTokens(tokens),
    percent: `${((tokens / window) * 100).toFixed(1)}%`,
    ratio: tokens / window,
  })
  const used = breakdown.categories
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((category) => row(category.key, category.tokens))
  const buffer = window - usableContextWindow
  const free = Math.max(0, usableContextWindow - breakdown.usedTokens)

  return {
    percent: `${Math.round(Math.min(1, breakdown.usedTokens / Math.max(usableContextWindow, 1)) * 100)}%`,
    usage: `${formatTokens(breakdown.usedTokens)} / ${formatTokens(usableContextWindow)}`,
    rows: [...used, ...(buffer > 0 ? [row('buffer', buffer)] : []), row('free', free)],
    deferred: breakdown.deferred.map((entry) => ({
      label: `${LABELS[entry.key]}（延迟加载）`,
      tokens: formatTokens(entry.tokens),
    })),
    mcpTools: breakdown.mcpTools.map((tool) => ({
      label: tool.name,
      full: tool.deferred ? `${tool.name}（延迟加载，未占用上下文）` : tool.name,
      tokens: formatTokens(tool.tokens),
      muted: tool.deferred,
    })),
    memoryFiles: breakdown.memoryFiles.map((file) => ({
      label: shortenPath(file.path),
      full: file.path,
      tokens: formatTokens(file.tokens),
      muted: false,
    })),
    ...(breakdown.estimated ? { note: '尚无模型返回的计数，以上均为估算' } : {}),
  }
}

/** Middle-truncated, so both the root and the file name stay readable. */
export function shortenPath(path: string): string {
  if (path.length <= PATH_HEAD + PATH_TAIL + 1) return path
  return `${path.slice(0, PATH_HEAD)}…${path.slice(-PATH_TAIL)}`
}
