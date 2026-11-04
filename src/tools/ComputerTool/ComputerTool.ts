import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { validateToolInput } from '../../harness/toolValidation.js'
import type { ComputerHost, ComputerResponse, ComputerDiagnostics } from '../../runtime/protocol/computerHost.js'
import { formatImageCaption } from '../imageFile.js'
import { COMPUTER_TOOL_NAME, DESCRIPTION } from './prompt.js'
import { computerApiInputSchema, computerInputSchema, isComputerRead, isPhysicalInput, type ComputerInput } from './schema.js'

export function createComputerTool(host: ComputerHost): Tool {
  return {
    name: COMPUTER_TOOL_NAME, description: DESCRIPTION,
    searchHint: 'computer use native desktop apps accessibility keyboard mouse screenshot 电脑 桌面操作',
    inputSchema: computerInputSchema, apiInputSchema: computerApiInputSchema,
    validateInput: raw => validateToolInput(computerInputSchema, raw),
    riskLevel: 'confirm', shouldDefer: true, maxResultSizeChars: 40_000, isConcurrencySafe: false,
    isReadOnlyInput: raw => { const p = computerInputSchema.safeParse(raw); return p.success && isComputerRead(p.data) },
    classifyRisk: raw => { const p = computerInputSchema.safeParse(raw); return !p.success ? 'normal' : isComputerRead(p.data) ? 'readonly' : isPhysicalInput(p.data) ? 'risky' : 'normal' },
    userFacingName: () => 'Computer',
    getToolUseSummary: raw => { const p = computerInputSchema.safeParse(raw); return p.success ? p.data.operation : null },
    getActivityDescription: () => '正在操作电脑', shouldDisplayResult: () => true,
    async execute(raw, context) {
      const parsed = computerInputSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, content: parsed.error.message, errorCode: 'invalid_input' }
      const { timeoutMs, ...input } = parsed.data
      if (context.abortSignal?.aborted) return failed('ABORTED', 'Computer operation cancelled before dispatch.', 'not_delivered')
      if ((input.operation === 'screenshot' || (input.operation === 'get_state' && input.includeScreenshot)) && (context.getSupportsImageInput?.() !== true || !context.imageAttachments)) {
        return { ok: false, content: 'Screenshots require an image-capable model and an attachment store. Use get_state or switch models.', errorCode: 'precondition_failed' }
      }
      try {
        return await renderResponse(await host.run({ sessionId: context.sessionId, input, timeoutMs,
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        }), parsed.data, context)
      } catch (error) {
        const e = error as { code?: string; delivery?: string; diagnostics?: ComputerDiagnostics }
        return failed(e?.code ?? (context.abortSignal?.aborted ? 'ABORTED' : 'DRIVER_LOST'),
          error instanceof Error ? error.message : String(error), e?.delivery ?? 'unknown', e?.diagnostics)
      }
    },
  }
}
function failed(code: string, message: string, delivery: string, diagnostics?: ComputerDiagnostics): ToolResult {
  const codes: Record<string, ToolResult['errorCode']> = {
    ABORTED: 'aborted', ETIMEDOUT: 'timeout', INVALID_INPUT: 'invalid_input',
    PERMISSION_REQUIRED: 'permission_denied', STALE_SNAPSHOT: 'not_found', TARGET_CHANGED: 'not_found',
    UNSUPPORTED: 'precondition_failed', TARGET_BUSY: 'precondition_failed', SESSION_CLOSED: 'precondition_failed', DESKTOP_UNAVAILABLE: 'precondition_failed',
  }
  const recovery: Record<string, string> = {
    PERMISSION_REQUIRED: 'Use status to check OS permissions and System Settings links; the user must grant the missing permission, then bind again.',
    STALE_SNAPSHOT: 'Read get_state again and use its new snapshot/ref.',
    TARGET_CHANGED: 'Bind the live app again and explicitly select the intended window.',
    UNSUPPORTED: 'Inspect the exposed actions/writableAttributes and use a supported operation. Physical input follows the current permission mode and requires a window snapshot.',
    INVALID_INPUT: 'Correct the parameters. For ambiguous text, provide adjacent prefix/suffix or an explicit UTF-16 range.',
    SESSION_CLOSED: 'Create a fresh binding from the current chat.',
    DESKTOP_UNAVAILABLE: 'Wait for the user to wake and unlock the desktop, then create a fresh binding and observe. Old queued calls have been cancelled; do not automatically replay them.',
  }
  const next = recovery[code] ?? 'Bind again and observe the live UI before deciding whether to repeat an action.'
  return { ok: false, content: `${message}\nDelivery: ${delivery}. ${next}${delivery === 'not_delivered' ? '' : ' The action may already have happened; do not blindly repeat it.'}`,
    errorCode: codes[code] ?? 'execution_failed', errorDetails: { code, ...(diagnostics ? { diagnostics } : {}), disposition: { delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' } } }
}
async function renderResponse(response: ComputerResponse, input: ComputerInput, context: ToolContext): Promise<ToolResult> {
  if (!response.envelope.ok) {
    const e = response.envelope.error as { code?: string; message?: string; disposition?: { delivery?: string } } | undefined
    return failed(e?.code ?? 'DRIVER_LOST', e?.message ?? JSON.stringify(response.envelope), e?.disposition?.delivery ?? 'unknown')
  }
  const content = () => JSON.stringify({ ...response.envelope, ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}) })
  const metadata = { display: { summary: input.operation } }
  if (!response.image) return { ok: true, content: content(), metadata }
  const attachmentStart = performance.now()
  const imported = await context.imageAttachments!.importImage(context.sessionId, response.image.bytes, response.image.name)
  if (response.diagnostics) response.diagnostics.stages.attachment_import = { count: 1, elapsedMs: Math.round(performance.now() - attachmentStart) }
  if (!imported.ok) return { ok: false, content: `Cannot attach screenshot: ${imported.message}`, errorCode: 'execution_failed' }
  const { ref, metadata: image } = imported.value
  const caption = formatImageCaption({ name: ref.name, animated: false, orientedOriginalWidth: image.originalWidth,
    orientedOriginalHeight: image.originalHeight, width: ref.width, height: ref.height,
    scaleX: image.originalWidth / ref.width, scaleY: image.originalHeight / ref.height,
  }, { index: 1, localPath: image.localPath })
  return { ok: true, content: `${content()}\n${caption}\nAttached size: ${ref.width}×${ref.height}. click_at uses window-local points: multiply image x/y by boundsInPoints.width/${ref.width} and boundsInPoints.height/${ref.height}.`, images: [ref], metadata }
}
