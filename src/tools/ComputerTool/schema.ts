import { z } from 'zod/v3'

// Allowed options intentionally exclude file outputs, tracing, namespace
// overrides and launch-time command/environment injection.
interface CommandSpec {
  values?: string
  flags?: string
  min?: number
  max?: number
}

const target = 'app window-id'
const refAction: CommandSpec = { values: 'timeout-ms', min: 1, max: 1 }
const valueAction: CommandSpec = { ...refAction, min: 2, max: 2 }
const windowAction: CommandSpec = { values: target }

export const COMMANDS = {
  status: {},
  version: {},
  permissions: { flags: 'request guide' },
  'list-apps': { values: 'app' },
  'list-windows': { values: 'app' },
  'list-displays': {},
  'list-surfaces': { values: 'app' },
  snapshot: {
    values: `${target} max-depth surface root timeout-ms`,
    flags: 'include-bounds interactive-only compact skeleton force-electron-a11y',
  },
  find: {
    values: `${target} role name value text description native-id root surface state timeout-ms nth limit`,
    flags: 'exact count first last',
  },
  get: { values: 'property', min: 1, max: 1 },
  is: { values: 'property', min: 1, max: 1 },
  screenshot: { values: `${target} screen` },
  click: refAction,
  'double-click': refAction,
  'triple-click': refAction,
  'right-click': refAction,
  type: valueAction,
  'set-value': valueAction,
  clear: refAction,
  focus: refAction,
  select: valueAction,
  toggle: refAction,
  check: refAction,
  uncheck: refAction,
  expand: refAction,
  collapse: refAction,
  scroll: { ...refAction, values: 'direction amount timeout-ms' },
  'scroll-to': refAction,
  press: { values: target, flags: 'force', min: 1, max: 1 },
  hover: { values: 'xy duration timeout-ms', max: 1 },
  drag: { values: 'from to from-xy to-xy duration drop-delay timeout-ms' },
  'mouse-move': { values: 'xy' },
  'mouse-click': { values: 'xy button count modifiers' },
  'mouse-wheel': { values: 'x y dx dy modifiers' },
  launch: { values: 'timeout', flags: 'no-attach activate', min: 1, max: 1 },
  'close-app': { flags: 'force', min: 1, max: 1 },
  'focus-window': { values: `${target} title` },
  'resize-window': { values: `${target} width height` },
  'move-window': { values: `${target} x y` },
  minimize: windowAction,
  maximize: windowAction,
  restore: windowAction,
  'open-system-surface': { values: 'surface' },
  'list-notifications': { values: 'app' },
  'dismiss-notification': { values: 'app expected-app expected-title', min: 1, max: 1 },
  'dismiss-all-notifications': { values: 'app' },
  'notification-action': { values: 'expected-app expected-title', min: 2, max: 2 },
  'clipboard-get': {},
  'clipboard-set': { min: 1, max: 1 },
  'clipboard-clear': {},
  wait: {
    values: `element window text event window-id predicate value action count timeout app`,
    flags: 'menu menu-closed notification',
    max: 1,
  },
} satisfies Record<string, CommandSpec>

export const OPERATIONS: [string, ...string[]] = ['help', 'docs', ...Object.keys(COMMANDS)]
export const computerInputSchema = z.object({
  operation: z.enum(OPERATIONS).describe('Native command name, or help/docs.'),
  args: z.array(z.string().max(32_000).refine((value) => !value.includes('\0'), 'NUL is not allowed'))
    .max(64).default([]).describe('CLI arguments as separate strings, without the executable or global flags. Use -- before positional text beginning with a dash.'),
  headed: z.boolean().default(false).describe('Permit physical keyboard/mouse input and foreground activation. Default false.'),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000)
    .describe('Host deadline in milliseconds, including waiting for a queued desktop call.'),
}).strict()

export type ComputerInput = z.infer<typeof computerInputSchema>

export const READ_COMMANDS = new Set([
  'help', 'docs', 'status', 'version', 'permissions', 'list-apps', 'list-windows',
  'list-displays', 'list-surfaces', 'snapshot', 'find', 'get', 'is', 'screenshot',
  'clipboard-get', 'wait',
])

export function isComputerRead(input: ComputerInput): boolean {
  return !input.headed && READ_COMMANDS.has(input.operation)
    && !(input.operation === 'permissions' && input.args.length > 0)
}

/** Parse only known options and put every positional after `--`. No shell. */
export function computerCommand(input: ComputerInput): { command: string; args: string[] } {
  if (input.operation === 'help') {
    if (input.headed || input.args.length > 1 || (input.args[0] !== undefined && !Object.hasOwn(COMMANDS, input.args[0]))) {
      throw new Error('help accepts zero arguments or one supported command name; headed is not applicable.')
    }
    return { command: input.args[0] ?? '', args: ['--help'] }
  }
  if (input.operation === 'docs') {
    const [topic = 'desktop', reference] = input.args
    const references = ['commands-observation', 'commands-interaction', 'commands-system', 'workflows', 'troubleshooting']
    if (input.headed || input.args.length > 2 || !['desktop', 'platform'].includes(topic)
      || (reference !== undefined && !references.includes(reference))) {
      throw new Error('docs accepts [desktop|platform] and an optional reference: commands-observation, commands-interaction, commands-system, workflows, troubleshooting.')
    }
    return { command: 'skills', args: ['get', topic, ...(reference === undefined ? [] : [reference])] }
  }
  if (!Object.hasOwn(COMMANDS, input.operation)) throw new Error('Unknown Computer operation.')
  const spec: CommandSpec = COMMANDS[input.operation as keyof typeof COMMANDS]
  const values = new Set(spec.values?.split(' ') ?? [])
  const flags = new Set(spec.flags?.split(' ') ?? [])
  const options: string[] = []
  const positional: string[] = []
  let literal = false
  for (let index = 0; index < input.args.length; index++) {
    const arg = input.args[index]!
    if (!literal && arg === '--') { literal = true; continue }
    if (literal || !arg.startsWith('-')) { positional.push(arg); continue }
    const normalized = arg === '-i' ? '--interactive-only' : arg
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(normalized)
    if (!match) throw new Error(`Unsupported option ${arg}. Use help for supported options.`)
    const key = match[1]!
    if (flags.has(key) && match[2] === undefined) { options.push(`--${key}`); continue }
    if (!values.has(key)) throw new Error(`Option --${key} is not available for Computer ${input.operation}.`)
    const value = match[2] ?? input.args[++index]
    if (value === undefined) throw new Error(`Option --${key} requires a value.`)
    // Equal form keeps even a value beginning with '-' a value, never a flag.
    options.push(`--${key}=${value}`)
  }
  if (positional.length < (spec.min ?? 0) || positional.length > (spec.max ?? 0)) {
    throw new Error(`${input.operation} expects ${spec.min ?? 0}–${spec.max ?? 0} positional arguments; got ${positional.length}. Use help for syntax.`)
  }
  return { command: input.operation, args: [...options, ...(positional.length === 0 ? [] : ['--', ...positional])] }
}
