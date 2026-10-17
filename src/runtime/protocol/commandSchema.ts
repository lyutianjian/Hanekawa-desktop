import { z } from 'zod/v3'
import { VALID_EFFORT_LEVELS } from '../../config/effort.js'
import type { PermissionMode } from '../../harness/permissions.js'
import type { MessageQueuePriority } from '../../harness/types.js'
import type { RewindSummaryDecision } from '../rewindSummary.js'
import type { HostCommand, UiRequest } from './wire.js'

/**
 * Validation for everything arriving from the client half.
 *
 * `SessionHost.handleMessage` used to cast, which made the renderer — the less
 * trusted end of the boundary, and in an Electron shell the one running remote
 * content — able to hand the host any shape at all. Two consequences worth
 * naming: `set-permission-mode` reached `PermissionGate` unchecked, and a
 * `type` the switch in `execute()` does not handle fell out the bottom of that
 * switch and was answered with `{ type: 'reply', result: undefined }`, so the
 * caller's promise resolved as though the command had succeeded.
 *
 * This validates *shape*, not policy. `maxBytes` is a number, not a positive
 * integer; `sessionId` is a string, not a path. Narrowing content is a
 * behavior change that belongs with the code that suffers from it, and keeping
 * the schema shape-exact is what lets the type-level guard below be exact.
 */

const commandId = z.string()

/**
 * The wire-level cap on pasted image bytes — the design's single-image raw
 * input budget (20,000,000 B). The processing pipeline enforces its own caps
 * host-side; this one exists so an oversized payload is refused *at the
 * boundary* rather than crossing a lane and IPC buffers first.
 */
export const MAX_ATTACHMENT_WIRE_BYTES = 20_000_000

// `z.custom` rather than `z.instanceof(Uint8Array)`: the latter infers
// `Uint8Array<ArrayBuffer>`, which is a *narrower* type than the wire's
// `Uint8Array` and would fail the drift guard below over a type argument no
// sender can even express. The runtime check is the same `instanceof`.
const attachmentBytes = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, {
    message: 'expected image bytes as a Uint8Array',
  })
  .refine((bytes) => bytes.byteLength <= MAX_ATTACHMENT_WIRE_BYTES, {
    message: `bytes exceed the ${MAX_ATTACHMENT_WIRE_BYTES}-byte attachment limit`,
  })

/** `WireAttachmentSource`: pasted bytes, or a path the host reads itself. */
const attachmentSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bytes'), name: z.string(), bytes: attachmentBytes }).strict(),
  z.object({ kind: z.literal('path'), path: z.string(), name: z.string().optional() }).strict(),
])

const runOverridesSchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    modelKey: z.string().optional(),
    effort: z.enum(VALID_EFFORT_LEVELS).optional(),
    skillName: z.string().optional(),
    skillArgs: z.string().optional(),
    displayInput: z.string().optional(),
  })
  .strict()

/**
 * Spelled out rather than built from `PERMISSION_MODES`: that array is the
 * Shift+Tab cycle order and deliberately omits `readonly`, so reusing it here
 * would start rejecting a legal mode.
 */
const permissionModeSchema = z.enum(['default', 'plan', 'auto', 'bypass', 'readonly'] as const satisfies
  readonly PermissionMode[])

/** Spelled out like the mode above; `_NoDrift` is what keeps it honest. */
const rewindDecisionSchema = z.enum(['summarize-from-here', 'summarize-up-to-here'] as const satisfies
  readonly RewindSummaryDecision[])

const askUserQuestionResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answers'),
      answers: z.record(z.string()),
      annotations: z
        .record(z.object({ preview: z.string().optional(), notes: z.string().optional() }).strict())
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('rejected'), feedback: z.string().optional() }).strict(),
])

const exitPlanDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve_restore_keep'), planContent: z.string().optional() }).strict(),
  z.object({ kind: z.literal('approve_auto_keep'), planContent: z.string().optional() }).strict(),
  z.object({ kind: z.literal('approve_bypass_keep'), planContent: z.string().optional() }).strict(),
  z.object({ kind: z.literal('reject'), feedback: z.string() }).strict(),
])

const uiResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('permission'), approved: z.boolean(), alwaysAllow: z.boolean().optional() })
    .strict(),
  z.object({ kind: z.literal('ask-user-question'), result: askUserQuestionResultSchema }).strict(),
  z.object({ kind: z.literal('enter-plan'), approved: z.boolean() }).strict(),
  z.object({ kind: z.literal('exit-plan'), decision: exitPlanDecisionSchema }).strict(),
])

/** Every variant of `HostCommand`, keyed by its discriminator. */
const COMMAND_SCHEMAS = {
  hello: z.object({ type: z.literal('hello'), id: commandId }).strict(),
  submit: z
    .object({
      type: z.literal('submit'),
      id: commandId,
      input: z.string(),
      // Ids only — never paths, MIME types, or dimensions. The host resolves
      // them against the current session's store; see `HostCommand['submit']`.
      imageIds: z.array(z.string()).optional(),
      overrides: runOverridesSchema.optional(),
    })
    .strict(),
  interrupt: z
    .object({ type: z.literal('interrupt'), id: commandId, reason: z.enum(['user-cancel', 'exit']) })
    .strict(),
  'retry-turn': z.object({ type: z.literal('retry-turn'), id: commandId, failureId: z.string() }).strict(),
  reload: z.object({ type: z.literal('reload'), id: commandId }).strict(),
  retarget: z.object({ type: z.literal('retarget'), id: commandId, sessionId: z.string() }).strict(),
  // `input` is deliberately unvalidated: the tool's own zod schema runs
  // downstream in `harness/toolValidation.ts`, and duplicating it here would
  // bind two schemas together for no gain. `.strict()` still rejects unknown
  // keys alongside it.
  'run-tool': z
    .object({ type: z.literal('run-tool'), id: commandId, name: z.string(), input: z.unknown() })
    .strict(),
  'run-command': z.object({ type: z.literal('run-command'), id: commandId, input: z.string() }).strict(),
  'list-commands': z.object({ type: z.literal('list-commands'), id: commandId }).strict(),
  // `cursorPos` is a plain number, not a bounded index: `extractAtCompletionToken`
  // slices with it and an out-of-range value simply yields no token. Narrowing
  // content is the job of the code that suffers from it; this validates shape.
  'file-suggestions': z
    .object({
      type: z.literal('file-suggestions'),
      id: commandId,
      input: z.string(),
      cursorPos: z.number(),
    })
    .strict(),
  'list-branches': z.object({ type: z.literal('list-branches'), id: commandId }).strict(),
  // A plain string, like every other name on this wire: `isSafeBranchName` in
  // `runtime/gitBranches.ts` is what decides whether git may see it, and that
  // check belongs next to the `execFile` it protects rather than here.
  'switch-branch': z
    .object({ type: z.literal('switch-branch'), id: commandId, branch: z.string() })
    .strict(),
  checkpoints: z.object({ type: z.literal('checkpoints'), id: commandId }).strict(),
  'context-breakdown': z.object({ type: z.literal('context-breakdown'), id: commandId }).strict(),
  'restore-code': z
    .object({ type: z.literal('restore-code'), id: commandId, messageId: z.string() })
    .strict(),
  'truncate-session': z
    .object({ type: z.literal('truncate-session'), id: commandId, messageId: z.string() })
    .strict(),
  'summarize-rewind': z
    .object({
      type: z.literal('summarize-rewind'),
      id: commandId,
      messageId: z.string(),
      decision: rewindDecisionSchema,
    })
    .strict(),
  'set-model': z.object({ type: z.literal('set-model'), id: commandId, modelKey: z.string() }).strict(),
  // A plain string, not the effort enum: a numeric effort is a raw token
  // budget that arrives as its decimal form, and `RuntimeSlot.applyEffort`
  // keeps it as given. `WireRunOverrides.effort` is the enum; these are two
  // different fields.
  'set-effort': z
    .object({
      type: z.literal('set-effort'),
      id: commandId,
      level: z.string(),
      persist: z.boolean().optional(),
    })
    .strict(),
  'set-permission-mode': z
    .object({ type: z.literal('set-permission-mode'), id: commandId, mode: permissionModeSchema })
    .strict(),
  'ui-response': z
    .object({ type: z.literal('ui-response'), requestId: z.string(), response: uiResponseSchema })
    .strict(),
  'list-models': z.object({ type: z.literal('list-models'), id: commandId }).strict(),
  'resolve-model': z.object({ type: z.literal('resolve-model'), id: commandId, input: z.string() }).strict(),
  'set-default-model': z
    .object({ type: z.literal('set-default-model'), id: commandId, reference: z.string() })
    .strict(),
  'list-sessions': z.object({ type: z.literal('list-sessions'), id: commandId }).strict(),
  'create-session': z
    .object({ type: z.literal('create-session'), id: commandId, title: z.string().optional() })
    .strict(),
  'reload-agents': z.object({ type: z.literal('reload-agents'), id: commandId }).strict(),
  'reload-skills': z.object({ type: z.literal('reload-skills'), id: commandId }).strict(),
  'reload-settings': z.object({ type: z.literal('reload-settings'), id: commandId }).strict(),
  'list-background-tasks': z.object({ type: z.literal('list-background-tasks'), id: commandId }).strict(),
  'peek-task-output': z
    .object({
      type: z.literal('peek-task-output'),
      id: commandId,
      taskId: z.string(),
      maxBytes: z.number().optional(),
    })
    .strict(),
  'kill-task': z
    .object({
      type: z.literal('kill-task'),
      id: commandId,
      taskId: z.string(),
      reason: z.string().optional(),
    })
    .strict(),
  'open-pane': z
    .object({
      type: z.literal('open-pane'),
      id: commandId,
      sessionId: z.string().optional(),
      title: z.string().optional(),
    })
    .strict(),
  'close-pane': z
    .object({ type: z.literal('close-pane'), id: commandId, paneId: z.string() })
    .strict(),
  'list-panes': z.object({ type: z.literal('list-panes'), id: commandId }).strict(),
  'focus-pane': z
    .object({ type: z.literal('focus-pane'), id: commandId, paneId: z.string() })
    .strict(),
  // `path` is unvalidated beyond "a string": it names a directory the shell is
  // about to bootstrap, and the only sender is our own renderer bundle. What
  // guards it is the same thing that guards `run-tool` — the host process is the
  // trust boundary, not this schema.
  'open-project': z
    .object({ type: z.literal('open-project'), id: commandId, path: z.string().optional() })
    .strict(),
  // Spelled out like the two enums above rather than derived, and `_NoDrift` is
  // what keeps it honest. `content` is unbounded on purpose: it becomes a user
  // message, and the composer is the only thing that ever decides how long a
  // prompt may be.
  'enqueue-message': z
    .object({
      type: z.literal('enqueue-message'),
      id: commandId,
      content: z.string(),
      imageIds: z.array(z.string()).optional(),
      priority: z
        .enum(['now', 'next', 'later'] as const satisfies readonly MessageQueuePriority[])
        .optional(),
    })
    .strict(),
  'clear-queue': z.object({ type: z.literal('clear-queue'), id: commandId }).strict(),
  // --- image attachments ---------------------------------------------------
  'import-attachment': z
    .object({ type: z.literal('import-attachment'), id: commandId, source: attachmentSourceSchema })
    .strict(),
  'remove-attachment': z
    .object({ type: z.literal('remove-attachment'), id: commandId, imageId: z.string() })
    .strict(),
  'get-attachment-preview': z
    .object({ type: z.literal('get-attachment-preview'), id: commandId, imageId: z.string() })
    .strict(),
  'get-attachment-view': z
    .object({ type: z.literal('get-attachment-view'), id: commandId, imageId: z.string() })
    .strict(),
  // The id becomes a file name host-side, so it may not carry a path.
  'get-subagent-transcript': z
    .object({ type: z.literal('get-subagent-transcript'), id: commandId, agentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) })
    .strict(),
  'open-attachment': z
    .object({ type: z.literal('open-attachment'), id: commandId, imageId: z.string() })
    .strict(),
  shutdown: z.object({ type: z.literal('shutdown'), id: commandId, reason: z.string() }).strict(),
  // Drift guard #1, and the one that names the culprit: on a fresh object
  // literal this fails by key in both directions -- a variant added to
  // `HostCommand` reports "Property 'x' is missing", a stale entry here reports
  // "Object literal may only specify known properties".
} as const satisfies Record<HostCommand['type'], z.ZodTypeAny>

