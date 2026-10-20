import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { matchBashRule, bashCommandSegments, parseShellRule, suggestBashPrefix } from './shellRuleMatching.js'
import { classifyToolCall, createRiskContext, SHELL_TOOLS, type RiskAssessment, type RiskContext, type RiskTier } from './risk/index.js'
import { classifyBash } from './risk/bash.js'
import { parseShell } from './risk/shellParse.js'
import { classifyPath, expandHome, realPath, samePath } from './risk/paths.js'
import { MASS_DELETE_CODES, maxTier, tierRank } from './risk/types.js'
import type { Tool, ToolApprovalRecord } from './types.js'
import { matchesDomainRule, urlHostname } from '../utils/permissions/webFetchDomains.js'
import { getPlansDir } from '../utils/plans.js'

const require = createRequire(import.meta.url)
const picomatch = require('picomatch') as {
  isMatch(input: string, pattern: string, options?: { nocase?: boolean; dot?: boolean }): boolean
}

export type PermissionMode = 'default' | 'plan' | 'auto' | 'bypass' | 'readonly'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
  source: PermissionDecisionSource
  matchedRule?: PermissionRule
  alwaysAllowRule?: PermissionRule
  /** Always 0: a deny rule no longer turns into a prompt. Kept for the wire until the UI drops it. */
  denialStreak: number
  onAlwaysAllow?: () => void
  /** The sub-agent whose call this is; absent for the session's own. */
  agent?: PermissionRequestAgent
  /** What the classifier found; the reason text is built from it. */
  risk?: RiskAssessment
}

