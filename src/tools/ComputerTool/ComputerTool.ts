import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { validateToolInput } from '../../harness/toolValidation.js'
import type { ComputerHost, ComputerResponse } from '../../runtime/protocol/computerHost.js'
import { formatImageCaption } from '../imageFile.js'
import { COMPUTER_TOOL_NAME, DESCRIPTION } from './prompt.js'
import { computerCommand, computerInputSchema, isComputerRead, type ComputerInput } from './schema.js'

export function createComputerTool(host: ComputerHost): Tool {
  return {
    name: COMPUTER_TOOL_NAME,
    description: DESCRIPTION,
    searchHint: 'computer use desktop apps accessibility keyboard mouse screenshot 电脑 桌面操作',
    inputSchema: computerInputSchema,
    validateInput(raw) {
      const validation = validateToolInput(computerInputSchema, raw)
      if (!validation.ok) return validation
      try {
        computerCommand(computerInputSchema.parse(raw))
        return validation
      } catch (error) {
        return { ok: false, errors: [{
          path: 'args', expected: 'supported Computer arguments', actual: 'invalid arguments',
          message: error instanceof Error ? error.message : String(error),
        }] }
      }
    },
    riskLevel: 'confirm',
    shouldDefer: true,
    maxResultSizeChars: 40_000,
    // Even observations share a live desktop with actions. The host serializes
    // calls across sessions as well as within this tool runner.
    isConcurrencySafe: false,
    isReadOnlyInput: (raw) => {
      const input = computerInputSchema.safeParse(raw)
      return input.success && isComputerRead(input.data)
    },
    classifyRisk: (raw) => {
      const input = computerInputSchema.safeParse(raw)
      if (!input.success) return 'normal'
      if (isComputerRead(input.data)) return 'readonly'
      return input.data.headed || input.data.operation === 'close-app'
        || (input.data.operation === 'press' && input.data.args.includes('--force'))
        ? 'risky' : 'normal'
    },
    userFacingName: () => 'Computer',
    getToolUseSummary: (raw) => {
      const input = computerInputSchema.safeParse(raw)
      // Do not put typed text or clipboard contents in the compact header.
      return input.success ? input.data.operation : null
    },
    getActivityDescription: () => '正在操作电脑',
    shouldDisplayResult: () => true,
    async execute(raw, context) {
      const parsed = computerInputSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, content: parsed.error.message, errorCode: 'invalid_input' }
      const input = parsed.data
      let command: ReturnType<typeof computerCommand>
      try {
        command = computerCommand(input)
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error), errorCode: 'invalid_input' }
      }
      if (context.abortSignal?.aborted) return cancelled()
      if (input.operation === 'screenshot' && (context.getSupportsImageInput?.() !== true || !context.imageAttachments)) {
        return {
          ok: false,
          content: 'Computer screenshots require an image-capable model and an attachment store. Use snapshot/find/get instead, or switch to a model that accepts images.',
          errorCode: 'precondition_failed',
        }
      }
      try {
        const response = await host.run({
          sessionId: context.sessionId,
          ...command,
          headed: input.headed,
          timeoutMs: input.timeoutMs,
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        })
        return await renderResponse(response, input, context)
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (context.abortSignal?.aborted || code === 'ABORT_ERR') return cancelled()
        return {
          ok: false,
          content: `Computer operation failed: ${error instanceof Error ? error.message : String(error)}\nDelivery is unknown; observe the live UI before repeating an action.`,
          errorCode: code === 'ETIMEDOUT' ? 'timeout' : 'execution_failed',
          errorDetails: { disposition: { delivery: 'unknown', retry: 'unknown' } },
        }
      }
    },
  }
}

function cancelled(): ToolResult {
  return {
    ok: false,
    content: 'Computer operation cancelled. An action already delivered to the OS cannot be undone; observe the live UI before repeating it.',
    errorCode: 'aborted',
    errorDetails: { disposition: { delivery: 'unknown', retry: 'unknown' } },
  }
}

async function renderResponse(response: ComputerResponse, input: ComputerInput, context: ToolContext): Promise<ToolResult> {
  const { envelope } = response
  const error = envelope.error as { code?: string } | undefined
  const errors: Record<string, ToolResult['errorCode']> = {
    PERM_DENIED: 'permission_denied', POLICY_DENIED: 'permission_denied',
    INVALID_ARGS: 'invalid_input', TIMEOUT: 'timeout',
    STALE_REF: 'not_found', SNAPSHOT_NOT_FOUND: 'not_found', ELEMENT_NOT_FOUND: 'not_found',
    APP_NOT_FOUND: 'not_found', WINDOW_NOT_FOUND: 'not_found',
    PLATFORM_NOT_SUPPORTED: 'precondition_failed',
  }
  const content = JSON.stringify(envelope)
  if (!envelope.ok) {
    return {
      ok: false, content,
      errorCode: errors[error?.code ?? ''] ?? 'execution_failed',
      errorDetails: envelope.error,
    }
  }
  const display = { display: { summary: input.operation } }
  if (!response.image) return { ok: true, content, metadata: display }
  const imported = await context.imageAttachments!.importImage(context.sessionId, response.image.bytes, response.image.name)
  if (!imported.ok) {
    return { ok: false, content: `Cannot attach the desktop screenshot: ${imported.message}`, errorCode: 'execution_failed' }
  }
  const { ref, metadata } = imported.value
  const caption = formatImageCaption({
    name: ref.name, animated: false,
    orientedOriginalWidth: metadata.originalWidth, orientedOriginalHeight: metadata.originalHeight,
    width: ref.width, height: ref.height,
    scaleX: metadata.originalWidth / ref.width, scaleY: metadata.originalHeight / ref.height,
  }, { index: 1, localPath: metadata.localPath })
  return {
    ok: true,
    content: `${content}\n${caption}\nImage pixels are not absolute OS screen coordinates. Use accessibility bounds and list-displays for mouse coordinates.`,
    images: [ref],
    metadata: display,
  }
}
