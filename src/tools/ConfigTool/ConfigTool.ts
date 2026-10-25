import { z } from 'zod/v3'
import type { ModelReferenceField, Tool, ToolContext, ToolResult } from '../../harness/types.js'
import type { MyAgentSettings } from '../../config/settings.js'
import { loadMergedSettings, SettingsValidationError, updateUserSettings } from '../../config/settings.js'
import { ConfigurationFileError } from '../../config/file.js'
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/effort.js'
import { DESCRIPTION } from './prompt.js'

const CONFIG_TOOL_NAME = 'Config'

// ── Supported setting definitions ──────────────────────────────────────────────

interface SettingDef {
  key: string
  type: 'boolean' | 'string' | 'number' | 'enum'
  description: string
  options?: readonly string[]
  /**
   * The config field this key mirrors. Model references live in `config.json`,
   * which outranks the settings layers: they are read and written through
   * `context.modelConfig`, and the settings accessors below are only a fallback
   * for a context that has no configuration wired.
   */
  modelReference?: ModelReferenceField
  get: (settings: MyAgentSettings) => unknown
  set: (settings: MyAgentSettings, value: unknown) => void
  validate?: (value: unknown) => string | null
}

const SUPPORTED_SETTINGS: SettingDef[] = [
  {
    key: 'effortLevel',
    type: 'enum',
    description: 'Reasoning effort level for responses',
    options: VALID_EFFORT_LEVELS,
    get: (s) => s.effortLevel,
    set: (s, v) => { s.effortLevel = v as EffortLevel },
    validate: (v) => {
      if (typeof v !== 'string') return 'effortLevel must be a string'
      if (!VALID_EFFORT_LEVELS.includes(v as EffortLevel)) return `effortLevel must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`
      return null
    },
  },
  {
    key: 'thinking',
    type: 'boolean',
    description: 'Extended thinking; false sends no thinking parameter',
    get: (s) => s.thinking,
    set: (s, v) => { s.thinking = v as boolean },
    validate: (v) => typeof v !== 'boolean' ? 'thinking must be a boolean' : null,
  },
  {
    key: 'autoCompact',
    type: 'boolean',
    description: 'Automatically compact conversation when context is full',
    get: (s) => s.autoCompact,
    set: (s, v) => { s.autoCompact = v as boolean },
    validate: (v) => typeof v !== 'boolean' ? 'autoCompact must be a boolean' : null,
  },
  {
    key: 'autoCompactThreshold',
    type: 'number',
    description: 'Context usage ratio threshold to trigger auto-compact (0.0-1.0)',
    get: (s) => s.autoCompactThreshold,
    set: (s, v) => { s.autoCompactThreshold = v as number },
    validate: (v) => {
      if (typeof v !== 'number') return 'autoCompactThreshold must be a number'
      if (v < 0 || v > 1) return 'autoCompactThreshold must be between 0 and 1'
      return null
    },
  },
  {
    key: 'defaultModel',
    type: 'string',
    description: 'Default model key for the main conversation loop',
    modelReference: 'defaultModel',
    get: (s) => s.defaultModel,
    set: (s, v) => { s.defaultModel = v as string },
    validate: (v) => {
      if (typeof v !== 'string' || v.trim() === '') return 'defaultModel must be a non-empty string'
      return null
    },
  },
  {
    key: 'fallbackModel',
    type: 'string',
    description: 'Fallback model key when default is unavailable',
    modelReference: 'fallbackModel',
    get: (s) => s.fallbackModel,
    set: (s, v) => { s.fallbackModel = v as string },
    validate: (v) => {
      if (typeof v !== 'string' || v.trim() === '') return 'fallbackModel must be a non-empty string'
      return null
    },
  },
  {
    key: 'compactModel',
    type: 'string',
    description: 'Model key used for auto-compaction summarization',
    modelReference: 'compactModel',
    get: (s) => s.compactModel,
    set: (s, v) => { s.compactModel = v as string },
    validate: (v) => {
      if (typeof v !== 'string' || v.trim() === '') return 'compactModel must be a non-empty string'
      return null
    },
  },
]

