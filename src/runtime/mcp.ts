import {
  connectManagedMcpServer,
  getMcpTimeoutMs,
  loadMcpConfig,
  wrapMcpTool,
} from '../services/mcp/index.js'
import type { ManagedMcpClient, ManagedMcpClientOptions, McpServerConfig, McpTool } from '../services/mcp/index.js'
import { trustMcpServerLocally } from '../config/settings.js'
import type { MyAgentSettings } from '../config/settings.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { McpConnectionStatus } from './types.js'

export interface ConnectMcpServersOptions {
  cwd: string
  settings: MyAgentSettings
  registry: ToolRegistry
  /** Asked once per untrusted server. Must run before any UI owns stdin. */
  confirmTrust: (name: string, server: McpServerConfig) => Promise<boolean>
  /** Emits the `mcp_connect_failed` metric; also called on reconnect failures. */
  onConnectFailure: (name: string, error: string) => Promise<void>
  /**
   * Seam for tests: the real connection spawns a child process, so the startup
   * failure paths (a server that connects but cannot list its tools, a close
   * that fails while unwinding) are only reachable by substituting it.
   */
  connect?: (config: McpServerConfig, options?: ManagedMcpClientOptions) => Promise<ManagedMcpClient>
}

export interface ConnectMcpServersResult {
  clients: ManagedMcpClient[]
  status: McpConnectionStatus
}

/**
 * Connects every configured MCP server and publishes its tools into the
 * registry. Fail-open: a server that cannot be trusted or connected is
 * reported in `status.failed` and never blocks startup.
 */
export async function connectMcpServers(
  options: ConnectMcpServersOptions,
): Promise<ConnectMcpServersResult> {
  const { cwd, settings, registry, confirmTrust, onConnectFailure } = options
  const connect = options.connect ?? connectManagedMcpServer
  const mcpConfig = await loadMcpConfig(cwd, settings)
  const clients: ManagedMcpClient[] = []
  const status: McpConnectionStatus = { connected: [], failed: [] }
  const trustedServers = new Set(settings.mcp?.trustedServers ?? [])

  const recordFailure = async (name: string, error: string) => {
    status.failed.push({ name, error })
    await onConnectFailure(name, error)
  }

  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    // Held outside the try: a server that connected but then failed to list its
    // tools already owns a child process, and only `clients` is closed at
    // shutdown — so this loop is the one place that can still dispose of it.
    let manager: ManagedMcpClient | undefined
    try {
      if (!trustedServers.has(name)) {
        const trusted = await confirmTrust(name, serverConfig)
        if (!trusted) {
          await recordFailure(name, 'not trusted')
          continue
        }
        await trustMcpServerLocally(cwd, name)
        trustedServers.add(name)
      }

      const timeoutMs = getMcpTimeoutMs(serverConfig)
      const connected: ManagedMcpClient = await connect(serverConfig, {
        onReconnect: async (client) => {
          // List through the fresh client, but invoke through the stable
          // manager wrapper.
          await refreshMcpServerTools(name, client, connected, timeoutMs, registry)
        },
        onToolsChanged: (_client, tools) => {
          setMcpServerTools(name, tools, connected, registry)
        },
        onReconnectFailed: async (error) => {
          await onConnectFailure(name, error.message)
        },
      })
      manager = connected
      await refreshMcpServerTools(name, connected, connected, timeoutMs, registry)
      // Ownership transfers only now, with a full connection and its tools
      // published: from here the shutdown path closes it.
      clients.push(connected)
      manager = undefined
      status.connected.push({ name, toolCount: registry.serverToolCount(name) })
    } catch (error) {
      // Undo the attempt before reporting it: a half-registered server would
      // keep serving tools whose process is gone, and a leaked process would
      // outlive the runtime. A cleanup failure is recorded on its own so it
      // cannot hide the error that actually broke the connection.
      if (manager) {
        registry.removeServerTools(name)
        try {
          await manager.close()
        } catch (closeError) {
          status.failed.push({
            name,
            error: `failed to close after a startup error: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          })
        }
      }
      await recordFailure(name, error instanceof Error ? error.message : String(error))
    }
  }

  return { clients, status }
}

export async function refreshMcpServerTools(
  name: string,
  client: Pick<ManagedMcpClient, 'listTools'>,
  toolClient: ManagedMcpClient,
  timeoutMs: number,
  registry: ToolRegistry,
): Promise<void> {
  const listed = await client.listTools(undefined, { timeout: timeoutMs })
  setMcpServerTools(name, listed.tools, toolClient, registry)
}

export function setMcpServerTools(
  name: string,
  listedTools: Awaited<ReturnType<ManagedMcpClient['listTools']>>['tools'],
  toolClient: ManagedMcpClient,
  registry: ToolRegistry,
): void {
  const mcpTools: McpTool[] = listedTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    annotations: t.annotations as Record<string, unknown> | undefined,
  }))
  registry.setServerTools(name, mcpTools.map((mcpTool) => wrapMcpTool(name, mcpTool, toolClient)))
}
