/**
 * Client-side tolerance for the parameter names and scalar types the model
 * actually emits.
 *
 * Hanekawa's schemas are camelCase (`filePath`, `oldString`, `headLimit`) and
 * `.strict()`. The model's prior is Claude Code's wire format (`file_path`,
 * `old_string`, `-i`, `head_limit`), so a call shaped by that prior is rejected
 * outright and the whole turn is spent on a name. Normalizing here costs one
 * pass over a small object and turns those rejections into successful calls.
 *
 * This layer is deliberately NOT advertised: `toolApiSchema.ts` still publishes
 * the camelCase schema, so the model is told one shape and quietly forgiven for
 * the other. Known-but-unsupported keys are dropped rather than rejected — a
 * `Grep` that ignores `-n` still answers the question.
 *
 * Dropping is a last resort, not the default: a key the model keeps sending is
 * usually a capability worth having. `Grep`'s `output_mode` and context flags
 * used to be dropped here and are now renamed onto real parameters.
 */

interface AliasSpec {
  /** alias -> canonical key */
  rename?: Record<string, string>
  /** keys the model knows from elsewhere that this tool cannot honour */
  drop?: string[]
  /** canonical keys coerced from numeric strings */
  numbers?: string[]
  /** canonical keys coerced from "true"/"false" */
  booleans?: string[]
  /** canonical array keys that also accept a single bare value */
  arrays?: string[]
  /** canonical key -> alias value -> canonical value, for enum-like strings */
  values?: Record<string, Record<string, string>>
  /** array-valued key whose items get their own spec */
  nested?: { key: string; spec: AliasSpec }
  /** array key a call without it is taken as the single item of */
  wrap?: string
}

const FILE_PATH_ALIASES = { file_path: 'filePath', filepath: 'filePath', path: 'filePath' }
const EDIT_STRING_ALIASES = {
  old_string: 'oldString',
  new_string: 'newString',
  replace_all: 'replaceAll',
}

const EDIT_ITEM_SPEC: AliasSpec = {
  rename: EDIT_STRING_ALIASES,
  booleans: ['replaceAll'],
}

// The published `Browser` schema is flat (see `BrowserTool/schema.ts`), so
// the model has no per-operation shape to copy and reaches for the names it
// knows from other browser tools instead. A batch's steps are Browser calls,
// so they get the same forgiveness.
const BROWSER_SPEC: AliasSpec = {
  rename: {
    action: 'operation',
    // A batch's list, by the name other tools give it.
    actions: 'steps',
    tab_id: 'tabId',
    tabID: 'tabId',
    timeout_ms: 'timeoutMs',
    timeout: 'timeoutMs',
    max_chars: 'maxChars',
    interactive_only: 'interactiveOnly',
    visible_only: 'visibleOnly',
    include_bounds: 'includeBounds',
    // `selector` is a real parameter as of the input operations, so it is no
    // longer folded onto `scope`: the two mean different things now — what to
    // act on versus what to restrict a scan to.
    element: 'ref',
    element_ref: 'ref',
    click_count: 'clickCount',
    press_enter: 'submit',
    key: 'keys',
    url_match: 'urlMatch',
    stable_for_ms: 'stableForMs',
    // Playwright's name for the load state a navigation waits on.
    waitUntil: 'until',
    wait_until: 'until',
    device_scale_factor: 'deviceScaleFactor',
    user_agent: 'userAgent',
    device: 'preset',
  },
  // Operation names the model brings from other browser tools, which have
  // no `tab.` namespace.
  values: {
    operation: {
      back: 'tab.go_back',
      go_back: 'tab.go_back',
      'tab.back': 'tab.go_back',
      forward: 'tab.go_forward',
      go_forward: 'tab.go_forward',
      'tab.forward': 'tab.go_forward',
      reload: 'tab.reload',
      refresh: 'tab.reload',
      'tab.refresh': 'tab.reload',
      hover: 'page.hover',
      click_at: 'page.click_at',
      'page.clickAt': 'page.click_at',
      emulate: 'tab.emulate',
    },
  },
  arrays: ['keys'],
  numbers: ['timeoutMs', 'maxChars', 'limit', 'clickCount', 'amount', 'index', 'stableForMs', 'x', 'y', 'width', 'height', 'deviceScaleFactor'],
  booleans: ['interactiveOnly', 'visibleOnly', 'includeBounds', 'clear', 'submit', 'checked', 'mobile', 'reset', 'settle'],
}