const SETTINGS_MAP = new Map(SUPPORTED_SETTINGS.map((s) => [s.key, s]))

// ── Tool implementation ────────────────────────────────────────────────────────

export const configTool: Tool = {
  name: CONFIG_TOOL_NAME,
  description: DESCRIPTION,
  searchHint: 'get set configuration settings preferences',
  inputSchema: z.object({
    action: z.enum(['get', 'set', 'list']).describe('"list" reports every supported key, "get" reads one, "set" writes one.'),
    key: z.string().optional().describe('Setting name as reported by "list". Required for get and set.'),
    value: z.unknown().optional().describe('New value for set, already in the setting\'s own type (boolean, number, or string).'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: false,
  classifyRisk: (input) => ((input as { action?: unknown }).action === 'set' ? 'normal' : 'readonly'),
  isConcurrencySafe: false,
  shouldDefer: true,
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Config',
  getToolUseSummary(input) {
    const { action, key } = input as { action: string; key?: string }
    if (action === 'list') return 'list all settings'
    if (action === 'get') return `get ${key ?? '?'}`
    return `set ${key ?? '?'}`
  },
  getActivityDescription(input) {
    const { action, key } = input as { action: string; key?: string }
    if (action === 'list') return 'Listing configuration'
    if (action === 'get') return `Reading ${key ?? 'setting'}`
    return `Writing ${key ?? 'setting'}`
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { action, key, value } = input as { action: string; key?: string; value?: unknown }

    try {
      if (action === 'list') return await handleList(context)
      if (action === 'get') return await handleGet(key, context)
      if (action === 'set') return await handleSet(key, value, context)
    } catch (error) {
      if (error instanceof ConfigurationFileError) {
        return { ok: false, content: error.message, errorCode: 'precondition_failed' }
      }
      if (error instanceof SettingsValidationError) {
        return { ok: false, content: `Validation failed: ${error.errors.join('; ')}`, errorCode: 'invalid_input' }
      }
      throw error
    }

    return {
      ok: false,
      content: `Unknown action: "${action}". Use "get", "set", or "list".`,
      errorCode: 'invalid_input',
    }
  },
}

/**
 * One setting's current value, read from whichever layer owns it: model
 * references come from the config service, everything else from the merged
 * settings. Writing to the wrong one is exactly what B26 was.
 */
function readSetting(def: SettingDef, context: ToolContext, merged: MyAgentSettings): unknown {
  if (def.modelReference && context.modelConfig) {
    return context.modelConfig.getModelReference(def.modelReference)
  }
  return def.get(merged)
}

async function handleList(context: ToolContext): Promise<ToolResult> {
  const merged = await loadMergedSettings(context.projectDir ?? context.cwd)
  const entries = SUPPORTED_SETTINGS.map((def) => {
    const currentValue = readSetting(def, context, merged)
    const displayValue = currentValue === undefined ? '(not set)' : JSON.stringify(currentValue)
    const optionsStr = def.options ? ` [${def.options.join(', ')}]` : ''
    return `- **${def.key}** (${def.type}${optionsStr}): ${def.description}\n  Current: ${displayValue}`
  })

  return {
    ok: true,
    content: `Supported configuration settings:\n\n${entries.join('\n\n')}`,
    metadata: {
      display: {
        summary: `${SUPPORTED_SETTINGS.length} settings available`,
      },
    },
  }
}

async function handleGet(key: string | undefined, context: ToolContext): Promise<ToolResult> {
  if (!key) {
    return {
      ok: false,
      content: 'The "key" parameter is required for action "get".',
      errorCode: 'invalid_input',
    }
  }

  const def = SETTINGS_MAP.get(key)
  if (!def) {
    const supported = [...SETTINGS_MAP.keys()].join(', ')
    return {
      ok: false,
      content: `Unknown setting "${key}". Supported settings: ${supported}`,
      errorCode: 'invalid_input',
    }
  }

  const merged = await loadMergedSettings(context.projectDir ?? context.cwd)
  const currentValue = readSetting(def, context, merged)
  const displayValue = currentValue === undefined ? '(not set)' : JSON.stringify(currentValue)

  return {
    ok: true,
    content: `${key}: ${displayValue}`,
    metadata: {
      display: {
        summary: `${key} = ${displayValue}`,
      },
    },
  }
}

async function handleSet(key: string | undefined, value: unknown, context: ToolContext): Promise<ToolResult> {
  if (!key) {
    return {
      ok: false,
      content: 'The "key" parameter is required for action "set".',
      errorCode: 'invalid_input',
    }
  }

  if (value === undefined || value === null) {
    return {
      ok: false,
      content: 'The "value" parameter is required for action "set".',
      errorCode: 'invalid_input',
    }
  }

  const def = SETTINGS_MAP.get(key)
  if (!def) {
    const supported = [...SETTINGS_MAP.keys()].join(', ')
    return {
      ok: false,
      content: `Unknown setting "${key}". Supported settings: ${supported}`,
      errorCode: 'invalid_input',
    }
  }

  if (def.modelReference) return await setModelReference(def.modelReference, value, context)

  // Coerce boolean strings
  let coercedValue = value
  if (def.type === 'boolean' && typeof value === 'string') {
    if (value === 'true') coercedValue = true
    else if (value === 'false') coercedValue = false
  }

  // Coerce number strings (reject empty/whitespace-only strings)
  if (def.type === 'number' && typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') {
      const num = Number(trimmed)
      if (!isNaN(num) && isFinite(num)) coercedValue = num
    }
  }

  // Validate value
  if (def.validate) {
    const error = def.validate(coercedValue)
    if (error) {
      return {
        ok: false,
        content: error,
        errorCode: 'invalid_input',
      }
    }
  }

  await updateUserSettings((current) => { def.set(current, coercedValue) })

  const displayValue = JSON.stringify(coercedValue)
  return {
    ok: true,
    content: `Set ${key} = ${displayValue}\nNote: some settings may require a restart to take effect.`,
    metadata: {
      display: {
        summary: `${key} → ${displayValue}`,
      },
    },
  }
}

/**
 * Write one model reference to the configuration that owns it.
 *
 * The value is a model key or a configured alias; an unknown name is refused
 * with the key list rather than saved for `load()` to repair. The reply names
 * the *effective* value read back after the save, so a failed write cannot read
 * as a successful one.
 */
async function setModelReference(field: ModelReferenceField, value: unknown, context: ToolContext): Promise<ToolResult> {
  const port = context.modelConfig
  if (!port) {
    return {
      ok: false,
      content: `${field} is stored in config.json, and this session has no model configuration wired to write it.`,
      errorCode: 'precondition_failed',
    }
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      content: `${field} must be a non-empty string naming a configured model.`,
      errorCode: 'invalid_input',
    }
  }
  const modelKey = port.resolveModelKey(value)
  if (!modelKey) {
    const known = port.listModelKeys()
    return {
      ok: false,
      content: `Unknown model "${value}" for ${field}. Configured models: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      errorCode: 'invalid_input',
    }
  }

  const write = await port.setModelReference(field, modelKey)
  if (!write.ok) {
    return { ok: false, content: `Failed to save ${field}: ${write.message}`, errorCode: 'execution_failed' }
  }
  const displayValue = JSON.stringify(write.effective)
  return {
    ok: true,
    content: `Set ${field} = ${displayValue} in config.json\nNote: new sessions use it; the current session keeps the model it is already running.`,
    metadata: {
      display: {
        summary: `${field} → ${displayValue}`,
      },
    },
  }
}
