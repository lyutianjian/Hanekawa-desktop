import { randomUUID } from 'node:crypto'
import type {
  MessageQueuePriority,
  MessageQueueRecord,
  PersistedQueuedMessage,
  SessionRecord,
  SteerSource,
} from '../harness/types.js'
import type { ImageAttachmentRef, UserInput } from '../media/types.js'

export type QueuedMessage = PersistedQueuedMessage
export type PersistQueueRecord = (sessionId: string, record: MessageQueueRecord) => Promise<void>

/**
 * The accept-time gate (design §12.2): "the import and the new-image capability
 * check happen before the message is accepted into the queue".
 *
 * Injected rather than imported so this module keeps its runtime-only
 * dependencies, and owned here rather than at the two call sites so the rule
 * cannot fork between the shells: a throw leaves nothing persisted and the
 * snapshot untouched, which is exactly what both composers need to hand the
 * draft back. It is *not* re-run by `hydrate`/`replayMessageQueue` — a queue
 * persisted under an image-capable model must survive a restart under a
 * text-only one; the second check happens when the pump hands the message off.
 */
export type ValidateQueuedInput = (input: UserInput) => void | Promise<void>

/**
 * Re-owns a migrating message's attachments (design §12.3, the `/clear` row:
 * "copy its attachments and rebind the references first, then migrate the queue
 * records").
 *
 * Injected for the same reason {@link ValidateQueuedInput} is — this module
 * stays free of `services/` — and returns refs rather than mutating, so
 * {@link MessageQueue.migrateTo} keeps its "nothing persisted until the whole
 * message is ready" shape. Implementations degrade per image rather than
 * throwing; see `createQueueImageRebinder`.
 */
export type RebindQueuedImages = (
  images: readonly ImageAttachmentRef[],
  nextSessionId: string,
) => Promise<readonly ImageAttachmentRef[]>

/**
 * The inverse of `enqueue`: a persisted queue message back into the UserInput
 * every submission path speaks. Both shells' pumps hand off through this, so
 * the mapping from `content`/`images` to `text`/`images` cannot fork.
 */
export function queuedMessageToInput(message: QueuedMessage): UserInput {
  return {
    text: message.content,
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
  }
}

/**
 * One message's images re-owned by the target session, or the message
 * unchanged when it carries none, no rebinder was supplied, or the rebinder
 * failed. Never partially applied: a rebinder that returns the wrong number of
 * refs is treated as a failure rather than silently dropping an image.
 */
async function rebindMessageImages(
  message: QueuedMessage,
  nextSessionId: string,
  rebind: RebindQueuedImages | undefined,
): Promise<QueuedMessage> {
  if (!rebind || !message.images || message.images.length === 0) return message
  try {
    const rebound = await rebind(message.images, nextSessionId)
    if (rebound.length !== message.images.length) return message
    return Object.freeze({ ...message, images: [...rebound] })
  } catch {
    // The old session's files are still on disk, so the old refs still
    // resolve. Losing the queued message would be the worse outcome.
    return message
  }
}

/**
 * The queue's write lock, for a rewind that has to inspect the pending list and
 * rewrite its records without an enqueue or dequeue landing in between.
 */
export interface MessageQueueRewrite {
  /** The pending messages as of the lock being taken, in send order. */
  readonly snapshot: readonly QueuedMessage[]
  append(record: MessageQueueRecord): Promise<void>
  /** Installs the queue the caller has just persisted; no write of its own. */
  replace(messages: readonly QueuedMessage[]): void
}

export interface RewoundQueueReconciliation {
  /** A replay of the retained records would resurrect these; the live queue no longer has them. */
  retire: QueuedMessage[]
  /** The live queue still has these, but the retained records no longer do. */
  restore: QueuedMessage[]
}

/**
 * Diffs the live queue against what the retained records would replay to.
 *
 * A rewind cuts records without knowing which `message_queue` writes it
 * orphans, in either direction: cutting a sent message's user record (and the
 * `dequeue` after it) leaves its `enqueue` claiming it is still waiting, and
 * cutting a pending message's own `enqueue` drops it from the queue the user
 * still holds. Both sides are reconciled by id, once, before the rewrite.
 */
export function reconcileRewoundQueue(
  retained: readonly SessionRecord[],
  pending: readonly QueuedMessage[],
): RewoundQueueReconciliation {
  const replayed = replayMessageQueue(retained)
  const pendingIds = new Set(pending.map((message) => message.id))
  const replayedIds = new Set(replayed.map((message) => message.id))
  return {
    retire: replayed.filter((message) => !pendingIds.has(message.id)),
    restore: pending.filter((message) => !replayedIds.has(message.id)),
  }
}

const EMPTY_SNAPSHOT: readonly QueuedMessage[] = Object.freeze([])

