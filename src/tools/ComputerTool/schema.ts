import { z } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { JsonSchema } from '../../harness/toolValidation.js'

const text = (max = 4096, min = 0) => z.string().min(min).max(max).refine(s => !s.includes('\0'), 'NUL is not allowed')
const appId = z.string().regex(/^app-[a-f0-9-]{36}$/).describe('Persistent app binding returned by bind; owned by this chat.')
const windowId = z.string().regex(/^w[1-9][0-9]*$/).describe('Window handle from bind/get_state. Required to select among multiple windows.')
const snapshotId = z.string().regex(/^s[a-f0-9-]{36}$/).describe('Latest AX or screenshot snapshotId, invalid after any attempted action.')
const ref = z.string().regex(/^s[a-f0-9-]{36}:e[0-9]+$/).describe('Element ref from the latest AX observation, including its snapshot prefix.')
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000).describe('Total deadline including queueing, in milliseconds; default 30000.')
const common = { appId, timeoutMs }
export const computerInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), timeoutMs }).strict(),
  z.object({ operation: z.literal('list_apps'), timeoutMs }).strict(),
  z.object({ operation: z.literal('bind'), app: text(1024, 1).describe('Running app display name, bundle identifier or absolute .app path. Does not launch it.'), windowId: windowId.optional(), timeoutMs }).strict(),
  z.object({ operation: z.literal('get_state'), ...common, windowId: windowId.optional(), disableDiffing: z.boolean().optional(), rootRef: ref.optional().describe('Read only this subtree from the current snapshot; omit to return to the window root.') }).strict(),
  z.object({ operation: z.literal('screenshot'), ...common, windowId: windowId.optional() }).strict(),
  z.object({ operation: z.literal('click'), ...common, ref }).strict(),
  z.object({ operation: z.literal('set_value'), ...common, ref, value: text() }).strict(),
  z.object({ operation: z.literal('perform_action'), ...common, ref, action: text(100, 1).describe('An AX action exposed by this element in the latest tree.') }).strict(),
  z.object({ operation: z.literal('click_at'), ...common, snapshotId, x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000), button: z.enum(['left', 'right']).optional(), clickCount: z.number().int().min(1).max(3).optional() }).strict(),
  z.object({ operation: z.literal('press_key'), ...common, snapshotId, ref: ref.optional(), key: text(100, 1) }).strict(),
  z.object({ operation: z.literal('type_text'), ...common, snapshotId, ref: ref.optional(), text: text(4096, 1) }).strict(),
  z.object({ operation: z.literal('scroll'), ...common, snapshotId, ref: ref.optional(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(2000).optional().describe('Scroll distance in points; default 400.') }).strict(),
  z.object({ operation: z.literal('release'), ...common }).strict(),
])
export type ComputerInput = z.infer<typeof computerInputSchema>
const reads = new Set(['status', 'list_apps', 'bind', 'get_state', 'screenshot', 'release'])
export function isComputerRead(input: ComputerInput): boolean { return reads.has(input.operation) }
export function isPhysicalInput(input: ComputerInput): boolean {
  return ['click_at', 'press_key', 'type_text', 'scroll'].includes(input.operation)
}

// Match Browser's API dialect: expose a flat object, enforce the strict union
// before permissions and again at execution. Every field comes from the union.
const properties: Record<string, JsonSchema> = {}
for (const option of computerInputSchema.options) {
  for (const [name, field] of Object.entries(option.shape)) {
    const { $schema: _, ...schema } = zodToJsonSchema(field, { $refStrategy: 'none' })
    if (name === 'operation') continue
    properties[name] = schema as JsonSchema
  }
}
properties.operation = { type: 'string', enum: computerInputSchema.options.map(o => o.shape.operation.value) }
export const computerApiInputSchema: JsonSchema = { type: 'object', properties, required: ['operation'], additionalProperties: false }
