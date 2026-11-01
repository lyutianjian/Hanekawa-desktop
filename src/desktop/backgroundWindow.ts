export function shouldQuitAfterWindowsClosed(platform: string, recovering: boolean): boolean {
  return !['darwin', 'win32'].includes(platform) && !recovering
}

export function closeWindowAction(options: {
  platform: string
  quitting: boolean
  nativeInteraction: boolean
  trayAvailable: boolean
}): 'close' | 'hide' | 'keep' | 'tray-unavailable' {
  if (options.quitting || !['darwin', 'win32'].includes(options.platform)) return 'close'
  if (options.nativeInteraction) return 'keep'
  if (options.platform === 'win32' && !options.trayAvailable) return 'tray-unavailable'
  return 'hide'
}

export function focusBackgroundWindow(window: {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  isVisible(): boolean
  show(): void
  focus(): void
}): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}
