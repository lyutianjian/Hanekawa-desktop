type DesktopEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'
interface DesktopMonitor {
  on(event: DesktopEvent, listener: () => void): unknown
  removeListener(event: DesktopEvent, listener: () => void): unknown
  getSystemIdleState(idleThreshold: number): string
}
interface DesktopControl {
  setDesktopUnavailable(reason: 'suspended' | 'locked', unavailable: boolean): void
}

/** Subscribe after Electron readiness; visibility is not desktop availability. */
export function watchComputerDesktop(host: DesktopControl, monitor: DesktopMonitor): () => void {
  const handlers: Record<DesktopEvent, () => void> = {
    suspend: () => host.setDesktopUnavailable('suspended', true),
    resume: () => {
      const state = monitor.getSystemIdleState(1)
      if (state !== 'unknown') host.setDesktopUnavailable('locked', state === 'locked')
      host.setDesktopUnavailable('suspended', false)
    },
    'lock-screen': () => host.setDesktopUnavailable('locked', true),
    'unlock-screen': () => host.setDesktopUnavailable('locked', false),
  }
  for (const event of Object.keys(handlers) as DesktopEvent[]) monitor.on(event, handlers[event])
  if (monitor.getSystemIdleState(1) === 'locked') handlers['lock-screen']()
  return () => {
    for (const event of Object.keys(handlers) as DesktopEvent[]) monitor.removeListener(event, handlers[event])
  }
}