const SPECS: Record<string, AliasSpec> = {
  Read: {
    rename: { ...FILE_PATH_ALIASES },
    drop: ['pages'],
    numbers: ['offset', 'limit'],
  },
  Edit: {
    rename: { ...FILE_PATH_ALIASES, ...EDIT_STRING_ALIASES },
    booleans: ['replaceAll'],
  },
  MultiEdit: {
    rename: { ...FILE_PATH_ALIASES },
    nested: { key: 'edits', spec: EDIT_ITEM_SPEC },
  },
  Write: {
    rename: { ...FILE_PATH_ALIASES },
  },
  Delete: {
    rename: { ...FILE_PATH_ALIASES },
  },
  // NotebookEdit is already snake_case; the aliases go the other way.
  NotebookEdit: {
    rename: {
      file_path: 'notebook_path',
      filePath: 'notebook_path',
      notebookPath: 'notebook_path',
      cellId: 'cell_id',
      newSource: 'new_source',
      cellType: 'cell_type',
      editMode: 'edit_mode',
    },
  },
  Grep: {
    rename: {
      '-i': 'caseInsensitive',
      case_insensitive: 'caseInsensitive',
      ignore_case: 'caseInsensitive',
      head_limit: 'headLimit',
      file_pattern: 'glob',
      include: 'glob',
      output_mode: 'outputMode',
      '-C': 'contextLines',
      context: 'contextLines',
      context_lines: 'contextLines',
      '-B': 'contextBefore',
      '-A': 'contextAfter',
    },
    // `-n` asks for line numbers, which the content mode always emits anyway.
    drop: ['-n'],
    numbers: ['headLimit', 'offset', 'contextLines', 'contextBefore', 'contextAfter'],
    booleans: ['caseInsensitive', 'multiline'],
  },
  Glob: {
    rename: { file_pattern: 'pattern' },
  },
  // The model's prior for a message body is `message` or `content`.
  MessageThread: { rename: { message: 'text', content: 'text' } },
  AskCoordinator: { rename: { prompt: 'question', message: 'question', text: 'question', content: 'question' } },
  Browser: { ...BROWSER_SPEC, nested: { key: 'steps', spec: BROWSER_SPEC } },
  // The prior creates one task per call, with the task's fields at the top level.
  TaskCreate: { rename: { todos: 'tasks', items: 'tasks' }, wrap: 'tasks' },
  // Both prior shapes name the same search: Claude Code's
  // `{query, allowed_domains, blocked_domains}` and Codex's
  // `{search_query: [{q, recency, domains}]}`. `queries` takes one query, one
  // string per query, or the per-query objects, so `arrays` only has to lift a
  // bare string into a list and `nested` only has to rename inside an object.
  WebSearch: {
    rename: {
      query: 'queries',
      search_query: 'queries',
      allowed_domains: 'domains',
      blocked_domains: 'blockedDomains',
      recency: 'recencyDays',
    },
    numbers: ['maxResults', 'recencyDays'],
    arrays: ['queries', 'domains', 'blockedDomains'],
    nested: {
      key: 'queries',
      spec: { rename: { recency: 'recencyDays', allowed_domains: 'domains' }, numbers: ['recencyDays'], arrays: ['domains'] },
    },
  },
  // Claude Code's WebFetch takes a `prompt` for a second model to answer; this
  // tool returns the page itself, so the key has no meaning here.
  WebFetch: { rename: { pattern_search: 'pattern' }, drop: ['prompt'], numbers: ['offset'] },
}

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/

function coerceNumber(value: unknown): unknown {
  if (typeof value !== 'string' || !NUMERIC_LITERAL.test(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

function coerceBoolean(value: unknown): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function applySpec(input: Record<string, unknown>, spec: AliasSpec): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const drop = new Set(spec.drop ?? [])

  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue
    const canonical = spec.rename?.[key] ?? key
    // An explicit canonical key always wins over an alias for the same slot,
    // so `{filePath, file_path}` cannot silently take the alias.
    if (canonical !== key && Object.hasOwn(input, canonical)) continue
    next[canonical] = value
  }
  if (spec.wrap !== undefined && !Object.hasOwn(next, spec.wrap) && Object.keys(next).length > 0) {
    return { [spec.wrap]: [next] }
  }

  for (const key of spec.numbers ?? []) {
    if (key in next) next[key] = coerceNumber(next[key])
  }
  for (const key of spec.booleans ?? []) {
    if (key in next) next[key] = coerceBoolean(next[key])
  }
  for (const [key, map] of Object.entries(spec.values ?? {})) {
    const value = next[key]
    if (typeof value === 'string' && Object.hasOwn(map, value)) next[key] = map[value]
  }
  for (const key of spec.arrays ?? []) {
    if (key in next && typeof next[key] === 'string') next[key] = [next[key]]
  }

  const nested = spec.nested
  if (nested && Array.isArray(next[nested.key])) {
    next[nested.key] = (next[nested.key] as unknown[]).map((item) =>
      isPlainObject(item) ? applySpec(item, nested.spec) : item,
    )
  }

  return next
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the canonical input for `toolName`, or the original reference when
 * nothing needed changing — callers compare by identity to skip a write.
 */
export function normalizeToolInput(toolName: string, input: unknown): unknown {
  const spec = SPECS[toolName]
  if (!spec || !isPlainObject(input)) return input
  const normalized = applySpec(input, spec)
  return sameShape(input, normalized) ? input : normalized
}

function sameShape(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const beforeKeys = Object.keys(before)
  if (beforeKeys.length !== Object.keys(after).length) return false
  return beforeKeys.every((key) => Object.hasOwn(after, key) && Object.is(before[key], after[key]))
}

/** Exposed for tests: the tool names this layer knows how to normalize. */
export function aliasedToolNames(): string[] {
  return Object.keys(SPECS)
}
