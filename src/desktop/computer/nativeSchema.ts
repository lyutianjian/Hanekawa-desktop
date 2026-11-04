import { z } from 'zod/v3'
export const boundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict()
export const windowSchema = z.object({ id: z.string().regex(/^w[1-9][0-9]*$/), title: z.string().max(500), role: z.string().max(100), bounds: boundsSchema }).strict()
export const appSchema = z.object({ bundleId: z.string().min(1).max(1024), name: z.string().max(500), processId: z.number().int().positive() }).strict()
const protocolSchema = z.literal('hanekawa-computer/4', { errorMap: () => ({ message: 'Incompatible Computer helper. Run npm run build:desktop and restart Hanekawa.' }) })
export const helloSchema = appSchema.extend({ protocol: protocolSchema, windows: z.array(windowSchema).max(100) }).strict()
export const nodeSchema = z.object({ index: z.number().int().min(0).max(999), identity: z.string().regex(/^n[1-9][0-9]*$/), depth: z.number().int().min(0).max(24), role: z.string().max(100), label: z.string().max(500), value: z.string().max(500), actions: z.array(z.string().max(100)).max(32), settable: z.boolean(), writableAttributes: z.array(z.enum(['AXValue', 'AXFocused', 'AXSelectedTextRange'])).max(3), selectedTextRange: z.object({ start: z.number().int().nonnegative(), length: z.number().int().nonnegative() }).strict().optional(), windowId: z.string().regex(/^w[1-9][0-9]*$/).optional(), enabled: z.boolean(), bounds: boundsSchema.optional() }).strict()
export type ComputerNode = z.infer<typeof nodeSchema>
export const observationSchema = z.object({ revision: z.number().int().positive(), processId: z.number().int().positive(), scope: z.enum(['window', 'application']), sampledAt: z.number().finite().nonnegative(), windowId: z.string().regex(/^w[1-9][0-9]*$/).optional(), windows: z.array(windowSchema).max(100), bounds: boundsSchema.optional(), nodes: z.array(nodeSchema).max(1000), truncated: z.boolean() }).strict().superRefine((o, ctx) => {
  if (new Set(o.nodes.map(n => n.index)).size !== o.nodes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate AX index' })
  if (new Set(o.nodes.map(n => n.identity)).size !== o.nodes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate AX identity' })
  if (o.scope === 'window' && (!o.bounds || !o.windowId || !o.windows.some(w => w.id === o.windowId))) ctx.addIssue({ code: 'custom', message: 'Missing selected window' })
  if (o.scope === 'application' && (o.windowId !== undefined || o.bounds !== undefined)) ctx.addIssue({ code: 'custom', message: 'Application observation cannot supply window coordinates' })
  if (o.nodes.some(n => n.windowId !== undefined && !o.windows.some(w => w.id === n.windowId))) ctx.addIssue({ code: 'custom', message: 'Unknown node window' })
})
export const screenshotSchema = z.object({ revision: z.number().int().positive(), processId: z.number().int().positive(), windowId: z.string().regex(/^w[1-9][0-9]*$/), bounds: boundsSchema, sampledAt: z.number().finite().nonnegative(), windowNumber: z.number().int().positive(), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), png: z.string().max(23_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()
export type ComputerObservation = z.infer<typeof observationSchema>
export type ComputerWindow = z.infer<typeof windowSchema>
export const statusSchema = z.object({ protocol: protocolSchema, accessibility: z.boolean(), screenRecording: z.boolean(), screenshotSupported: z.boolean() }).strict()
