import type { SessionRecord } from '../harness/types.js'
import type { SessionStore } from '../sessions/service.js'

export function recordsAfterAreOnlyInterruptSynthetic(
  records: readonly SessionRecord[],
  userMessageId: string,
): boolean {
  const userIndex = records.findIndex((record) =>
    record.type === 'message'
    && record.role === 'user'
    && record.id === userMessageId
  )
  if (userIndex < 0) return false

  for (const record of records.slice(userIndex + 1)) {
    if ((record.type === 'at_mention_context' || record.type === 'session_reference_context') && record.userMessageId === userMessageId) continue
    if (record.type === 'turn_interruption' && record.userMessageId === userMessageId) continue
    if (record.type === 'compact_boundary' || record.type === 'compact_attempt_failed') continue
    return false
  }

  return true
}

export async function rollbackInterruptedPromptIfSynthetic(input: {
  store: SessionStore
  sessionId: string
  userMessageId: string
}): Promise<SessionRecord[] | null> {
  const loaded = await input.store.loadRecordsWithDiagnostics(input.sessionId)
  if (!recordsAfterAreOnlyInterruptSynthetic(loaded.records, input.userMessageId)) return null

  const truncated = await input.store.truncateBeforeMessage(input.sessionId, input.userMessageId)
  if (!truncated.success) return null

  return input.store.loadRecords(input.sessionId)
}
