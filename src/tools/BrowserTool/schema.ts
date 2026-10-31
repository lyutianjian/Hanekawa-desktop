/**
 * The `Browser` input, twice.
 *
 * `inputSchema` is a strict discriminated union — the thing that actually
 * decides whether a call runs, and the thing that knows `tabId` is required for
 * a navigation but meaningless for `browser.get_state`.
 *
 * `apiInputSchema` is the flat JSON Schema the model is shown. A union cannot
 * survive that trip (the API's schema dialect has no discriminator), so the
 * properties are unioned and `required` keeps only what every branch shares,
 * which is `operation` alone. It is generated from the union below, so a field
 * added to a branch is published without a second edit. The cost is real: the published schema no longer
 * says which fields a given operation needs. `validate.ts` pays it back by
 * turning a failure into an instruction the next turn can act on.
 */

import { z, type ZodTypeAny } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { JsonSchema } from '../../harness/toolValidation.js'
import {
  BATCH_MAX_STEPS,
  EMULATE_SCALE_MAX,
  EMULATE_SIZE_MAX,
  EMULATE_SIZE_MIN,
  PRESS_KEYS_MAX,
  SETTLE_SCREENSHOT_MS,
  TYPE_TEXT_MAX,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_LOAD_DEFAULT_MS,
  WAIT_FOR_LOAD_MAX_MS,
  WAIT_FOR_MAX_MS,
} from './constants.js'

const tabId = z.string().min(1).describe('Tab handle from browser.get_state or browser.create_tab.')
const url = z
  .string()
  .min(1)
  .describe('Absolute http(s) URL, including the scheme, with no username or password in it. For a page on disk use "path" instead.')
/** A document on disk, which the app serves over its own loopback http. */
const localPath = z
  .string()
  .min(1)
  .describe('Path of a page on disk, absolute or relative to the workspace. The app serves it over loopback http, so its CSS, scripts and images load; give "path" or "url", not both.')
const cursor = z
  .string()
  .min(1)
  .describe('Cursor from a previous snapshot’s "# more:" line. Reads the next page without re-scanning.')
const maxChars = z.number().int().describe('Character budget for this page of output (2048–24000).')
const limit = z.number().int().describe('Rows per page (elements default 100; text defaults to as many as maxChars allows). The rest stay reachable through the cursor.')
const scope = z.string().min(1).describe('CSS selector to restrict the scan to one subtree.')
const visibleOnly = z.boolean().describe('Skip elements that are not rendered. Default true.')

const elementsFields = {
  tabId,
  scope: scope.optional(),
  role: z.string().min(1).optional().describe('Keep only this ARIA role, e.g. "button" or "textbox".'),
  text: z.string().min(1).optional().describe('Keep only rows whose name or text contains this (case-insensitive).'),
  interactiveOnly: z.boolean().optional().describe('Keep only operable elements. Default true.'),
  visibleOnly: visibleOnly.optional(),
  includeBounds: z
    .boolean()
    .optional()
    .describe('Add a bounds column: each visible element’s viewport box as x,y,w,h in CSS pixels. Default false; it costs tokens.'),
  limit: limit.optional(),
  maxChars: maxChars.optional(),
  cursor: cursor.optional(),
}

const textFields = {
  tabId,
  scope: scope.optional(),
  visibleOnly: visibleOnly.optional(),
  limit: limit.optional(),
  maxChars: maxChars.optional(),
  cursor: cursor.optional(),
}

/** What an action points at. Exactly one is needed; `validate.ts` says which. */
const target = {
  ref: z.string().min(1).optional().describe('A ref from the latest page.elements.snapshot, e.g. "e3".'),
  selector: z.string().min(1).optional().describe('A CSS selector, when no snapshot ref addresses the element.'),
}