type CommandOption = (typeof COMMAND_SCHEMAS)[HostCommand['type']]

export const hostCommandSchema = z.discriminatedUnion(
  'type',
  // Object.values loses the tuple shape the signature wants. The element type
  // is unchanged, and the assertions below re-derive what the cast dropped.
  Object.values(COMMAND_SCHEMAS) as unknown as [CommandOption, ...CommandOption[]],
)

type SchemaOutput = z.infer<typeof hostCommandSchema>

/**
 * zod v3 infers a key as optional whenever its type admits `undefined`
 * (`helpers/util.d.ts`, `requiredKeys`), and `undefined extends unknown`. There
 * is no way to spell a required `unknown` field in a zod object, so `run-tool`
 * is re-required here rather than loosening the wire contract to match.
 */
type ParsedHostCommand =
  | Exclude<SchemaOutput, { type: 'run-tool' }>
  | (Extract<SchemaOutput, { type: 'run-tool' }> & { input: unknown })

type Assert<T extends true> = T
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Drift guard #2, at field level rather than variant level: a wrong type, a
 * missing field, or required/optional drift reddens the build. Because
 * `ui-response` carries `UiResponse`, this reaches `AskUserQuestionResult` and
 * `ExitPlanDecision` too -- adding a variant to either will fail here, which is
 * surprising until you know why.
 */
