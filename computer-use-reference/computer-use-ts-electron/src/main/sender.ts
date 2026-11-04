import { AutomationError } from '../shared/errors';
// Extracted predicate allows testing without loading Electron or opening a window.
export function assertSender(input: { senderId: number; ownerId: number; isMainFrame: boolean; url: string }): void {
  if (input.senderId !== input.ownerId || !input.isMainFrame || input.url !== 'cu-app://ui/index.html') {
    throw new AutomationError('NOT_AUTHORIZED', 'IPC sender is not the application main frame');
  }
}
