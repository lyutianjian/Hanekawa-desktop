/**
 * Values the `Bash` tool enforces and its description quotes.
 *
 * They live apart from `bash.ts` so `bashPrompt.ts` can read them without
 * importing the tool module that imports the prompt back.
 */

export const DEFAULT_BASH_TIMEOUT_MS = 60_000
/** `setTimeout`'s own ceiling (~24.8 days); a longer delay fires at once. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Minimum sleep duration (seconds) that triggers the blocked-sleep pattern.
 * Sleep commands below this threshold are allowed without run_in_background.
 */
export const SLEEP_BLOCK_THRESHOLD_SECONDS = 2

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve the effective foreground timeout.
 * - explicit tool input wins
 * - else MYAGENT_BASH_DEFAULT_TIMEOUT_MS / BASH_DEFAULT_TIMEOUT_MS
 * - else 60s
 * No max unless MYAGENT_BASH_MAX_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS sets one (at least default).
 */
export function resolveBashTimeoutMs(requested?: number, env: NodeJS.ProcessEnv = process.env): number {
  const envDefault =
    parsePositiveInt(env.MYAGENT_BASH_DEFAULT_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_DEFAULT_TIMEOUT_MS)
  const envMax =
    parsePositiveInt(env.MYAGENT_BASH_MAX_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_MAX_TIMEOUT_MS)

  const defaultMs = envDefault ?? DEFAULT_BASH_TIMEOUT_MS
  const maxMs = Math.min(MAX_TIMER_MS, envMax === undefined ? MAX_TIMER_MS : Math.max(defaultMs, envMax))
  const raw = requested ?? defaultMs
  return Math.min(Math.max(1, raw), maxMs)
}