type _NoDrift = Assert<MutuallyAssignable<HostCommand, ParsedHostCommand>>

export interface HostCommandParseFailure {
  ok: false
  /** Recovered when present, so the sender's promise can be rejected rather than hang. */
  id?: string
  /** Recovered only for a message that claimed to be a `ui-response`. */
  requestId?: string
  message: string
}

export type HostCommandParseResult = { ok: true; command: HostCommand } | HostCommandParseFailure

/** Bounded because it is echoed back over the wire in a `fail`. */
const MAX_MESSAGE_CHARS = 500

export function parseHostCommand(message: unknown): HostCommandParseResult {
  const parsed = hostCommandSchema.safeParse(message)
  if (parsed.success) {
    // Safe by the assertions above: the only difference between the schema's
    // output and `HostCommand` is that `run-tool.input` is inferred optional.
    return { ok: true, command: parsed.data as HostCommand }
  }

  const failure: HostCommandParseFailure = { ok: false, message: describe(parsed.error) }
  if (!isRecord(message)) return failure

  if (typeof message.id === 'string') failure.id = message.id
  // Only for a message that actually claimed to be a `ui-response`: otherwise a
  // malformed `submit` carrying a stray `requestId` could settle someone else's
  // pending prompt.
  if (message.type === 'ui-response' && typeof message.requestId === 'string') {
    failure.requestId = message.requestId
  }
  return failure
}

function describe(error: z.ZodError): string {
  const summary = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return summary.length > MAX_MESSAGE_CHARS ? `${summary.slice(0, MAX_MESSAGE_CHARS)}…` : summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The kinds a malformed `ui-response` may have to be settled against. */
export type PendingUiKind = UiRequest['kind']
