import { z } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { JsonSchema } from '../../harness/toolValidation.js'

const text = (max = 4096, min = 0) => z.string().min(min).max(max).refine(s => !s.includes('\0'), 'NUL is not allowed')
const appId = z.string().regex(/^app-[a-f0-9-]{36}$/).describe('Persistent app binding returned by bind; owned by this chat.')
const windowId = z.string().regex(/^w[1-9][0-9]*$/).describe('Window handle from bind/get_state. Required to select among multiple windows.')
const snapshotId = z.string().regex(/^s[a-f0-9-]{36}$/).describe('Latest AX or screenshot snapshotId, invalid after any attempted action.')
const ref = z.string().regex(/^s[a-f0-9-]{36}:e[0-9]+$/).describe('Element ref from the latest AX observation, including its snapshot prefix.')
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000).describe('Total deadline including queueing, in milliseconds; default 30000.')
const scope = z.enum(['window', 'application']).describe('AX observation scope. Defaults to window. Application includes app-owned windows, menu bar and focused popups; cannot authorize physical input.')
const common = { appId, timeoutMs }
const selection = z.union([
  z.object({ start: z.number().int().min(0).max(10_000_000), length: z.number().int().min(0).max(10_000_000) }).strict(),
  z.object({ text: text(4096, 1), prefix: text(4096, 1).optional(), suffix: text(4096, 1).optional() }).strict(),
]).describe('Set the AX text selection by UTF-16 start/length, or one exact text match with optional immediately adjacent prefix/suffix. Ambiguous matches fail; no keyboard fallback.')
const condition = z.union([
  z.object({ kind: z.literal('element'), state: z.enum(['present', 'absent']), role: text(100, 1).optional(), labelIncludes: text(500, 1).optional(), valueIncludes: text(500, 1).optional() }).strict()
    .refine(c => c.role !== undefined || c.labelIncludes !== undefined || c.valueIncludes !== undefined, 'Specify at least one element matcher'),
  z.object({ kind: z.literal('window'), state: z.enum(['present', 'absent']), windowId }).strict(),
  z.object({ kind: z.literal('window'), state: z.enum(['present', 'absent']), titleIncludes: text(500, 1) }).strict(),
]).describe('Wait for an element (all provided role/labelIncludes/valueIncludes match) or a window (windowId or titleIncludes). Substrings are case-sensitive and match only exposed AX text.')
const computerInputUnion = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), timeoutMs }).strict(),
  z.object({ operation: z.literal('list_apps'), timeoutMs }).strict(),
  z.object({ operation: z.literal('bind'), app: text(1024, 1).describe('Running app display name, bundle identifier or absolute .app path. Does not launch it.'), windowId: windowId.optional(), timeoutMs }).strict(),
  z.object({ operation: z.literal('get_state'), ...common, windowId: windowId.optional(), disableDiffing: z.boolean().optional(), rootRef: ref.optional().describe('Read this subtree from the current AX scope; omit to return to its root.'), scope: scope.optional(), includeScreenshot: z.boolean().optional().describe('Attach a window screenshot together with AX state. Requires window scope, no rootRef, and an image-capable model; samples are not atomic.') }).strict(),
  z.object({ operation: z.literal('wait_for'), ...common, windowId: windowId.optional(), scope: scope.optional(), condition, waitMs: z.number().int().min(100).max(60_000).default(5000).describe('Local polling budget, default 5000ms. In-flight native reads remain subject to the total timeoutMs deadline.') }).strict(),
  z.object({ operation: z.literal('screenshot'), ...common, windowId: windowId.optional() }).strict(),
  z.object({ operation: z.literal('click'), ...common, ref }).strict(),
  z.object({ operation: z.literal('focus'), ...common, ref }).strict(),
  z.object({ operation: z.literal('select_text'), ...common, ref, selection }).strict(),
  z.object({ operation: z.literal('set_value'), ...common, ref, value: text() }).strict(),
  z.object({ operation: z.literal('perform_action'), ...common, ref, action: text(100, 1).describe('An AX action exposed by this element in the latest tree.') }).strict(),
  z.object({ operation: z.literal('click_at'), ...common, snapshotId, x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000), button: z.enum(['left', 'right']).optional(), clickCount: z.number().int().min(1).max(3).optional() }).strict(),
  z.object({ operation: z.literal('press_key'), ...common, snapshotId, ref: ref.optional(), key: text(100, 1) }).strict(),
  z.object({ operation: z.literal('type_text'), ...common, snapshotId, ref: ref.optional(), text: text(4096, 1) }).strict(),
  z.object({ operation: z.literal('scroll'), ...common, snapshotId, ref: ref.optional(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(2000).optional().describe('Scroll distance in points; default 400.') }).strict(),
  z.object({ operation: z.literal('release'), ...common }).strict(),
])
export const computerInputSchema = computerInputUnion.superRefine((input, ctx) => {
  if ((input.operation === 'get_state' || input.operation === 'wait_for') && input.scope === 'application' && input.windowId !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Application scope does not select a window', path: ['windowId'] })
  if (input.operation === 'get_state' && input.includeScreenshot && (input.scope === 'application' || input.rootRef !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Combined screenshots require a complete window read', path: ['includeScreenshot'] })
})
export type ComputerInput = z.infer<typeof computerInputSchema>
const reads = new Set(['status', 'list_apps', 'bind', 'get_state', 'wait_for', 'screenshot', 'release'])
export function isComputerRead(input: ComputerInput): boolean { return reads.has(input.operation) }
export function isPhysicalInput(input: ComputerInput): boolean {
  return ['click_at', 'press_key', 'type_text', 'scroll'].includes(input.operation)
}

// Match Browser's API dialect: expose a flat object, enforce the strict union
// before permissions and again at execution. Every field comes from the union.
const properties: Record<string, JsonSchema> = {}
for (const option of computerInputUnion.options) {
  for (const [name, field] of Object.entries(option.shape)) {
    const { $schema: _, ...schema } = zodToJsonSchema(field, { $refStrategy: 'none' })
    if (name === 'operation') continue
    properties[name] = schema as JsonSchema
  }
}
properties.operation = { type: 'string', enum: computerInputUnion.options.map(o => o.shape.operation.value) }
export const computerApiInputSchema: JsonSchema = { type: 'object', properties, required: ['operation'], additionalProperties: false }
