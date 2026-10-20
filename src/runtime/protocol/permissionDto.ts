import { analyzeDestructiveCommands } from '../../harness/destructiveCommands.js'
import { SHELL_TOOLS } from '../../harness/risk/index.js'
import type { PermissionRequest } from '../../harness/permissions.js'
import {
  buildFileToolPreview,
  capFileToolPreview,
  type FileToolPreview,
  type FileToolPreviewLimits,
} from '../../services/fileToolPreview.js'
import type { PermissionRequestDto } from './wire.js'

export interface PermissionDtoOptions {
  /**
   * Required rather than defaulted to `process.cwd()`: a host may serve a
   * session rooted somewhere else entirely, and silently previewing against
   * the wrong tree is worse than a compile error.
   */
  cwd: string
  /** Overridable for tests; defaults to `PERMISSION_PREVIEW_LIMITS`. */
  previewLimits?: FileToolPreviewLimits
}

/**
 * Projects a live `PermissionRequest` onto the wire.
 *
 * Shared by `SessionHost` and the in-process TUI hook so both dialogs render
 * from exactly the same input. Everything a viewer needs is resolved here,
 * once per request — the previous TUI code rebuilt the file preview on every
 * render, re-reading the file from disk each time.
 */
export function toPermissionDto(
  request: PermissionRequest,
  options: PermissionDtoOptions,
): PermissionRequestDto {
  const preview = buildPreview(request, options)
  return {
    toolName: request.tool.name,
    riskLevel: request.tool.riskLevel,
    input: request.input,
    reason: request.reason,
    source: request.source,
    ...(request.matchedRule ? { matchedRule: request.matchedRule } : {}),
    ...(request.alwaysAllowRule ? { alwaysAllowRule: request.alwaysAllowRule } : {}),
    denialStreak: request.denialStreak,
    ...(request.risk ? { riskTier: request.risk.level } : {}),
    canAlwaysAllow: Boolean(request.onAlwaysAllow),
    ...(preview ? { preview } : {}),
    destructiveWarnings: analyzeDestructive(request),
    ...(request.agent ? { agent: { ...request.agent } } : {}),
  }
}

function buildPreview(
  request: PermissionRequest,
  options: PermissionDtoOptions,
): FileToolPreview | undefined {
  try {
    const preview = buildFileToolPreview(request.tool.name, request.input, { cwd: options.cwd })
    return preview ? capFileToolPreview(preview, options.previewLimits) : undefined
  } catch {
    // A preview is a courtesy. Throwing here would reject the prompt bridge,
    // which PermissionGate reads as a denial.
    return undefined
  }
}

function analyzeDestructive(request: PermissionRequest): ReturnType<typeof analyzeDestructiveCommands> {
  if (!SHELL_TOOLS.has(request.tool.name)) return []
  const input = request.input
  if (typeof input !== 'object' || input === null) return []
  const command = (input as Record<string, unknown>).command
  if (typeof command !== 'string') return []
  try {
    return analyzeDestructiveCommands(command)
  } catch {
    return []
  }
}
