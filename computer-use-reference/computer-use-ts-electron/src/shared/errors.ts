import type { ErrorCode, Failure, Result } from './contracts';
export class AutomationError extends Error {
  constructor(public code: ErrorCode, message: string, public outcome: Failure['outcome'] = 'not-started') { super(message); }
}
export function failure(error: unknown): Failure {
  if (error instanceof AutomationError) return { code: error.code, message: error.message, outcome: error.outcome };
  // Do not return stacks, local paths, or arbitrary driver error payloads to the renderer.
  return { code: 'INTERNAL', message: 'Unexpected automation failure', outcome: 'unknown' };
}
export async function result<T>(run: () => T | Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, error: failure(error) }; }
}