export interface PermissionRequestAgent {
  id: string
  type: string
  description: string
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>
export type PermissionModeListener = (mode: PermissionMode) => void
export type PermissionDecisionSource =
  | 'mode'
  | 'allow rule'
  | 'ask rule'
  | 'deny rule'
  | 'protected path'
  | 'bash safety'

/**
 * The outcome of a permission check. `denialReason` is written for the model,
 * not the user: a denial the user never saw must not claim they made it, or
 * the model keeps retrying a call it thinks a human rejected.
 */
export interface PermissionDecision {
  approved: boolean
  source: PermissionDecisionSource | 'readonly mode'
  denialReason?: string
  /** Appended to the tool result as a system reminder once the call has run. */
  reminder?: string
}

export interface PermissionRule {
  toolName: string
  contentPattern?: string
  behavior: 'allow' | 'deny' | 'ask'
  source: 'session' | 'config'
}

export interface PermissionSettings {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

const WRITE_FAMILY = new Set(['Edit', 'Write', 'MultiEdit', 'Delete', 'NotebookEdit'])
const READ_FAMILY = new Set(['Read', 'Grep', 'Glob'])
const FILE_TOOLS = new Set([...WRITE_FAMILY, ...READ_FAMILY, 'NotebookRead'])
const PLAN_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const MEMORY_FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Delete'])
const MEMORY_DIR_TOOLS = new Set(['Grep', 'Glob'])
const USER_INSTRUCTIONS_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit'])
/** `WebFetch(domain:...)` rule content, aligned with Claude Code's syntax. */
const DOMAIN_RULE_PREFIX = 'domain:'

/**
 * Rule tool names that stand for a whole family (Claude Code §4.4): an
 * `Edit(...)` rule governs every write tool and a `Read(...)` rule every read
 * tool, and a `Bash(...)` rule every tool that runs a shell command. A rule
 * naming one concrete tool still matches that tool alone.
 */
const RULE_TOOL_ALIASES: Record<string, ReadonlySet<string>> = {
  Bash: SHELL_TOOLS,
  Edit: WRITE_FAMILY,
  Read: READ_FAMILY,
}

function ruleAppliesToTool(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true
  return RULE_TOOL_ALIASES[ruleToolName]?.has(toolName) ?? false
}

/** The URL a `WebFetch` call names, or '' when it names none. */
function extractUrl(input: unknown): string {
  if (input && typeof input === 'object') {
    const url = (input as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return ''
}

/**
 * The tools whose permission is a *host* question, and how to find the host.
 * `Browser` only names a URL in the two operations that can start a
 * navigation; the rest return '' and a `domain:` rule does not match them — a
 * snapshot of a page already open is not a new host to approve.
 */
const HOST_SCOPED_TOOLS: Record<string, (input: unknown) => string> = {
  WebFetch: extractUrl,
  Browser: browserNavigationUrl,
}

/**
 * A `batch` asks about the URL of its first navigating step: validation, which
 * runs before permission, refuses a batch whose navigations span two hosts.
 */
function browserNavigationUrl(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const { operation, steps } = input as { operation?: unknown; steps?: unknown }
  if (operation === 'batch' && Array.isArray(steps)) {
    for (const step of steps) {
      const url = browserNavigationUrl(step)
      if (url) return url
    }
    return ''
  }
  if (operation !== 'tab.navigate' && operation !== 'browser.create_tab') return ''
  return extractUrl(input)
}

function hostScopedUrl(toolName: string, input: unknown): string {
  return HOST_SCOPED_TOOLS[toolName]?.(input) ?? ''
}

export { isProtectedPath, checkWindowsPathSafety } from '../utils/permissions/protectedPaths.js'

export function permissionRulesFromSettings(permissions: PermissionSettings | undefined): PermissionRule[] {
  if (!permissions) return []
  return [
    ...permissionEntriesToRules(permissions.deny, 'deny'),
    ...permissionEntriesToRules(permissions.ask, 'ask'),
    ...permissionEntriesToRules(permissions.allow, 'allow'),
  ]
}

function permissionEntriesToRules(
  entries: string[] | undefined,
  behavior: PermissionRule['behavior'],
): PermissionRule[] {
  return (entries ?? []).flatMap((entry) => {
    const parsed = parsePermissionRuleEntry(entry)
    return parsed ? [{ ...parsed, behavior, source: 'config' as const }] : []
  })
}

function parsePermissionRuleEntry(entry: string): Pick<PermissionRule, 'toolName' | 'contentPattern'> | undefined {
  const trimmed = entry.trim()
  if (!trimmed) return undefined
  // Claude Code syntax: ToolName(content)
  const paren = trimmed.match(/^([A-Za-z0-9_-]+)\(([\s\S]*)\)$/)
  if (paren) {
    const content = paren[2]!.trim()
    return content ? { toolName: paren[1]!, contentPattern: content } : { toolName: paren[1]! }
  }
  // Legacy syntax: ToolName:pattern
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const toolName = trimmed.slice(0, colon).trim()
    const contentPattern = trimmed.slice(colon + 1).trim()
    if (!toolName) return undefined
    return contentPattern ? { toolName, contentPattern } : { toolName }
  }
  return { toolName: trimmed }
}

function permissionRuleKey(rule: PermissionRule): string {
  return [
    rule.source,
    rule.behavior,
    rule.toolName,
    rule.contentPattern ?? '',
  ].join('\0')
}

/** Serialize a rule to its settings-file entry form, e.g. Bash(git commit:*). */
export function permissionRuleToEntry(rule: PermissionRule): string {
  return rule.contentPattern ? `${rule.toolName}(${rule.contentPattern})` : rule.toolName
}

function dedupePermissionRules(rules: PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>()
  return rules.filter((rule) => {
    const key = permissionRuleKey(rule)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function inputField(input: unknown, keys: string[]): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of keys) {
      if (typeof obj[key] === 'string') return obj[key] as string
    }
  }
  return ''
}

/** The file path a file-tool call names, or '' when it names none. */
function extractFilePath(input: unknown): string {
  return inputField(input, ['path', 'filePath', 'file_path', 'notebook_path']).trim()
}

function extractCommand(input: unknown): string {
  return inputField(input, ['command'])
}

/**
 * Shared, deduped collection of session rules. Parent and subagent gates
 * reference the same store so an always-allow decision made in one is
 * immediately visible to the others.
 */
export interface SessionRuleStore {
  readonly rules: PermissionRule[]
  add(rule: PermissionRule): void
}

export function createSessionRuleStore(): SessionRuleStore {
  let rules: PermissionRule[] = []
  return {
    get rules() {
      return rules
    },
    add(rule) {
      const key = permissionRuleKey(rule)
      if (rules.some((r) => permissionRuleKey(r) === key)) return
      rules = [...rules, rule]
    },
  }
}

function allow(source: PermissionDecision['source'], reminder?: string): PermissionDecision {
  return reminder ? { approved: true, source, reminder } : { approved: true, source }
}

function deny(source: PermissionDecision['source'], denialReason: string): PermissionDecision {
  return { approved: false, source, denialReason }
}

function reasonList(risk: RiskAssessment): string {
  return risk.reasons.map((reason) => reason.message).join(' ')
}

/** Leading words that make a segment part of a larger construct rather than a command of its own. */
const STRUCTURAL_WORDS = new Set(['cd', 'pushd', 'popd', 'for', 'select', 'case', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'esac', 'function', '{', '}', '!'])

/** The tiers the mode table (spec §3.2) allows without asking. */
function modeAllowsTier(mode: PermissionMode, tier: RiskTier): boolean {
  if (tier === 'readonly') return true
  if (tier === 'normal') return mode === 'auto' || mode === 'bypass'
  return tier === 'risky' && mode === 'bypass'
}

/** A plain read outside the workspace: plan mode lets it through (spec §2). */
function isOnlyOutsideRead(risk: RiskAssessment): boolean {
  return risk.level === 'normal' && risk.reasons.every((reason) => reason.code === 'outside_read')
}

export class PermissionGate {
  private readonly sessionRuleStore: SessionRuleStore
  private configRules: PermissionRule[] = []
  private mode: PermissionMode
  private prePlanMode: PermissionMode = 'default'
  private planSlugProvider?: () => string | undefined
  private readonly persistRule?: (rule: PermissionRule) => Promise<void>
  private readonly cwd: string
  /** Key for the project's data dirs (plans, spill); absent means `cwd`. */
  private readonly projectDir?: string
  /** A locked gate keeps its mode: `setMode` and the plan-mode transitions do nothing. */
  private readonly lockMode: boolean
  /** Extra workspace roots, from `permissions.additionalDirectories`. */
  private readonly additionalDirectories: string[]
  private sessionId?: string
  private readonly memoryDir?: string
  private readonly userInstructionsFile?: string
  private riskContext?: RiskContext
  /** Highest tier each allow rule may cover, keyed by rule; computed on demand. */
  private readonly ruleCeilings = new Map<string, RiskTier>()
  /** The deny rule that blocked the previous call and how many times in a row. */
  private lastDenial?: { key: string; count: number }
  private readonly modeListeners = new Set<PermissionModeListener>()

  constructor(
    private readonly prompt: PermissionPrompt,
    configRules?: PermissionRule[],
    options?: {
      mode?: PermissionMode
      cwd?: string
      /** Key for the project's data dirs when `cwd` is a separate working directory. */
      projectDir?: string
      /** Freeze the mode for the gate's lifetime. */
      lockMode?: boolean
      additionalDirectories?: string[]
      /** The session whose tool-result spill directory counts as workspace. */
      sessionId?: string
      /** The project's memory directory, when auto memory is on; its `*.md` files need no approval. */
      memoryDir?: string
      /** The user's global instructions file; given only to a session's own gate, never a sub-agent's. */
      userInstructionsFile?: string
      persistRule?: (rule: PermissionRule) => Promise<void>
      sessionRuleStore?: SessionRuleStore
    },
  ) {
    this.sessionRuleStore = options?.sessionRuleStore ?? createSessionRuleStore()
    this.addRules(configRules ?? [])
    this.mode = options?.mode ?? 'default'
    this.cwd = options?.cwd ?? process.cwd()
    this.projectDir = options?.projectDir
    this.lockMode = options?.lockMode ?? false
    this.additionalDirectories = (options?.additionalDirectories ?? [])
      .map((dir) => dir.trim())
      .filter((dir) => dir !== '')
      .map((dir) => path.resolve(this.cwd, dir))
    this.sessionId = options?.sessionId
    this.memoryDir = options?.memoryDir
    this.userInstructionsFile = options?.userInstructionsFile
    this.persistRule = options?.persistRule
  }

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    return (await this.approveDetailed(tool, input)).approved
  }

  /** Spec §3.3: a fixed order over the classifier's verdict, the rules and the mode. */
  async approveDetailed(tool: Tool, input: unknown): Promise<PermissionDecision> {
    const decision = await this.decide(tool, input)
    if (decision.approved || decision.source !== 'deny rule') this.lastDenial = undefined
    return decision
  }

  riskLevel(tool: Tool, input: unknown): RiskTier {
    return classifyToolCall(tool, input, this.riskContextFor()).level
  }

  private async decide(tool: Tool, input: unknown): Promise<PermissionDecision> {
    const mode = this.mode
    const risk = classifyToolCall(tool, input, this.riskContextFor())
    const level = risk.level

    // 1. A deny rule is absolute.
    const deniedBy = this.matchingRule('deny', tool.name, input, risk)
    if (deniedBy) return this.denyByRule(deniedBy)

    // Memory files are the model's own notes: no prompt, in every mode. The
    // user's global instructions file likewise, but only outside plan and
    // readonly. An ask rule still applies (step 4).
    if (this.isMemoryAccess(tool, input) || this.isUserInstructionsAccess(tool, input, mode)) {
      const askedByRule = mode === 'bypass' ? undefined : this.matchingRule('ask', tool.name, input, risk)
      if (!askedByRule || this.coveredBy(this.sessionRuleStore.rules, tool.name, input, risk)) return allow('mode')
      if (mode === 'readonly') {
        return deny('ask rule', `The user asked to confirm ${permissionRuleToEntry(askedByRule)} before it runs, and read-only mode cannot ask. ${this.lockMode ? 'Ask the user to run it themselves.' : 'Ask the user to run it themselves or to switch permission mode.'}`)
      }
      return this.ask(tool, input, risk, 'ask rule', askedByRule)
    }

    // 2. Plan mode writes nothing but this session's plan file.
    if (mode === 'plan' && risk.isFileWrite) {
      if (this.isSessionPlanFile(tool, input)) return allow('mode')
      return deny('mode', `Plan mode does not allow ${tool.name}: the harness refuses every file write except the session plan file. Present the plan with ExitPlanMode first.`)
    }

    // 3. plan and readonly refuse a plainly dangerous call; bypass refuses only a mass delete.
    const massDelete = risk.reasons.some((reason) => MASS_DELETE_CODES.has(reason.code))
    if (level === 'critical' && (mode === 'plan' || mode === 'readonly' || (mode === 'bypass' && massDelete))) {
      return deny('mode', mode === 'bypass'
        ? `Hanekawa never runs this in bypass mode: ${reasonList(risk)} If it is really needed, ask the user to run it themselves or to switch permission mode.`
        : `${mode === 'plan' ? 'Plan' : 'Read-only'} mode refuses this call: ${reasonList(risk)}`)
    }

    // 4. An ask rule asks, unless this session already answered it; bypass ignores it.
    const askedBy = mode === 'bypass' ? undefined : this.matchingRule('ask', tool.name, input, risk)
    if (askedBy && !this.coveredBy(this.sessionRuleStore.rules, tool.name, input, risk)) {
      if (mode === 'readonly') {
        return deny('ask rule', `The user asked to confirm ${permissionRuleToEntry(askedBy)} before it runs, and read-only mode cannot ask. ${this.lockMode ? 'Ask the user to run it themselves.' : 'Ask the user to run it themselves or to switch permission mode.'}`)
      }
      return this.ask(tool, input, risk, 'ask rule', askedBy)
    }

    // 5. Outside bypass, critical always reaches the user, and never as "always allow".
    if (level === 'critical' && mode !== 'bypass') return this.ask(tool, input, risk, 'mode')

    if (mode === 'readonly') {
      // A read-only call that starts something writable (an Agent of a writing type) still is not one.
      return level === 'readonly' && tool.isReadOnlyInput?.(input) !== false
        ? allow('mode')
        : deny('readonly mode', `Read-only permission mode blocks ${tool.name}${risk.reasons.length > 0 ? `: ${reasonList(risk)}` : '.'} ${this.lockMode ? 'This session is locked in read-only mode.' : 'Ask the user to leave read-only mode if this call is needed.'}`)
    }

    // 6. An allow rule or an earlier approval that covers this tier.
    const allowRules = [...this.configRules, ...this.sessionRuleStore.rules]
    const allowedBy = this.coveringRule(allowRules, tool.name, input, risk)
    if (allowedBy || this.segmentsCovered(tool, input, risk, mode, allowRules)) return allow('allow rule')

    // 7. The mode table (spec §3.2).
    if (level === 'readonly') return allow('mode')
    switch (mode) {
      case 'auto':
        return level === 'normal' ? allow('mode') : this.ask(tool, input, risk, 'mode')
      case 'bypass':
        return allow('mode', level === 'risky' || level === 'critical'
          ? `This call ran in bypass mode although it was flagged as ${level === 'critical' ? 'plainly dangerous' : 'risky'}: ${reasonList(risk)} Check that this is the effect the user wanted.`
          : undefined)
      case 'plan':
        return isOnlyOutsideRead(risk) ? allow('mode') : this.ask(tool, input, risk, 'mode')
      default:
        return this.ask(tool, input, risk, 'mode')
    }
  }

  private denyByRule(rule: PermissionRule): PermissionDecision {
    const key = permissionRuleKey(rule)
    const count = this.lastDenial?.key === key ? this.lastDenial.count + 1 : 1
    this.lastDenial = { key, count }
    const entry = permissionRuleToEntry(rule)
    return deny('deny rule', count > 1
      ? `Blocked again by the permission deny rule ${entry} (${count} times in a row). Stop attempting this call or any variant of it; only the user can change this rule.`
      : `Blocked by a permission deny rule: ${entry}. Do not retry this call; a different approach or an explicit user change to permissions is required.`)
  }

  private async ask(
    tool: Tool,
    input: unknown,
    risk: RiskAssessment,
    source: PermissionDecisionSource,
    matchedRule?: PermissionRule,
  ): Promise<PermissionDecision> {
    const memory = this.memoryRuleFor(tool, input, risk)
    let alwaysAllow = false
    const approved = await this.prompt({
      tool,
      input,
      reason: this.promptReason(tool, risk, source, matchedRule),
      source,
      ...(matchedRule ? { matchedRule } : {}),
      ...(memory ? { alwaysAllowRule: memory, onAlwaysAllow: () => { alwaysAllow = true } } : {}),
      denialStreak: 0,
      risk,
    })

    if (approved && alwaysAllow && memory) {
      this.addSessionRule(memory)
      // Only an ordinary approval outlives the session (spec §5.3).
      if (risk.level === 'normal' && this.persistRule) {
        try {
          await this.persistRule(memory)
        } catch {
          // Persistence is best-effort; the in-memory session rule still applies.
        }
      }
    }

    return approved ? allow(source) : deny(source, `User denied permission for ${tool.name}.`)
  }

  private promptReason(tool: Tool, risk: RiskAssessment, source: PermissionDecisionSource, rule?: PermissionRule): string {
    const lead = source === 'ask rule' && rule
      ? `Permission rule ${permissionRuleToEntry(rule)} asks before running ${tool.name}.`
      : `${tool.name} requires confirmation.`
    if (risk.reasons.length === 0) return lead
    const label = risk.level === 'critical' ? 'Plainly dangerous' : risk.level === 'risky' ? 'Risky' : 'Found'
    return `${lead} ${label}: ${reasonList(risk)}`
  }

  /**
   * What "always allow" remembers (spec §5.3): an ordinary call gets the usual
   * prefix/host/path rule, a risky one only its exact command or absolute path,
   * a critical one nothing.
   */
  private memoryRuleFor(tool: Tool, input: unknown, risk: RiskAssessment): PermissionRule | undefined {
    if (risk.level === 'critical') return undefined
    const rule = (contentPattern?: string): PermissionRule => ({
      // A remembered command is a Bash rule, so it covers that command under every shell tool.
      toolName: SHELL_TOOLS.has(tool.name) ? 'Bash' : tool.name,
      ...(contentPattern ? { contentPattern } : {}),
      behavior: 'allow',
      source: 'session',
    })

    if (risk.level === 'risky') {
      if (SHELL_TOOLS.has(tool.name)) {
        // A `*` would turn the exact command into a wildcard rule.
        const command = extractCommand(input).trim()
        return command && !command.includes('*') ? rule(command) : undefined
      }
      const filePath = extractFilePath(input)
      return FILE_TOOLS.has(tool.name) && filePath ? rule(path.resolve(this.cwd, filePath)) : undefined
    }

    if (SHELL_TOOLS.has(tool.name)) {
      // Every segment must suggest the identical prefix, otherwise a compound
      // like `git commit && git push` would yield a rule that over-approves.
      let shared: string | undefined
      for (const segment of bashCommandSegments(extractCommand(input))) {
        const prefix = suggestBashPrefix(segment)
        if (!prefix || (shared !== undefined && shared !== prefix)) return undefined
        shared = prefix
      }
      return shared === undefined ? undefined : rule(`${shared}:*`)
    }
    if (tool.name in HOST_SCOPED_TOOLS) {
      // A host, not the exact URL. A call that names no URL yields no rule:
      // "always allow" on a snapshot must not become a tool-wide allow.
      const host = urlHostname(hostScopedUrl(tool.name, input))
      return host ? rule(`${DOMAIN_RULE_PREFIX}${host}`) : undefined
    }
    if (FILE_TOOLS.has(tool.name)) {
      const filePath = extractFilePath(input)
      return filePath ? rule(filePath) : undefined
    }
    return rule()
  }

  addSessionRule(rule: PermissionRule): void {
    this.addRules([rule])
  }

  addSessionRules(rules: PermissionRule[]): void {
    this.addRules(rules)
  }

  setConfigRules(rules: PermissionRule[]): void {
    this.configRules = []
    this.addRules(rules)
  }

  setPlanSlugProvider(provider: () => string | undefined): void {
    this.planSlugProvider = provider
  }

  /**
   * Uninstalls `provider` only if it is still the installed one. A disposed
   * runtime therefore cannot clear the provider of the runtime that replaced
   * it, whatever order dispose happens to run in.
   */
  clearPlanSlugProvider(provider: () => string | undefined): void {
    if (this.planSlugProvider === provider) this.planSlugProvider = undefined
  }

  /** Called when the gate starts serving another session (`/clear`, `/resume`). */
  setSessionId(sessionId: string): void {
    if (sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.riskContext = undefined
    this.lastDenial = undefined
  }

  getConfigRules(): PermissionRule[] {
    return [...this.configRules]
  }

  getSessionRules(): PermissionRule[] {
    return [...this.sessionRuleStore.rules]
  }

  getSessionRuleStore(): SessionRuleStore {
    return this.sessionRuleStore
  }

  /** Resolved extra workspace roots, so a subagent gate can inherit them. */
  getAdditionalDirectories(): string[] {
    return [...this.additionalDirectories]
  }

  getMode(): PermissionMode {
    return this.mode
  }

  getPrePlanMode(): PermissionMode {
    return this.prePlanMode
  }

  isBypassAvailable(): boolean {
    return true
  }

  onModeChange(listener: PermissionModeListener): () => void {
    this.modeListeners.add(listener)
    return () => {
      this.modeListeners.delete(listener)
    }
  }

  isModeLocked(): boolean {
    return this.lockMode
  }

  setMode(mode: PermissionMode): void {
    if (this.lockMode) return
    if (this.mode === mode) return
    if (mode === 'plan') {
      this.prePlanMode = this.mode
    }
    if (this.mode === 'plan' && mode !== 'plan') {
      this.prePlanMode = 'default'
    }
    this.mode = mode
    for (const listener of this.modeListeners) {
      listener(mode)
    }
  }

  exitPlanMode(): PermissionMode {
    if (this.lockMode) return this.mode
    if (this.mode !== 'plan') return this.mode
    const restoredMode = this.prePlanMode === 'plan' ? 'default' : this.prePlanMode
    this.prePlanMode = 'default'
    this.mode = restoredMode
    for (const listener of this.modeListeners) {
      listener(restoredMode)
    }
    return restoredMode
  }

  /** Transition gate into plan mode, saving the current mode. */
  prepareContextForPlanMode(): void {
    if (this.lockMode) return
    this.setMode('plan')
  }

  /** Restore gate from plan mode to the pre-plan mode. */
  restoreFromPlanMode(): void {
    this.exitPlanMode()
  }

  createApprovalRecord(tool: Tool, input: unknown, approved: boolean, turnId?: string): ToolApprovalRecord {
    return {
      id: randomUUID(),
      type: 'tool_approval',
      tool: tool.name,
      input,
      approved,
      riskLevel: tool.riskLevel,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
  }

  private matchingRule(
    behavior: PermissionRule['behavior'],
    toolName: string,
    input: unknown,
    risk: RiskAssessment,
  ): PermissionRule | undefined {
    return [...this.configRules, ...this.sessionRuleStore.rules].find((rule) => (
      rule.behavior === behavior
      && (this.matchesRule(rule, toolName, input, risk) || (behavior === 'deny' && this.matchesBashPaths(rule, toolName, risk)))
    ))
  }

  /** The first allow rule in `rules` that matches this call and may cover its tier. */
  private coveringRule(rules: PermissionRule[], toolName: string, input: unknown, risk: RiskAssessment): PermissionRule | undefined {
    if (risk.level === 'critical') return undefined
    return rules.find((rule) => (
      rule.behavior === 'allow'
      && this.matchesRule(rule, toolName, input)
      && tierRank(risk.level) <= tierRank(this.ruleCeiling(rule))
    ))
  }

  /**
   * A compound Bash command no single rule covers, taken one segment at a time:
   * each segment is either one the mode allows by itself or one an allow rule
   * covers — `rm -rf build && npm install` under `Bash(rm -rf build)` in auto.
   * Only for a flat list of simple commands whose segments, judged alone, are
   * as risky as the whole: a `cd`, a group or a heredoc makes a segment mean
   * something else on its own, and then the whole command is judged as one.
   */
  private segmentsCovered(tool: Tool, input: unknown, risk: RiskAssessment, mode: PermissionMode, rules: PermissionRule[]): boolean {
    if (!SHELL_TOOLS.has(tool.name) || !rules.some((rule) => rule.behavior === 'allow')) return false
    const command = extractCommand(input)
    const segments = bashCommandSegments(command)
    if (segments.length < 2) return false
    const parsed = parseShell(command)
    if (parsed.malformed || parsed.items.length !== segments.length) return false
    const flat = parsed.items.every((item) => (
      item.kind === 'command'
      && !item.command.redirects.some((redirect) => redirect.op.startsWith('<<'))
      && !STRUCTURAL_WORDS.has(item.command.words[0]?.text ?? '')
    ))
    if (!flat) return false

    const ctx = this.riskContextFor()
    const parts = segments.map((segment) => ({ input: { command: segment }, risk: classifyToolCall(tool, { command: segment }, ctx) }))
    const highest = parts.reduce<RiskTier>((tier, part) => maxTier(tier, part.risk.level), 'readonly')
    if (tierRank(highest) < tierRank(risk.level)) return false
    return parts.every((part) => (
      modeAllowsTier(mode, part.risk.level) || this.coveringRule(rules, tool.name, part.input, part.risk) !== undefined
    ))
  }

  private coveredBy(rules: PermissionRule[],toolName: string, input: unknown, risk: RiskAssessment): boolean {
    return this.coveringRule(rules, toolName, input, risk) !== undefined
  }

  /**
   * The highest tier an allow rule covers (spec §3.3). A tool-wide rule covers
   * `normal`. A rule with content covers `risky` only when that content itself
   * names a risky act — `Bash(git push --force:*)`, `Edit(/etc/hosts)` — so
   * remembering an ordinary `git push` never also approves `git push --force`.
   * Nothing covers `critical`.
   */
  private ruleCeiling(rule: PermissionRule): RiskTier {
    const key = permissionRuleKey(rule)
    const cached = this.ruleCeilings.get(key)
    if (cached) return cached
    const named = this.ruleContentTier(rule)
    const ceiling = named === 'critical' ? 'risky' : maxTier('normal', named)
    this.ruleCeilings.set(key, ceiling)
    return ceiling
  }

  private ruleContentTier(rule: PermissionRule): RiskTier {
    const pattern = rule.contentPattern
    if (!pattern || pattern.startsWith(DOMAIN_RULE_PREFIX)) return 'normal'
    const ctx = this.riskContextFor()
    if (rule.toolName === 'Bash') {
      const parsed = parseShellRule(pattern)
      const text = parsed.type === 'exact' ? parsed.command
        : parsed.type === 'prefix' ? parsed.prefix
        : parsed.pattern.replace(/(^|[^\\])\*/g, '$1').replace(/\\\*/g, '*')
      return classifyBash(text.trim(), ctx).reasons.reduce<RiskTier>((tier, reason) => maxTier(tier, reason.level), 'readonly')
    }
    const write = RULE_TOOL_ALIASES.Edit!.has(rule.toolName)
    if (write || RULE_TOOL_ALIASES.Read!.has(rule.toolName) || rule.toolName === 'NotebookRead') {
      const abs = path.resolve(ctx.cwd, expandHome(pattern, ctx.home))
      return classifyPath({ raw: pattern, abs }, write ? 'write' : 'read', ctx)
        .reduce<RiskTier>((tier, reason) => maxTier(tier, reason.level), 'readonly')
    }
    return 'risky'
  }

  private matchesRule(rule: PermissionRule, toolName: string, input: unknown, risk?: RiskAssessment): boolean {
    if (!ruleAppliesToTool(rule.toolName, toolName)) return false
    const pattern = rule.contentPattern
    if (!pattern) return true

    if (toolName in HOST_SCOPED_TOOLS && pattern.startsWith(DOMAIN_RULE_PREFIX)) {
      const url = hostScopedUrl(toolName, input)
      // No URL in this call means no host to compare.
      if (!url) return false
      return matchesDomainRule(pattern.slice(DOMAIN_RULE_PREFIX.length), url)
    }

    if (SHELL_TOOLS.has(toolName)) {
      const command = extractCommand(input)
      if (!command) return false
      // deny/ask rules strip ALL env var prefixes and match compound commands
      // (whole, each segment, and each command the classifier found inside
      // loops, subshells, wrappers and substitutions) so a denied subcommand
      // stays denied however it is wrapped. allow rules match the whole command only.
      const strict = rule.behavior === 'deny' || rule.behavior === 'ask'
      const candidates = strict ? [command, ...bashCommandSegments(command), ...(risk?.commands ?? [])] : [command]
      return matchBashRule(pattern, candidates, { stripAllEnvVars: strict, skipCompoundCheck: strict })
    }

    if (FILE_TOOLS.has(toolName)) {
      const filePath = extractFilePath(input)
      return filePath !== '' && this.pathMatches(pattern, path.resolve(this.cwd, filePath))
    }

    const content = inputField(input, ['path', 'filePath', 'notebook_path', 'command', 'url']) || JSON.stringify(input)
    return content === pattern || picomatch.isMatch(content, pattern, { nocase: true })
  }

  /** A `Read(...)`/`Edit(...)` deny rule also blocks the paths a shell command reads or writes. */
  private matchesBashPaths(rule: PermissionRule, toolName: string, risk: RiskAssessment): boolean {
    if (!SHELL_TOOLS.has(toolName) || !rule.contentPattern) return false
    const paths = rule.toolName === 'Read' ? risk.readPaths : rule.toolName === 'Edit' ? risk.writePaths : []
    return paths.some((abs) => this.pathMatches(rule.contentPattern!, abs))
  }

  /**
   * Spec §5.1: a pattern starting with `/` or `~` is matched against the
   * absolute path; any other against the path relative to the workspace root,
   * so `Read(.env)` means the root `.env` and `./.env` is the same file.
   */
  private pathMatches(pattern: string, abs: string): boolean {
    const ctx = this.riskContextFor()
    const expanded = expandHome(pattern, ctx.home)
    const match = (candidate: string, glob: string) => (
      samePath(candidate, glob) || picomatch.isMatch(candidate, glob, { nocase: true, dot: true })
    )
    const posix = (value: string) => value.split(path.sep).join('/')
    if (path.isAbsolute(expanded)) {
      return [expanded, realPath(expanded)].some((glob) => match(posix(abs), posix(glob)))
    }
    const glob = posix(path.normalize(expanded))
    return [this.cwd, ctx.cwd].some((root) => match(posix(path.relative(root, abs)) || '.', glob))
  }

  private addRules(rules: PermissionRule[]): void {
    for (const rule of rules) {
      if (rule.source === 'config') {
        this.configRules = dedupePermissionRules([...this.configRules, rule])
      } else {
        this.sessionRuleStore.add(rule)
      }
    }
  }

  private riskContextFor(): RiskContext {
    this.riskContext ??= createRiskContext({
      cwd: this.cwd,
      ...(this.projectDir ? { projectDir: this.projectDir } : {}),
      additionalDirectories: this.additionalDirectories,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.memoryDir ? { memoryDir: this.memoryDir } : {}),
    })
    return this.riskContext
  }

  /** A `*.md` directly in the memory directory, or (Grep/Glob) the directory itself. */
  private isMemoryAccess(tool: Tool, input: unknown): boolean {
    if (!this.memoryDir) return false
    const forFile = MEMORY_FILE_TOOLS.has(tool.name) || MEMORY_DIR_TOOLS.has(tool.name)
    if (!forFile) return false
    const filePath = extractFilePath(input)
    if (!filePath) return false
    const absolute = realPath(path.resolve(this.cwd, filePath))
    const memoryDir = realPath(this.memoryDir)
    if (MEMORY_DIR_TOOLS.has(tool.name) && samePath(absolute, memoryDir)) return true
    return MEMORY_FILE_TOOLS.has(tool.name)
      && absolute.toLowerCase().endsWith('.md')
      && samePath(path.dirname(absolute), memoryDir)
  }

  private isUserInstructionsAccess(tool: Tool, input: unknown, mode: PermissionMode): boolean {
    if (!this.userInstructionsFile || mode === 'plan' || mode === 'readonly') return false
    if (!USER_INSTRUCTIONS_TOOLS.has(tool.name)) return false
    const filePath = extractFilePath(input)
    if (!filePath) return false
    if (!samePath(realPath(path.resolve(this.cwd, filePath)), realPath(this.userInstructionsFile))) return false
    // A symlinked AGENTS.md would carry the exemption to its target (say
    // `~/.zshrc`), dangling or not; only its ancestors may be links.
    try {
      return !lstatSync(this.userInstructionsFile).isSymbolicLink()
    } catch {
      return true
    }
  }

  /** `<plansDir>/<slug>.md` or a sub-agent's `<plansDir>/<slug>-agent-<id>.md`. */
  private isSessionPlanFile(tool: Tool, input: unknown): boolean {
    if (!PLAN_FILE_TOOLS.has(tool.name)) return false
    const slug = this.planSlugProvider?.()
    const filePath = extractFilePath(input)
    if (!slug || !filePath) return false
    const absolute = path.resolve(this.cwd, filePath)
    const name = path.basename(absolute)
    return samePath(path.dirname(absolute), getPlansDir(this.projectDir ?? this.cwd))
      && (name === `${slug}.md` || (name.startsWith(`${slug}-agent-`) && name.endsWith('.md')))
  }
}
