export interface RuntimeDiagnostic {
  code: string
  severity: 'info' | 'warning'
  message: string
}

export function formatDiagnostic(diagnostic: RuntimeDiagnostic): string {
  return `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}`
}

export function logDiagnostics(diagnostics: RuntimeDiagnostic[]): void {
  if (diagnostics.length === 0 || process.env.HANEKAWA_DEBUG_PROVIDER !== '1') return
  for (const diagnostic of diagnostics) {
    console.error(`[hanekawa][diagnostic] ${formatDiagnostic(diagnostic)}`)
  }
}

export function summarizeDiagnosticsForTui(diagnostics: RuntimeDiagnostic[]): string | undefined {
  const malformed = count(diagnostics, 'malformed_jsonl')
  const legacy = count(diagnostics, 'legacy_session_migrated')
  const checkpoint = count(diagnostics, 'checkpoint_migrated')
  const repairedTools = count(diagnostics, 'tool_protocol_repaired')

  const parts: string[] = []
  if (malformed > 0) parts.push(`skipped ${malformed} malformed JSONL line${malformed === 1 ? '' : 's'}`)
  if (legacy > 0) parts.push(`migrated ${legacy} legacy session${legacy === 1 ? '' : 's'}`)
  if (checkpoint > 0) parts.push(`migrated checkpoint metadata`)
  if (repairedTools > 0) parts.push(`repaired ${repairedTools} tool record${repairedTools === 1 ? '' : 's'}`)

  return parts.length > 0 ? `Session repaired: ${parts.join(', ')}.` : undefined
}

function count(diagnostics: RuntimeDiagnostic[], code: string): number {
  return diagnostics.filter((diagnostic) => diagnostic.code === code).length
}
