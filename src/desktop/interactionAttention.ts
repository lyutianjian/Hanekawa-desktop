import type { InteractionNotificationKind } from '../config/notifications.js'

interface PendingNotice {
  id: string
  kind: InteractionNotificationKind
  title?: string
}

interface PendingInteraction {
  pending(): readonly PendingNotice[]
  subscribe(listener: () => void): () => void
  activate(): void
}

export interface AttentionNotice {
  close(): void
}

/** Coalesces unfocused-window prompts; a click reads the current waiting lanes. */
export class InteractionAttention {
  private readonly sources = new Map<object, { interaction: PendingInteraction; off: () => void }>()
  private readonly reminded = new Set<string>()
  private noticeIds: string[] = []
  private notice: AttentionNotice | undefined
  private scheduled = false
  private disposed = false

  constructor(private readonly port: {
    unfocused(): boolean
    enabled(kind: InteractionNotificationKind): boolean
    show(): void
    notify(kinds: readonly InteractionNotificationKind[], title: string, click: () => void, closed: () => void): AttentionNotice | undefined
    schedule(callback: () => void): void
  }) {}

  watch(key: object, interaction: PendingInteraction): () => void {
    const off = interaction.subscribe(() => this.refresh())
    this.sources.set(key, { interaction, off })
    this.refresh()
    return () => {
      off()
      this.sources.delete(key)
      this.refresh()
    }
  }

  refresh(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    this.port.schedule(() => {
      this.scheduled = false
      if (this.disposed) return
      const pending = [...this.sources.values()].flatMap(({ interaction }) => interaction.pending())
      const waiting = pending.filter(({ kind }) => this.port.enabled(kind))
      for (const id of this.reminded) {
        if (!pending.some((request) => request.id === id)) this.reminded.delete(id)
      }
      if (!this.port.unfocused() || waiting.length === 0) {
        this.closeNotice()
        return
      }
      if (this.notice && this.noticeIds.some((id) => !waiting.some((request) => request.id === id))) this.closeNotice()
      if (this.notice || waiting.every(({ id }) => this.reminded.has(id))) return
      this.noticeIds = waiting.map(({ id }) => id)
      for (const id of this.noticeIds) this.reminded.add(id)
      const title = [...new Set(waiting.map((request) => request.title).filter(Boolean))].slice(0, 2).join('、')
      let notice: AttentionNotice | undefined
      notice = this.port.notify([...new Set(waiting.map(({ kind }) => kind))], title, () => {
        if (this.disposed) return
        this.closeNotice()
        this.port.show()
        for (const { interaction } of this.sources.values()) {
          if (interaction.pending().some(({ kind }) => this.port.enabled(kind))) {
            interaction.activate()
            break
          }
        }
      }, () => {
        if (this.notice === notice) { this.notice = undefined; this.refresh() }
      })
      this.notice = notice
    })
  }

  private closeNotice(): void {
    const notice = this.notice
    this.notice = undefined
    notice?.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { off } of this.sources.values()) off()
    this.sources.clear()
    this.reminded.clear()
    this.closeNotice()
  }
}
