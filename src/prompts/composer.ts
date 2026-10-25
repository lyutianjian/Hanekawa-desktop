import type { ChatMessage, ModelContextItem } from '../harness/types.js'
import type { ImageTokenStrategy } from '../media/imageTokens.js'
import {
  planContextItems,
  selectMessagesForContext,
  type ContextManagementConfig,
  type ContextSelectionPlan,
  type ToolSchemaCost,
} from './budget.js'

export interface ComposerOptions {
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  includeHistory?: boolean
  /** The tool schemas the request declares; they hold budget the history cannot. */
  tools?: readonly ToolSchemaCost[]
  imageTokenStrategy?: ImageTokenStrategy
  prefixTokens?: number
}

export class PromptComposer {
  compose(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    const { system, contextManagement, includeHistory = true, tools } = options

    if (!includeHistory) {
      return { system, messages: [] }
    }

    const truncatedMessages = selectMessagesForContext(messages, contextManagement, system, tools)
    return { system, messages: truncatedMessages }
  }

  buildRequestMessages(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    return this.compose(messages, options)
  }

  composeContextItems(
    items: ModelContextItem[],
    options: ComposerOptions,
  ): { system?: string; contextItems: ModelContextItem[]; messages: ChatMessage[]; selection: ContextSelectionPlan } {
    const { system, contextManagement, includeHistory = true, tools } = options

    if (!includeHistory) {
      return { system, contextItems: [], messages: [], selection: emptySelection() }
    }

    const selection = planContextItems(items, contextManagement, system, tools, options.imageTokenStrategy, options.prefixTokens)
    const contextItems = selection.items
    const messages = contextItems
      .filter((item): item is ModelContextItem & { kind: 'message' } => item.kind === 'message')
      .map((item) => item.message)

    return { system, contextItems, messages, selection }
  }
}

function emptySelection(): ContextSelectionPlan {
  return { items: [], availableTokens: 0, pinnedTokens: 0, overflowTokens: 0, trimmed: { count: 0, ids: [] } }
}
