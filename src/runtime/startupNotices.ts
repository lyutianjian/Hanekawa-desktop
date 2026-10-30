import { summarizeDiagnosticsForTui } from '../harness/diagnostics.js'
import type { McpConnectionStatus, RuntimeHost } from './types.js'

/**
 * One-shot facts a shell shows once, right after it attaches.
 *
 * These are startup state, not events: they are computed from the host that
 * already booted, so they ride along on the `hello` reply rather than becoming
 * `HostEvent`s. A terminal maps them onto its transcript items and a renderer
 * onto whatever it uses; neither display type reaches the wire.
 */
export interface StartupNotice {
  level: 'info' | 'warning'
  content: string
}

/** Lifted verbatim from the TUI entrypoint so both shells word this the same. */
export function formatMcpStatus(status: McpConnectionStatus): string | undefined {
  const parts: string[] = []
  if (status.connected.length > 0) {
    parts.push(`MCP connected: ${status.connected.map((s) => `${s.name} (${s.toolCount} tools)`).join(', ')}`)
  }
  if (status.failed.length > 0) {
    parts.push(`MCP failed: ${status.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`)
  }
  return parts.length > 0 ? parts.join(' | ') : undefined
}

export function buildStartupNotices(
  host: Pick<RuntimeHost, 'diagnostics' | 'mcp'>,
): StartupNotice[] {
  const notices: StartupNotice[] = []
  const diagnostics = summarizeDiagnosticsForTui(host.diagnostics)
  if (diagnostics) notices.push({ level: 'warning', content: diagnostics })
  for (const diagnostic of host.diagnostics) {
    if (diagnostic.code === 'project_data_migration_failed' || diagnostic.code === 'agent_definition') notices.push({ level: 'warning', content: diagnostic.message })
  }
  const mcp = formatMcpStatus(host.mcp)
  if (mcp) notices.push({ level: 'info', content: mcp })
  return notices
}

/**
 * The interrupted-turn resume prompt. Env-driven and host-side: a client must
 * not be able to ask for it, and the host already knows whether the last turn
 * left something to continue.
 */
export function resolveInitialQueuedPrompt(
  hasRecoverableInterruption: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!env.HANEKAWA_RESUME_INTERRUPTED_TURN) return undefined
  return hasRecoverableInterruption ? 'continue' : undefined
}
