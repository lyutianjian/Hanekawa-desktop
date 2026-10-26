import path from 'node:path'
import { REDACTED_API_KEY, redactApiKeyFields } from '../config/apiKeys.js'
import { getGlobalMyAgentDir, normalizeCaseForComparison, resolveExistingPrefix } from '../utils/paths.js'

function isGlobalConfig(file: string): boolean {
  const target = normalizeCaseForComparison(resolveExistingPrefix(file))
  return ['config.json', 'settings.json'].some((name) =>
    target === normalizeCaseForComparison(resolveExistingPrefix(path.join(getGlobalMyAgentDir(), name))))
}

export function configFileView(file: string, content: string): string {
  return isGlobalConfig(file) ? redactApiKeyFields(content) : content
}

/** Match edits against the view; restore keys by their JSON location before writing. */
export function restoreConfigApiKeys(file: string, next: string, original?: string): string {
  if (!isGlobalConfig(file)) return next
  let previous: unknown
  try { previous = JSON.parse(original ?? '{}') } catch { previous = {} }
  if (!next.includes(REDACTED_API_KEY) && !original?.includes('"apiKey"')) return next
  let updated: unknown
  try { updated = JSON.parse(next) } catch { throw new Error('Configuration must be valid JSON to preserve hidden API keys. Edit only the fields you want to change.') }
  let changed = false
  const restore = (current: unknown, before: unknown): void => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return
    const object = current as Record<string, unknown>
    const old = before && typeof before === 'object' ? before as Record<string, unknown> : {}
    if (object.apiKey === REDACTED_API_KEY || (object.apiKey === undefined && typeof old.apiKey === 'string')) {
      if (typeof old.apiKey !== 'string' || old.apiKey === REDACTED_API_KEY) {
        throw new Error('No existing API key matches this placeholder. Keep the original endpoint/model name, or set its key in Settings.')
      }
      object.apiKey = old.apiKey
      changed = true
    }
    for (const [key, value] of Object.entries(object)) restore(value, old[key])
  }
  restore(updated, previous)
  if (!changed) return next
  const indent = next.match(/\n([ \t]+)"/)?.[1] ?? 2
  return JSON.stringify(updated, null, indent) + (next.endsWith('\n') ? '\n' : '')
}
