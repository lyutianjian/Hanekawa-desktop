import {
  turnCompletionNotificationEnabled,
  type InteractionNotificationKind,
  type NotificationSettings,
} from '../config/notifications.js'
import type { SessionEvent } from '../runtime/sessionController.js'

interface NativeNotice {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
  close(): void
}

/** Owns native notification lifetimes; OS calls stay in the main-process port. */
export class SystemNotifications {
  private settings: NotificationSettings = {}
  private readonly live = new Map<NativeNotice, 'completion' | 'interaction' | 'coordination'>()
  private disposed = false

  constructor(private readonly port: {
    focused(): boolean
    supported(): boolean
    create(options: { title: string; body: string }): NativeNotice
    attention(): void
    error(error: unknown): void
  }) {}

  preferences(): NotificationSettings { return this.settings }

  setPreferences(settings: NotificationSettings): void {
    this.settings = { ...settings }
    if (!turnCompletionNotificationEnabled(this.settings, this.port.focused())) {
      for (const [notice, kind] of this.live) {
        if (kind === 'completion') { this.live.delete(notice); notice.close() }
      }
    }
  }

  turnEnded(event: SessionEvent, title: string, activate: () => void): void {
    if (event.type !== 'turn-end' || event.failed || event.aborted || event.rolledBack) return
    if (!turnCompletionNotificationEnabled(this.settings, this.port.focused())) return
    this.show('completion', { title: 'Hanekawa · 轮次完成', body: title || '会话已完成本轮回复。' }, activate)
  }

  interaction(kinds: readonly InteractionNotificationKind[], title: string, activate: () => void, closed: () => void): NativeNotice | undefined {
    const both = kinds.includes('permission') && kinds.includes('question')
    const subject = title ? `「${title}」` : '有会话'
    return this.show('interaction', {
      title: both ? 'Hanekawa 需要你处理' : kinds.includes('permission') ? 'Hanekawa 需要权限确认' : 'Hanekawa 有问题需要回答',
      body: `${subject}${both ? '正在等待权限确认或回答。' : kinds.includes('permission') ? '正在等待你批准操作。' : '正在等待你的回答。'}点击前往处理。`,
    }, activate, closed)
  }

  coordination(title: string, body: string, activate: () => void): void {
    this.show('coordination', { title, body }, activate)
  }

  private show(kind: 'completion' | 'interaction' | 'coordination', options: { title: string; body: string }, activate: () => void, closed?: () => void): NativeNotice | undefined {
    if (this.disposed) return undefined
    let notice: NativeNotice | undefined
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (notice) this.live.delete(notice)
      closed?.()
    }
    const failed = (error: unknown): void => {
      release()
      this.port.error(error)
      if (kind === 'interaction') this.port.attention()
    }
    try {
      if (!this.port.supported()) {
        if (kind === 'interaction') this.port.attention()
        return undefined
      }
      notice = this.port.create(options)
      const current = notice
      this.live.set(current, kind)
      current.on('close', release)
      current.on('failed', () => failed(new Error('系统未能显示通知，请检查系统通知权限与应用安装/签名。')))
      current.on('click', () => {
        release()
        current.close()
        if (!this.disposed) activate()
      })
      current.show()
      return released ? undefined : current
    } catch (error) {
      failed(error)
      return undefined
    }
  }

  dispose(): void {
    this.disposed = true
    for (const notice of this.live.keys()) notice.close()
    this.live.clear()
  }
}
