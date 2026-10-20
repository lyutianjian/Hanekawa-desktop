import { spawn } from 'node:child_process'
import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
} from '../../services/backgroundTasks/registry.js'
import { attachBackgroundLifecycle, buildSubprocessEnv, getShell } from '../BashTool/BashTool.js'
import { extractBashWritePaths } from '../BashTool/writeTargets.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { getToolResultSpillDir } from '../../utils/paths.js'
import {
  DEFAULT_MONITOR_TIMEOUT_MS,
  DESCRIPTION,
  MAX_MONITOR_TIMEOUT_MS,
  MONITOR_TOOL_NAME,
} from './prompt.js'

interface MonitorInput {
  command: string
  description: string
  timeout_ms?: number
  persistent?: boolean
}

export function createMonitorTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
    name: MONITOR_TOOL_NAME,
    description: DESCRIPTION,
    searchHint: 'watch a log, process or command; stream each output line as an event',
    shouldDefer: true,
    inputSchema: z.object({
      command: z.string().min(1).describe('Shell command or script. Each stdout line is an event; exit ends the watch.'),
      description: z.string().min(1).describe('Short, specific description of what is being monitored; labels every event.'),
      timeout_ms: z.number().int().min(1_000).max(MAX_MONITOR_TIMEOUT_MS).optional()
        .describe(`Kill the monitor after this many milliseconds (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}). Ignored when persistent is true.`),
      persistent: z.boolean().optional()
        .describe('Run until KillShell or session end, with no deadline.'),
    }).strict(),
    riskLevel: 'dangerous',
    isDestructive: true,
    concurrentWhenReadonly: true,
    userFacingName: () => MONITOR_TOOL_NAME,
    getToolUseSummary(input) {
      const description = (input as Partial<MonitorInput> | undefined)?.description
      return typeof description === 'string' ? description : null
    },
    getActivityDescription(input) {
      const description = (input as Partial<MonitorInput> | undefined)?.description
      return typeof description === 'string' && description.trim() ? `Monitoring ${description}` : 'Monitoring'
    },
    async execute(input, context) {
      const { command, description, timeout_ms, persistent } = input as MonitorInput
      for (const target of extractBashWritePaths(command, context.cwd)) {
        await trackFileEdit(context, target)
      }
      const { shell, args } = getShell()
      const proc = spawn(shell, args(command), {
        cwd: context.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildSubprocessEnv(),
      })
      const task = backgroundTasks.registerShell({
        sessionId: context.sessionId,
        command,
        proc,
        outputDir: getToolResultSpillDir(context.projectDir ?? context.cwd, context.sessionId),
        monitor: { description },
      })
      const timeout = timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS
      attachBackgroundLifecycle({
        proc,
        backgroundTasks,
        sessionId: context.sessionId,
        taskId: task.id,
        monitor: true,
        ...(persistent ? {} : { killAfterMs: timeout }),
      })
      return {
        ok: true,
        content: [
          `Monitor started (task ${task.id}, ${persistent ? 'persistent: runs until KillShell or session end' : `expires in ${timeout}ms unless the script exits first`}).`,
          ...(task.outputPath ? [`Full output, stderr included: ${task.outputPath}`] : []),
          'Events arrive at your next steps while you keep working; do not poll or sleep. Events that land after you end your turn wait for the user\'s next message.',
        ].join('\n'),
        metadata: {
          display: {
            summary: `monitor ${task.id} started`,
            detail: description,
          },
        },
      }
    },
  }
}
