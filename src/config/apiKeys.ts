export const REDACTED_API_KEY = '[REDACTED]'

const API_KEY_FIELD = /("apiKey"\s*:\s*)"((?:\\.|[^"\\])*)"/g

/** A view only: the application continues to hold and use the original keys. */
export function redactApiKeyFields(text: string): string {
  return text.replace(API_KEY_FIELD, (match, prefix: string, value: string) =>
    value ? `${prefix}"${REDACTED_API_KEY}"` : match)
}

/** Owned by one configuration service, never shared through module state. */
export class ApiKeyRedactor {
  private readonly keys = new Set<string>()

  rememberConfig(config: { models?: Record<string, { apiKey?: string }>; endpoints?: Record<string, { apiKey?: string }> }): void {
    for (const entry of [...Object.values(config.models ?? {}), ...Object.values(config.endpoints ?? {})]) {
      this.remember(entry?.apiKey)
    }
  }

  private remember(key: string | undefined): void {
    if (typeof key !== 'string' || !key || key === REDACTED_API_KEY) return
    this.keys.add(key)
    this.keys.add(JSON.stringify(key).slice(1, -1))
  }

  redact = (text: string): string => {
    const keys = [...this.keys].sort((a, b) => b.length - a.length)
    const masked = keys.length
      ? text.replace(new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), () => REDACTED_API_KEY)
      : text
    return redactApiKeyFields(masked)
  }
}

/** Tool results are JSON-shaped; leave non-text fields and the input object intact. */
export function redactOutput<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((item) => redactOutput(item, redact)) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactOutput(item, redact)])) as T
  }
  return value
}
