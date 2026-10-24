/**
 * API model id → its configured key, which is the model's display name.
 *
 * Records, metrics and subagent runs carry the API id the request went out
 * with; this maps it back when drawn, so old history follows a rename too. An
 * id configured under several keys takes the first; an id no longer configured
 * reads as itself.
 */
let names: ReadonlyMap<string, string> = new Map()

export function setModelNames(models: readonly { key: string; model?: string }[]): void {
  const next = new Map<string, string>()
  for (const { key, model } of models) {
    if (model !== undefined && !next.has(model)) next.set(model, key)
  }
  names = next
}

export function modelName(id: string): string {
  return names.get(id) ?? id
}