export const browserInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('browser.get_state') }).strict(),
  z.object({ operation: z.literal('browser.create_tab'), url: url.optional(), path: localPath.optional() }).strict(),
  z.object({ operation: z.literal('browser.close_tab'), tabId }).strict(),
  z.object({ operation: z.literal('tab.navigate'), tabId, url: url.optional(), path: localPath.optional() }).strict(),
  z.object({ operation: z.literal('tab.go_back'), tabId }).strict(),
  z.object({ operation: z.literal('tab.go_forward'), tabId }).strict(),
  z.object({ operation: z.literal('tab.reload'), tabId }).strict(),
  z
    .object({
      operation: z.literal('tab.wait_for_load'),
      tabId,
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(WAIT_FOR_LOAD_MAX_MS)
        .optional()
        .describe(`How long to wait (default ${WAIT_FOR_LOAD_DEFAULT_MS}, max ${WAIT_FOR_LOAD_MAX_MS}).`),
      until: z
        .enum(['domcontentloaded', 'load', 'networkidle'])
        .optional()
        .describe('load (default) waits for images and subresources too; domcontentloaded returns once the HTML is parsed; networkidle waits for load, then for the network to go quiet, animations to finish and the layout to hold still.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('tab.emulate'),
      tabId,
      preset: z
        .enum(['iphone', 'ipad', 'desktop'])
        .optional()
        .describe('iphone (390x844 @3x, mobile, iOS Safari UA), ipad (820x1180 @2x, mobile, iPad UA) or desktop (1280x800 @1x, default UA). Other fields override it.'),
      width: z.number().int().min(EMULATE_SIZE_MIN).max(EMULATE_SIZE_MAX).optional().describe('Viewport width in CSS pixels.'),
      height: z.number().int().min(EMULATE_SIZE_MIN).max(EMULATE_SIZE_MAX).optional().describe('Viewport height in CSS pixels.'),
      deviceScaleFactor: z.number().positive().max(EMULATE_SCALE_MAX).optional().describe('devicePixelRatio. Default 1 without a preset.'),
      mobile: z.boolean().optional().describe('Mobile viewport rules (meta viewport, overlay scrollbars) and touch support.'),
      userAgent: z.string().min(1).max(512).optional().describe('User-Agent string to send and report.'),
      reset: z.boolean().optional().describe('true clears the emulation; pass nothing else with it.'),
    })
    .strict(),
  z.object({ operation: z.literal('page.elements.snapshot'), ...elementsFields }).strict(),
  z.object({ operation: z.literal('page.text.snapshot'), ...textFields }).strict(),
  z
    .object({
      operation: z.literal('page.screenshot'),
      tabId,
      settle: z
        .boolean()
        .optional()
        .describe(`Default true: first wait up to ${SETTLE_SCREENSHOT_MS}ms for the page to stop moving. false captures at once, mid-animation if need be.`),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.click'),
      tabId,
      ...target,
      button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
      clickCount: z.number().int().min(1).max(3).optional().describe('2 for a double click.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.click_at'),
      tabId,
      x: z.number().min(0).describe('CSS pixels from the left edge of the visible area. Convert from a screenshot with its reported factor.'),
      y: z.number().min(0).describe('CSS pixels from the top edge of the visible area.'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
      clickCount: z.number().int().min(1).max(3).optional().describe('2 for a double click.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.type'),
      tabId,
      ...target,
      text: z.string().max(TYPE_TEXT_MAX).describe('The text to type. Pass "" with clear to empty a field.'),
      clear: z.boolean().optional().describe('Select the field’s contents and delete them first.'),
      submit: z.boolean().optional().describe('Press Enter afterwards.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.press_key'),
      tabId,
      ...target,
      keys: z
        .array(z.string().min(1))
        .min(1)
        .max(PRESS_KEYS_MAX)
        .describe('One chord, pressed in order and released in reverse: ["Enter"], ["Control", "a"], ["Shift", "Tab"].'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.select_option'),
      tabId,
      ...target,
      value: z.string().optional().describe('Pick the option whose value attribute is exactly this. (page.type takes "text", not "value".)'),
      label: z.string().min(1).optional().describe('Pick the option whose visible label is this (surrounding spaces ignored).'),
      index: z.number().int().min(0).optional().describe('Pick the option at this 0-based position.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.set_checked'),
      tabId,
      ...target,
      checked: z.boolean().describe('true to check it, false to uncheck it.'),
    })
    .strict(),
  z.object({ operation: z.literal('page.hover'), tabId, ...target }).strict(),
  z
    .object({
      operation: z.literal('page.scroll'),
      tabId,
      ...target,
      direction: z
        .enum(['up', 'down', 'top', 'bottom'])
        .optional()
        .describe('Default down. Ignored when a ref or selector is given.'),
      amount: z.number().int().positive().optional().describe('Pixels for up/down. Default most of a viewport.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.wait_for'),
      tabId,
      selector: z.string().min(1).optional().describe('Wait for this CSS selector.'),
      text: z.string().min(1).optional().describe('Wait for this text. With a selector, waits for it inside that.'),
      state: z
        .enum(['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled', 'checked', 'unchecked'])
        .optional()
        .describe('Default visible. attached/detached ignore whether it is rendered; enabled, disabled, checked and unchecked need a selector and no text. Not about url.'),
      stableForMs: z
        .number()
        .int()
        .positive()
        .max(WAIT_FOR_MAX_MS)
        .optional()
        .describe('Only succeed once the whole condition has held continuously this long, e.g. 500 to let an animation settle.'),
      url: z.string().min(1).optional().describe('Wait until the tab’s committed URL matches this.'),
      urlMatch: z
        .enum(['exact', 'prefix', 'contains'])
        .optional()
        .describe('How url is compared. Default prefix.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(WAIT_FOR_MAX_MS)
        .optional()
        .describe(`How long to wait (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}).`),
    })
    .strict(),
  z
    .object({
      operation: z.literal('batch'),
      // Same description as everywhere else, or the flat schema would list every operation beside it.
      tabId: tabId.optional(),
      steps: z
        .array(z.record(z.unknown()))
        .min(1)
        .max(BATCH_MAX_STEPS)
        .describe(`1–${BATCH_MAX_STEPS} Browser calls to run in order, each an object with its own operation and fields (not batch).`),
    })
    .strict(),
])

export type BrowserInput = z.infer<typeof browserInputSchema>

/** A field's JSON Schema without its description, which `mergeField` composes separately. */
function fieldJsonSchema(field: ZodTypeAny): JsonSchema {
  const inner = field instanceof z.ZodOptional ? (field.unwrap() as ZodTypeAny) : field
  const { $schema: _schema, description: _description, ...schema } = zodToJsonSchema(inner, { $refStrategy: 'none' }) as JsonSchema & { $schema?: string }
  return schema
}

/**
 * One published property from every branch that declares it. Identical
 * schemas pass through; differing ones keep their shared type (and the union
 * of their enums) and drop the constraints the union still enforces. A
 * description shared by every declaring branch is used once; otherwise each
 * distinct one is labelled with the operations it belongs to.
 */
function mergeField(name: string, uses: Array<{ operation: string; field: ZodTypeAny }>): JsonSchema {
  const schemas = uses.map(({ field }) => fieldJsonSchema(field))
  let merged: JsonSchema = schemas[0]!
  if (schemas.some((schema) => JSON.stringify(schema) !== JSON.stringify(merged))) {
    const types = new Set(schemas.map((schema) => JSON.stringify(schema.type)))
    if (types.size !== 1) throw new Error(`Browser field "${name}" has conflicting types across operations`)
    merged = { type: merged.type }
    if (schemas.every((schema) => schema.enum)) merged.enum = [...new Set(schemas.flatMap((schema) => schema.enum!))]
    if (schemas.every((schema) => schema.items)) merged.items = schemas[0]!.items
  }

  const byDescription = new Map<string, string[]>()
  for (const { operation, field } of uses) {
    const description = field.description ?? ''
    byDescription.set(description, [...(byDescription.get(description) ?? []), operation])
  }
  const described = [...byDescription].filter(([description]) => description !== '')
  let description: string
  if (uses.length === 1) description = `${uses[0]!.operation} only: ${described[0]?.[0] ?? ''}`.trim()
  else if (byDescription.size === 1) description = described[0]?.[0] ?? ''
  else description = described.map(([text, operations]) => `${operations.join(', ')}: ${text}`).join(' ')
  return description === '' ? merged : { ...merged, description }
}

/** The flat schema, derived from the union so a new operation cannot miss it. */
function flattenBrowserInputSchema(): JsonSchema {
  const operations: string[] = []
  const uses = new Map<string, Array<{ operation: string; field: ZodTypeAny }>>()
  for (const option of browserInputSchema.options) {
    const operation = (option.shape.operation as z.ZodLiteral<string>).value
    operations.push(operation)
    for (const [name, field] of Object.entries(option.shape as Record<string, ZodTypeAny>)) {
      if (name === 'operation') continue
      uses.set(name, [...(uses.get(name) ?? []), { operation, field }])
    }
  }
  const properties: Record<string, JsonSchema> = {
    operation: {
      type: 'string',
      enum: operations,
      description: 'Which browser action to run. See the tool description for the fields each one takes.',
    },
  }
  for (const [name, fieldUses] of uses) properties[name] = mergeField(name, fieldUses)
  return { type: 'object', properties, required: ['operation'], additionalProperties: false }
}

export const browserApiInputSchema: JsonSchema = flattenBrowserInputSchema()
