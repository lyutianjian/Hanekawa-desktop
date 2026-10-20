import { grepTool } from './GrepTool/GrepTool.js'
import { globTool } from './GlobTool/GlobTool.js'
import { createBashTool } from './BashTool/BashTool.js'
import { createKillShellTool } from './KillShellTool/KillShellTool.js'
import { createMonitorTool } from './MonitorTool/MonitorTool.js'
import { readFileTool } from './FileReadTool/FileReadTool.js'
import { writeFileTool } from './FileWriteTool/FileWriteTool.js'
import { editFileTool } from './FileEditTool/FileEditTool.js'
import { multiEditTool } from './MultiEditTool/MultiEditTool.js'
import { deleteFileTool } from './FileDeleteTool/FileDeleteTool.js'
import { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js'
import { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js'
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js'
import { createSkillTool } from './SkillTool/SkillTool.js'
import { taskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { taskGetTool } from './TaskGetTool/TaskGetTool.js'
import { taskListTool } from './TaskListTool/TaskListTool.js'
import { taskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js'
import { toolSearchTool } from './ToolSearchTool/ToolSearchTool.js'
import { webFetchTool } from './WebFetchTool/WebFetchTool.js'
import { webSearchTool } from './WebSearchTool/WebSearchTool.js'
import { configTool } from './ConfigTool/ConfigTool.js'
import { notebookEditTool } from './NotebookEditTool/NotebookEditTool.js'
import { createSendMessageTool } from './SendMessageTool/SendMessageTool.js'
import { isToolSearchEnabled, isDeferredTool } from '../utils/toolSearch.js'
import type { Tool } from '../harness/types.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'

export function getBuiltinTools(backgroundTasks?: BackgroundTaskRegistry): Tool[] {
  return [grepTool, globTool, createBashTool(backgroundTasks), createKillShellTool(backgroundTasks), createMonitorTool(backgroundTasks), readFileTool, writeFileTool, editFileTool, multiEditTool, deleteFileTool, enterPlanModeTool, exitPlanModeTool, askUserQuestionTool, createSendMessageTool(backgroundTasks), taskCreateTool, taskListTool, taskGetTool, taskUpdateTool, webFetchTool, webSearchTool, configTool, notebookEditTool]
}

export async function getAllTools(backgroundTasks?: BackgroundTaskRegistry): Promise<Tool[]> {
  const builtinTools = getBuiltinTools(backgroundTasks)
  const tools: Tool[] = [...builtinTools, createSkillTool()]

  if (isToolSearchEnabled()) {
    tools.push(toolSearchTool)
  }

  return tools
}

/**
 * Get tools that should be fully loaded (non-deferred) in the system prompt.
 * When tool search is active, this excludes MCP and shouldDefer tools.
 */
export function getActiveTools(allTools: Tool[]): Tool[] {
  if (!isToolSearchEnabled()) return allTools
  return allTools.filter(t => !isDeferredTool(t))
}

/**
 * Get tools that are deferred (require ToolSearch to load).
 */
export function getDeferredTools(allTools: Tool[]): Tool[] {
  if (!isToolSearchEnabled()) return []
  return allTools.filter(isDeferredTool)
}
