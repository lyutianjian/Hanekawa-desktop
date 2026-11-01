export const TURN_COMPLETION_NOTIFICATIONS = ['never', 'always', 'unfocused'] as const
export type TurnCompletionNotification = typeof TURN_COMPLETION_NOTIFICATIONS[number]

export interface NotificationSettings {
  turnCompletion?: TurnCompletionNotification
  permissions?: boolean
  questions?: boolean
}

export type InteractionNotificationKind = 'permission' | 'question'

export function interactionNotificationEnabled(settings: NotificationSettings, kind: InteractionNotificationKind): boolean {
  return kind === 'permission' ? settings.permissions !== false : settings.questions !== false
}

export function turnCompletionNotificationEnabled(settings: NotificationSettings, focused: boolean): boolean {
  const mode = settings.turnCompletion ?? 'unfocused'
  return mode === 'always' || (mode === 'unfocused' && !focused)
}
