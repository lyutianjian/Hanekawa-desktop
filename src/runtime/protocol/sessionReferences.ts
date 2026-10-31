/** Saved-session references; transport values contain no provider replay state. */
export interface SessionReference {
  sessionId: string
  title: string
  uri: string
}

export interface SessionReferenceInfo extends SessionReference {
  projectRoot: string
  projectName: string
  projectIsGlobal: boolean
  updatedAt: string
  state: 'running' | 'idle' | 'unknown'
}

export interface SessionSearchInput {
  action: 'search'
  query: string
  scope?: 'title' | 'content' | 'all'
  projectRoot?: string
  updatedAfter?: string
  updatedBefore?: string
  cursor?: string
  limit?: number
}

export interface SessionReadInput {
  action: 'read'
  ref: string
  cursor?: string
  from?: 'latest' | 'start'
  anchorMessageId?: string
  limit?: number
  includeTools?: boolean
}

export type ReadSessionInput = SessionSearchInput | SessionReadInput

export interface SessionSearchHit extends SessionReferenceInfo {
  matchedIn: Array<'title' | 'content'>
  snippets: Array<{ messageId: string; text: string }>
}

export interface SessionSearchResult {
  schemaVersion: 1
  results: SessionSearchHit[]
  nextCursor?: string
  complete: boolean
  coverage: { sessionsScanned: number; bytesScanned: number; totalSessions: number }
}

export interface SessionReadItem {
  messageId: string
  role: 'user' | 'assistant' | 'tool' | 'summary'
  createdAt: string
  content: string
  tool?: string
  toolUseId?: string
  kind?: 'tool_use' | 'tool_result'
  ok?: boolean
  textOffset?: number
}

export interface SessionReadResult {
  schemaVersion: 1
  session: SessionReferenceInfo
  page: {
    direction: 'earlier' | 'later'
    firstMessageId?: string
    lastMessageId?: string
    nextCursor?: string
    hasMore: boolean
    truncated: boolean
  }
  items: SessionReadItem[]
  diagnostics: string[]
}

export interface SessionReferenceCallContext {
  sessionId?: string
  signal?: AbortSignal
}

export interface SessionReferenceHost {
  search(input: SessionSearchInput, context?: SessionReferenceCallContext): Promise<SessionSearchResult>
  read(input: SessionReadInput, context?: SessionReferenceCallContext): Promise<SessionReadResult>
  resolve(ref: string, signal?: AbortSignal): Promise<SessionReferenceInfo>
}
