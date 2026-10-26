import type { CoordinationRole, Tool } from '../harness/types.js'
import { toolAvailableForRole } from './sessionRole.js'

/** The per-runtime Agent tool is not part of `baseTools`; see `refresh`. */
const AGENT_TOOL_NAME = 'Agent'

/**
 * Owns the tool set shared by every live runtime: the built-in tools plus the
 * tools currently exposed by each connected MCP server.
 *
 * The load-bearing detail is **array identity**. A runtime's tool array is
 * captured by three collaborators that cannot be re-pointed afterwards — the
 * Agent tool's `tools: () => runtimeTools` closure, `ToolRunner`, and
 * `AgentLoop`. So when an MCP server reconnects or changes its tool list, the
 * registry rewrites every registered array *in place* with `splice` rather
 * than handing out a new one.
 */
export class ToolRegistry {
  private readonly baseTools: readonly Tool[]
  private readonly toolsByServer = new Map<string, Tool[]>()
  private readonly runtimeToolSets = new Map<Tool[], { role?: CoordinationRole; overrides: readonly Tool[] }>()

  constructor(baseTools: readonly Tool[]) {
    this.baseTools = baseTools
  }

  /**
   * A fresh array of the currently known tools. The caller appends its
   * per-runtime Agent tool and then calls `register` to keep it in sync.
   */
  buildRuntimeTools(role?: CoordinationRole): Tool[] {
    return [...this.baseFor(role), ...[...this.toolsByServer.values()].flat()]
  }

  /** Starts tracking `tools`; later MCP changes rewrite it in place. */
  register(tools: Tool[], role?: CoordinationRole, overrides: readonly Tool[] = []): void {
    this.runtimeToolSets.set(tools, { role, overrides })
  }

  /** Stops tracking `tools`. Called from `AgentSession.dispose`. */
  unregister(tools: Tool[]): void {
    this.runtimeToolSets.delete(tools)
  }

  /**
   * Replaces one server's tools and propagates the change to every registered
   * runtime. Replacement, not merge: a server that reports fewer tools loses
   * the missing ones, and a server that never reports keeps its last set.
   */
  setServerTools(name: string, tools: Tool[]): void {
    this.toolsByServer.set(name, tools)
    this.refresh()
  }

  serverToolCount(name: string): number {
    return this.toolsByServer.get(name)?.length ?? 0
  }

  /**
   * Forgets a server entirely and propagates the removal.
   *
   * Distinct from `setServerTools(name, [])`, which keeps an empty entry: a
   * server dropped from the settings has to stop being a server, or a later
   * reconnect of a *different* server list still counts it.
   */
  removeServerTools(name: string): void {
    if (!this.toolsByServer.delete(name)) return
    this.refresh()
  }

  private baseFor(role: CoordinationRole | undefined): Tool[] {
    return this.baseTools.filter((tool) => toolAvailableForRole(tool, role))
  }

  private refresh(): void {
    const mcpTools = [...this.toolsByServer.values()].flat()
    for (const [tools, { role, overrides }] of this.runtimeToolSets) {
      // The Agent tool is built per runtime, so it is not in `baseTools` and has
      // to be lifted out and put back.
      //
      // Re-appending rather than restoring its old index is deliberate. A
      // freshly built runtime is `buildRuntimeTools()` + `push(agentTool)`, so
      // Agent is always last; reproducing that here keeps a runtime whose MCP
      // servers reconnected byte-identical to a new one. Preserving the old
      // index instead would leave Agent stranded mid-array on any runtime built
      // before a server connected, and tool order is part of the prompt-cache
      // key — the two runtimes would then cache differently.
      const agentTool = tools.find((tool) => tool.name === AGENT_TOOL_NAME)
      const baseTools = this.baseFor(role).map((tool) => overrides.find((override) => override.name === tool.name) ?? tool)
      tools.splice(0, tools.length, ...baseTools, ...mcpTools)
      if (agentTool) tools.push(agentTool)
    }
  }
}
