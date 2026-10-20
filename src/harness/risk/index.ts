import path from 'node:path'
import type { Tool } from '../types.js'
import { isPreapprovedUrl, urlHostname } from '../../utils/permissions/webFetchDomains.js'
import { classifyBash } from './bash.js'
import { classifyPath } from './paths.js'
import { maxTier, tierRank, type RiskAssessment, type RiskContext, type RiskReason, type RiskTier } from './types.js'

export { createRiskContext } from './paths.js'
export type { RiskAssessment, RiskContext, RiskReason, RiskTier } from './types.js'

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Delete'])
/** Tools that run their `command` in the shell, graded and governed as Bash. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor'])

type ClassifiableTool = Pick<Tool, 'name' | 'riskLevel' | 'isReadOnly' | 'isReadOnlyInput' | 'classifyRisk'>

/**
 * The risk of one tool call, independent of the permission mode. Pure apart
 * from reading the filesystem to resolve symlinks and expand globs.
 */
export function classifyToolCall(tool: ClassifiableTool, input: unknown, ctx: RiskContext): RiskAssessment {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {}

  if (SHELL_TOOLS.has(tool.name)) {
    const command = typeof fields.command === 'string' ? fields.command : ''
    const bash = classifyBash(command, ctx)
    return assessment(bash.reasons, false, bash.readPaths, bash.writePaths, bash.commands)
  }

  if (READ_TOOLS.has(tool.name) || WRITE_TOOLS.has(tool.name)) {
    const write = WRITE_TOOLS.has(tool.name)
    const raw = filePathOf(fields)
    if (raw === undefined && write) {
      return assessment([{ level: 'normal', code: 'write', message: `${tool.name} writes a file.` }], true, [], [])
    }
    // The file tools resolve against the workspace and never expand `~`.
    const abs = path.resolve(ctx.cwd, raw ?? '.')
    const reasons = classifyPath({ raw: raw ?? '.', abs }, write ? 'write' : 'read', ctx)
    return assessment(reasons, write, write ? [] : [abs], write ? [abs] : [])
  }

  if (tool.name === 'WebFetch') {
    const url = typeof fields.url === 'string' ? fields.url : ''
    if (isPreapprovedUrl(url)) return assessment([], false, [], [])
    return assessment([{ level: 'normal', code: 'network', message: `Fetches ${urlHostname(url) || 'a URL'}.` }], false, [], [])
  }

  const level = tool.classifyRisk?.(input, ctx) ?? metadataTier(tool, input)
  const reasons: RiskReason[] = level === 'readonly'
    ? []
    : [{ level, code: 'tool', message: level === 'risky' ? `${tool.name} is marked dangerous.` : `Uses ${tool.name}.` }]
  return assessment(reasons, false, [], [])
}

function metadataTier(tool: ClassifiableTool, input: unknown): RiskTier {
  if (tool.isReadOnlyInput?.(input) ?? tool.isReadOnly === true) return 'readonly'
  if (tool.riskLevel === 'safe') return 'readonly'
  return tool.riskLevel === 'dangerous' ? 'risky' : 'normal'
}

function filePathOf(fields: Record<string, unknown>): string | undefined {
  for (const key of ['filePath', 'file_path', 'path', 'notebook_path']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function assessment(reasons: RiskReason[], isFileWrite: boolean, readPaths: string[], writePaths: string[], commands: string[] = []): RiskAssessment {
  const seen = new Set<string>()
  const unique = reasons.filter((reason) => {
    const key = `${reason.code}\0${reason.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => tierRank(b.level) - tierRank(a.level))
  const level = unique.reduce<RiskTier>((highest, reason) => maxTier(highest, reason.level), 'readonly')
  return { level, reasons: unique, isFileWrite, readPaths, writePaths, commands }
}