/**
 * Messages the user submitted while a turn was running, persisted as
 * `message_queue` records so they survive a restart.
 *
 * One instance owns one session's queue. Every mutation goes through
 * {@link serialize}, so the persisted record and the in-memory snapshot can
 * never disagree: a rejected write leaves the snapshot untouched.
 *
 * `getSnapshot`/`subscribe` are shaped for `useSyncExternalStore` — the
 * snapshot is a frozen array whose identity only changes when the contents do.
 */
export class MessageQueue implements SteerSource {
  private sessionId: string
  private readonly persist: PersistQueueRecord
  private snapshot: readonly QueuedMessage[] = EMPTY_SNAPSHOT
  private operationChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly validateInput: ValidateQueuedInput | undefined

  constructor(
    sessionId: string,
    records: readonly SessionRecord[],
    persist: PersistQueueRecord,
    validateInput?: ValidateQueuedInput,
  ) {
    this.sessionId = sessionId
    this.persist = persist
    this.validateInput = validateInput
    this.replaceSnapshot(replayMessageQueue(records))
  }

  getSnapshot = (): readonly QueuedMessage[] => this.snapshot

  /** The running turn's view of the queue: it takes messages as steering. */
  pending = this.getSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async enqueue(
    input: UserInput,
    priority: MessageQueuePriority = 'next',
    options?: { origin?: 'coordinator' },
  ): Promise<QueuedMessage> {
    const message: QueuedMessage = Object.freeze({
      id: randomUUID(),
      content: input.text,
      priority,
      createdAt: new Date().toISOString(),
      ...(options?.origin ? { origin: options.origin } : {}),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    })

    return this.serialize(async () => {
      // Before the write, not after: a message the runtime would refuse to send
      // must never reach disk, or a restart would replay it into the same
      // refusal with no draft left to fix.
      await this.validateInput?.(input)
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'enqueue',
        message,
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot([...this.snapshot, message])
      return message
    })
  }

  /**
   * The message the pump would hand off next, without consuming it.
   *
   * Synchronous and non-mutating on purpose (design §12.2): the hand-off
   * validates the head *before* it is removed, so an input the runtime refuses
   * stays queued instead of being dequeued into a failure.
   */
  peek(): QueuedMessage | undefined {
    return this.snapshot[0]
  }

