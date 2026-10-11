/**
 * Visual presence only. An intent settles business actions and focus immediately;
 * closing merely keeps pixels around until they can leave continuously. In
 * particular, permission and dialog replies must never wait for this state machine.
 * The DOM owns events/timers and rejects callbacks from superseded intents.
 */
export type Phase = 'closed' | 'entering' | 'open' | 'closing'
export type PresenceEvent = 'intent' | 'settled'

export function nextPhase(current: Phase, want: boolean, event: PresenceEvent): Phase {
  if (event === 'intent') {
    if (want) return current === 'open' ? 'open' : 'entering'
    return current === 'closed' ? 'closed' : 'closing'
  }
  if (current === 'entering') return want ? 'open' : current
  if (current === 'closing') return want ? current : 'closed'
  return current
}

export function isMounted(phase: Phase): boolean {
  return phase !== 'closed'
}

export function phaseClass(phase: Phase): string {
  return `presence-${phase}`
}

export type PresenceKind = 'popover' | 'panel' | 'disclosure' | 'layout' | 'backdrop'

/** CSS duration plus 60ms event-delivery slack; pinned to the sheet by token tests. */
export const PRESENCE_FALLBACK_MS: Readonly<Record<PresenceKind, number>> = {
  popover: 260,
  panel: 360,
  disclosure: 260,
  layout: 340,
  backdrop: 260,
}
