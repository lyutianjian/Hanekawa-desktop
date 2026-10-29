import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MyAgentSettings } from '../../config/settings.js'
import type { McpServerConfig } from './types.js'

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

/**
 * The configured servers: the merged settings when a caller has them, and
 * otherwise the two files `loadSettingsLayers` reads as one layer —
 * `.myagent/mcp.json`, then `.mcp.json` (Claude Code's) underneath it.
 */
export async function loadMcpConfig(cwd: string, settings?: MyAgentSettings): Promise<Record<string, McpServerConfig>> {
  if (settings) return { ...(settings.mcpServers ?? {}) }

  // Legacy fallback for callers that have not loaded merged settings yet.
  const [compat, owned] = await Promise.all([
    readServersFile(join(cwd, '.mcp.json')),
    readServersFile(join(cwd, '.myagent', 'mcp.json')),
  ])
  return { ...compat, ...owned }
}

async function readServersFile(filePath: string): Promise<Record<string, McpServerConfig> | undefined> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    console.warn(`Failed to read MCP config at ${filePath}:`, (error as Error).message)
    return undefined
  }
  try {
    const config = JSON.parse(content) as McpConfig
    return config.mcpServers
  } catch (error) {
    console.warn(`Failed to parse MCP config at ${filePath}:`, (error as Error).message)
    return undefined
  }
}