  /**
   * Removes a message the runtime has accepted — for a queued submission, once
   * its user record is on disk.
   *
   * Addressed by id rather than "the head" because the two are no longer the
   * same moment: a whole turn's worth of time passes between the peek and the
   * acceptance, and removing whatever happens to be first afterwards could drop
   * a message that was never sent.
   */
  async consume(messageId: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.snapshot.some((message) => message.id === messageId)) return
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'dequeue',
        messageId,
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot(this.snapshot.filter((message) => message.id !== messageId))
    })
  }

  /** Drops several messages, one `dequeue` record per id still present. */
  async discard(ids: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      let next = this.snapshot
      for (const messageId of new Set(ids)) {
        if (!next.some((message) => message.id === messageId)) continue
        await this.persist(this.sessionId, {
          id: randomUUID(),
          type: 'message_queue',
          operation: 'dequeue',
          messageId,
          createdAt: new Date().toISOString(),
        })
        next = next.filter((message) => message.id !== messageId)
        this.replaceSnapshot(next)
      }
    })
  }

  async clear(): Promise<void> {
    return this.serialize(async () => {
      if (this.snapshot.length === 0) return
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'clear',
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot([])
    })
  }

  /** Rebuild the active queue after session records are replaced or truncated. */
  async hydrate(records: readonly SessionRecord[]): Promise<void> {
    return this.serialize(async () => {
      this.replaceSnapshot(replayMessageQueue(records))
    })
  }

  /**
   * Runs a rewind under the queue's own write lock.
   *
   * Without the lock two rewrites would overwrite each other's compensation,
   * and an enqueue landing mid-rewind would be dropped by the rewrite.
   */
  async rewrite<T>(operation: (queue: MessageQueueRewrite) => Promise<T>): Promise<T> {
    return this.serialize(() => operation({
      snapshot: this.snapshot,
      append: (record) => this.persist(this.sessionId, record),
      replace: (messages) => this.replaceSnapshot(messages),
    }))
  }

  /** Point at a different session, discarding whatever the old one had pending. */
  async reset(sessionId: string, records: readonly SessionRecord[]): Promise<void> {
    return this.serialize(async () => {
      this.sessionId = sessionId
      this.replaceSnapshot(replayMessageQueue(records))
    })
  }

  /**
   * Move pending messages to a newly-created session without changing their
   * order. The compensating `clear` is written to the *old* session's log so
   * replaying it later cannot resurrect messages that now live elsewhere.
   *
   * `rebindImages` runs *before* the first `enqueue` is persisted, in the
   * order design §12.3 spells out: a message whose images still named the old
   * session would survive that session's deletion as a dangling reference.
   * A rebinder that throws is treated as "keep the old refs" — the old
   * session's files are still on disk, so a copy failure must not cost the
   * user their queued message.
   */
  async migrateTo(
    nextSessionId: string,
    records: readonly SessionRecord[],
    rebindImages?: RebindQueuedImages,
  ): Promise<void> {
    return this.serialize(async () => {
      const previousSessionId = this.sessionId
      const pending: QueuedMessage[] = []
      for (const message of this.snapshot) {
        pending.push(await rebindMessageImages(message, nextSessionId, rebindImages))
      }

      for (const message of pending) {
        await this.persist(nextSessionId, {
          id: randomUUID(),
          type: 'message_queue',
          operation: 'enqueue',
          message,
          createdAt: new Date().toISOString(),
        })
      }
      if (pending.length > 0) {
        await this.persist(previousSessionId, {
          id: randomUUID(),
          type: 'message_queue',
          operation: 'clear',
          createdAt: new Date().toISOString(),
        })
      }

      this.sessionId = nextSessionId
      this.replaceSnapshot([...replayMessageQueue(records), ...pending])
    })
  }

  private replaceSnapshot(messages: readonly QueuedMessage[]): void {
    const next = messages.length === 0 ? EMPTY_SNAPSHOT : Object.freeze([...messages])
    if (sameMessages(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation)
    this.operationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * Rebuilds the pending queue from a session log.
 *
 * Two things remove a message: its own `dequeue` record, and a user message
 * record that names it as its source. The second covers the crash window in the
 * hand-off — the user record is written first, the `dequeue` after — so a
 * message that was already sent is not sent again on the next start. Collected
 * up front because the user record is written after the `enqueue` it answers,
 * and a rolled-back turn takes its user record with it, which is exactly when
 * the queued message should come back.
 */
export function replayMessageQueue(records: readonly SessionRecord[]): QueuedMessage[] {
  const pending: QueuedMessage[] = []
  const ids = new Set<string>()
  const alreadySent = new Set<string>()
  for (const record of records) {
    if (record.type === 'message' && record.sourceQueuedMessageId) {
      alreadySent.add(record.sourceQueuedMessageId)
    }
  }

  for (const record of records) {
    if (record.type !== 'message_queue') continue
    if (record.operation === 'clear') {
      pending.length = 0
      ids.clear()
      continue
    }
    if (record.operation === 'enqueue') {
      if (!isValidQueuedMessage(record.message) || ids.has(record.message.id)) continue
      if (alreadySent.has(record.message.id)) continue
      pending.push(Object.freeze({ ...record.message }))
      ids.add(record.message.id)
      continue
    }
    const index = pending.findIndex((message) => message.id === record.messageId)
    if (index >= 0) {
      ids.delete(record.messageId)
      pending.splice(index, 1)
    }
  }
  return pending
}

function sameMessages(left: readonly QueuedMessage[], right: readonly QueuedMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const other = right[index]
    return other !== undefined
      && message.id === other.id
      && message.content === other.content
      && message.priority === other.priority
      && message.createdAt === other.createdAt
      && message.origin === other.origin
      && sameImages(message.images, other.images)
  })
}

/**
 * Refs compare by value: hydrate rebuilds the arrays from records, so identity
 * comparison would fire listeners on every replay, while skipping the field
 * entirely would miss a message whose images changed between snapshots.
 */
function sameImages(left: readonly ImageAttachmentRef[] | undefined, right: readonly ImageAttachmentRef[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  return left.every((ref, index) => {
    const other = right[index]
    return other !== undefined
      && ref.id === other.id
      && ref.ownerSessionId === other.ownerSessionId
      && ref.name === other.name
      && ref.mimeType === other.mimeType
      && ref.width === other.width
      && ref.height === other.height
      && ref.byteLength === other.byteLength
  })
}

function isValidQueuedMessage(value: PersistedQueuedMessage): boolean {
  return typeof value?.id === 'string'
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string'
    && (value.priority === 'now' || value.priority === 'next' || value.priority === 'later')
    && (value.origin === undefined || value.origin === 'coordinator')
    && (value.images === undefined || (Array.isArray(value.images) && value.images.every(isValidImageRef)))
}

function isValidImageRef(ref: ImageAttachmentRef): boolean {
  return typeof ref?.id === 'string'
    && typeof ref.ownerSessionId === 'string'
    && typeof ref.name === 'string'
    && typeof ref.mimeType === 'string'
    && typeof ref.width === 'number'
    && typeof ref.height === 'number'
    && typeof ref.byteLength === 'number'
}
