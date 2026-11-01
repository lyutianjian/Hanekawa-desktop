export interface WorkActivity {
  isActive(): boolean
  subscribe(listener: () => void): () => void
}

export interface PowerSavePort {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): unknown
}

/** One process-owned request, independent of window visibility. */
export class PowerSaveController {
  private readonly sources = new Map<object, { activity: WorkActivity; off: () => void }>()
  private needed = false
  private enabled = true
  private id: number | undefined
  private disposed = false

  constructor(
    private readonly port: PowerSavePort,
    private readonly log: (message: string, error?: unknown) => void,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.refresh()
  }

  watch(key: object, activity: WorkActivity): () => void {
    if (this.disposed) return () => {}
    this.sources.get(key)?.off()
    const off = activity.subscribe(() => this.refresh())
    this.sources.set(key, { activity, off })
    this.refresh()
    return () => this.unwatch(key)
  }

  unwatch(key: object): void {
    const source = this.sources.get(key)
    if (!source) return
    source.off()
    this.sources.delete(key)
    this.refresh()
  }

  private refresh(): void {
    if (this.disposed) return
    const needed = this.enabled && this.hasWork()
    if (needed === this.needed) return
    this.needed = needed
    this.log(`活动${needed ? '开始' : '结束'}（${this.sources.size} 个来源）`)
    if (needed) this.start()
    else this.stop()
  }

  private hasWork(): boolean {
    return [...this.sources.values()].some(({ activity }) => activity.isActive())
  }

  /** A real system resume invalidates a native request even if Electron kept its ID. */
  resume(): void {
    if (this.disposed) return
    this.log('系统恢复，重新核对防休眠请求')
    this.needed = this.enabled && this.hasWork()
    this.stop()
    if (this.needed) this.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { off } of this.sources.values()) off()
    this.sources.clear()
    this.needed = false
    this.stop()
  }

  private start(): void {
    if (this.id !== undefined) return
    try {
      this.id = this.port.start('prevent-app-suspension')
      this.log(`申请防休眠 ID ${this.id}`)
    } catch (error) {
      this.log('申请防休眠失败，本次任务不能保证阻止闲置睡眠', error)
    }
  }

  private stop(): void {
    if (this.id === undefined) return
    try {
      this.port.stop(this.id)
      this.log(`释放防休眠 ID ${this.id}`)
      this.id = undefined
    } catch (error) {
      // Keep ownership so a later activity edge or resume cannot create a second request.
      this.log('释放防休眠失败', error)
    }
  }
}
