import type { DestructiveCommandWarning } from '../harness/destructiveCommands.js'
import type { PermissionRule } from '../harness/permissions.js'
import { DEFAULT_LOCALE, type Locale } from './locale.js'
import type { PermissionRequestDto } from './protocol/wire.js'

/**
 * How a permission request is presented, projected from the wire DTO.
 *
 * These were pure functions inside `PermissionDialog.tsx`, typed against the
 * live `PermissionRequest`. They live here so a terminal dialog and a desktop
 * one render the same decisions from the same input, and because a renderer
 * cannot hold a `Tool`: the DTO flattens it to `toolName`/`riskLevel` and
 * carries the derived preview and destructive-command analysis with it.
 *
 * Every cross-layer import in this file is type-only, so nothing here pulls
 * the harness into a renderer bundle.
 */

export type PermissionAction = 'allow' | 'deny' | 'always'

export interface PermissionOption {
  readonly action: PermissionAction
  readonly label: string
  readonly hotkey: 'y' | 'n' | 'a'
}

type RiskLevel = PermissionRequestDto['riskLevel']
type DecisionSource = PermissionRequestDto['source']

/**
 * Every user-visible string here, per locale. Keyed `satisfies`, so a missing
 * translation fails the build by name rather than rendering `undefined`.
 *
 * `risk` and `source` are tables rather than raw enum values because both are
 * printed straight into the subtitle — without them a Chinese dialog reads
 * "dangerous - bash safety" in the middle of a sentence.
 */
interface PermissionStrings {
  readonly allowOnce: string
  readonly deny: string
  readonly alwaysAllow: (rule: string) => string
  readonly titles: { bash: string; write: string; edit: string; delete: string; tool: string }
  readonly subtitleJoiner: string
  readonly pending: (index: number, total: number) => string
  readonly agent: (type: string, description: string) => string
  readonly blocks: { command: string; path: string; input: string }
  readonly sentenceTerminator: string
  readonly terminators: RegExp
  readonly risk: Record<RiskLevel, string>
  readonly source: Record<DecisionSource, string>
  readonly reasons: {
    askRule: (rule?: string) => string
    denyRule: (rule?: string) => string
    protectedPath: string
    bashSafety: string
    allowRule: (rule?: string) => string
    mode: string
  }
}

const STRINGS = {
  en: {
    allowOnce: 'Yes, allow once',
    deny: 'No, deny',
    alwaysAllow: (rule) => `Yes, always allow ${rule}`,
    titles: {
      bash: 'Bash command',
      write: 'Write file',
      edit: 'Edit file',
      delete: 'Delete file',
      tool: 'Tool permission',
    },
    subtitleJoiner: ' - ',
    pending: (index, total) => `${index}/${total} pending`,
    agent: (type, description) => `from ${type} agent "${description}"`,
    blocks: { command: 'Command', path: 'Path', input: 'Input' },
    sentenceTerminator: '.',
    terminators: /[.!?]$/,
    risk: { safe: 'safe', confirm: 'confirm', dangerous: 'dangerous' },
    source: {
      'ask rule': 'ask rule',
      'deny rule': 'deny rule',
      'protected path': 'protected path',
      'bash safety': 'bash safety',
      'allow rule': 'allow rule',
      mode: 'mode',
    },
    reasons: {
      askRule: (rule?: string) =>
        rule
          ? `Permission rule ${rule} requires confirmation.`
          : 'Permission rule requires confirmation.',
      denyRule: (rule?: string) =>
        rule
          ? `Permission deny rule ${rule} is blocking this action.`
          : 'Permission deny rule is blocking this action.',
      protectedPath: 'Protected path requires confirmation.',
      bashSafety: 'Shell safety check requires confirmation.',
      allowRule: (rule?: string) =>
        rule
          ? `Allow rule ${rule} matched, but safety still requires confirmation.`
          : 'Allow rule matched, but safety still requires confirmation.',
      mode: 'Current permission mode requires confirmation.',
    },
  },
  zh: {
    allowOnce: '允许一次',
    deny: '拒绝',
    alwaysAllow: (rule) => `始终允许 ${rule}`,
    titles: {
      bash: 'Bash 命令',
      write: '写入文件',
      edit: '编辑文件',
      delete: '删除文件',
      tool: '工具权限',
    },
    subtitleJoiner: ' · ',
    pending: (index, total) => `第 ${index}/${total} 条待处理`,
    agent: (type, description) => `来自 ${type} 子 agent「${description}」`,
    blocks: { command: '命令', path: '路径', input: '输入' },
    sentenceTerminator: '。',
    terminators: /[。！？.!?]$/,
    risk: { safe: '安全', confirm: '需确认', dangerous: '危险' },
    source: {
      'ask rule': '询问规则',
      'deny rule': '拒绝规则',
      'protected path': '受保护路径',
      'bash safety': 'Shell 安全检查',
      'allow rule': '允许规则',
      mode: '权限模式',
    },
    reasons: {
      askRule: (rule?: string) => (rule ? `权限规则 ${rule} 要求确认。` : '权限规则要求确认。'),
      denyRule: (rule?: string) =>
        rule ? `拒绝规则 ${rule} 正在阻止该操作。` : '拒绝规则正在阻止该操作。',
      protectedPath: '受保护路径需要确认。',
      bashSafety: 'Shell 安全检查需要确认。',
      allowRule: (rule?: string) =>
        rule
          ? `允许规则 ${rule} 已匹配，但安全检查仍要求确认。`
          : '允许规则已匹配，但安全检查仍要求确认。',
      mode: '当前权限模式要求确认。',
    },
  },
} as const satisfies Record<Locale, PermissionStrings>

export function permissionOptions(locale: Locale = DEFAULT_LOCALE): readonly PermissionOption[] {
  const strings = STRINGS[locale]
  return [
    { action: 'allow', label: strings.allowOnce, hotkey: 'y' },
    { action: 'deny', label: strings.deny, hotkey: 'n' },
  ] as const
}

/**
 * The English pair, kept as a constant because the TUI, the runtime barrel and
 * two default parameters below already reach for it by that name.
 */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = permissionOptions('en')

export type PermissionInputBlock =
  /**
   * `description` is the model's own account of the command, so a view draws
   * it as a caption to `content`, never in its place and never above the
   * destructive warnings: the command is what actually runs.
   */
  | { kind: 'bash'; label: string; content: string; description?: string }
  | { kind: 'file'; label: string; content: string }
  | { kind: 'json'; label: string; content: string }
  | { kind: 'none'; label: string; content: string }

/** Severity of the request, for a view to map onto its own palette. */
export type PermissionTone = 'danger' | 'caution' | 'normal'

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Compute the next selected index given a direction. Bounded (no wrap-around)
 * to match the behaviour of `RestoreMode`. Out-of-range `current` values are
 * first clamped into `[0, total - 1]` before the move is applied.
 */
export function nextPermissionIndex(
  current: number,
  direction: 'up' | 'down',
  total: number,
): number {
  if (total <= 0) return 0
  const safe = clamp(current, 0, total - 1)
  if (direction === 'up') return Math.max(0, safe - 1)
  return Math.min(total - 1, safe + 1)
}

/**
 * Resolve a selected index to its action. Out-of-range indices are clamped
 * to the nearest valid option so the function is total.
 */
export function resolvePermissionAction(index: number): PermissionAction {
  return resolvePermissionOption(index).action
}

export function resolvePermissionOption(
  index: number,
  options: readonly PermissionOption[] = PERMISSION_OPTIONS,
): PermissionOption {
  const safe = clamp(index, 0, options.length - 1)
  return options[safe] ?? PERMISSION_OPTIONS[0]!
}

export function permissionOptionsForRequest(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): readonly PermissionOption[] {
  const base = permissionOptions(locale)
  if (destructiveWarningsForRequest(request).length > 0) return base
  // `canAlwaysAllow` is redundant with `alwaysAllowRule` for a DTO the gate
  // built (permissions.ts sets both from one ternary), but a hand-built DTO
  // must not be able to offer an affordance that does nothing.
  if (!request.alwaysAllowRule || !request.canAlwaysAllow) return base
  return [
    ...base,
    {
      action: 'always',
      label: STRINGS[locale].alwaysAllow(
        truncateMiddle(formatPermissionRuleLabel(request.alwaysAllowRule), 72),
      ),
      hotkey: 'a',
    },
  ] as const
}

export function destructiveWarningsForRequest(
  request: PermissionRequestDto,
): DestructiveCommandWarning[] {
  return request.destructiveWarnings
}

export function defaultPermissionIndex(
  request: PermissionRequestDto,
  options: readonly PermissionOption[] = permissionOptionsForRequest(request),
): number {
  if (destructiveWarningsForRequest(request).length === 0) return 0
  const denyIndex = options.findIndex((option) => option.action === 'deny')
  return denyIndex === -1 ? 0 : denyIndex
}

export function permissionToneForRequest(
  request: PermissionRequestDto,
  warnings: DestructiveCommandWarning[] = destructiveWarningsForRequest(request),
): PermissionTone {
  if (warnings.length > 0 || request.riskTier === 'critical') return 'danger'
  if (request.riskTier === 'risky') return 'caution'
  return request.riskLevel === 'dangerous' ? 'caution' : 'normal'
}

export function formatPermissionSource(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return STRINGS[locale].source[request.source]
}

export function formatPermissionTitle(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const titles = STRINGS[locale].titles
  switch (request.toolName) {
    case 'Bash':
    case 'Monitor':
      return titles.bash
    case 'Write':
      return titles.write
    case 'Edit':
    case 'MultiEdit':
      return titles.edit
    case 'Delete':
      return titles.delete
    default:
      return titles.tool
  }
}

/**
 * The asking sub-agent, risk, source and queue position. The path is left to the input block, which
 * already shows it for every file tool, and the `mode` source is left out: it
 * only says "you are asked because you are asked", and the reason line below
 * the subtitle already says why.
 */
export function formatPermissionSubtitle(
  request: PermissionRequestDto,
  activeIndex: number,
  total: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const strings = STRINGS[locale]
  const parts: string[] = []
  if (request.agent) parts.push(strings.agent(request.agent.type, truncateMiddle(request.agent.description, 48)))
  const pathLabel = getFilePath(request.input)
  if (pathLabel && !isFileTool(request.toolName)) parts.push(pathLabel)
  parts.push(strings.risk[request.riskLevel])
  if (request.source !== 'mode') parts.push(strings.source[request.source])
  if (total > 1) parts.push(strings.pending(activeIndex + 1, total))
  return parts.join(strings.subtitleJoiner)
}

export function formatPermissionReason(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const strings = STRINGS[locale]
  const detail = normalizeSentence(locale === 'zh' ? translateReason(request.reason) : request.reason, locale)
  const rule = request.matchedRule ? formatPermissionRuleLabel(request.matchedRule) : undefined
  switch (request.source) {
    case 'ask rule':
      return strings.reasons.askRule(rule)
    case 'deny rule':
      return strings.reasons.denyRule(rule)
    case 'protected path':
      return detail || strings.reasons.protectedPath
    case 'bash safety':
      return detail || strings.reasons.bashSafety
    case 'allow rule':
      return rule ? strings.reasons.allowRule(rule) : detail || strings.reasons.allowRule()
    case 'mode':
      return detail || strings.reasons.mode
  }
}

export function formatPermissionRuleLabel(rule: PermissionRule): string {
  return rule.contentPattern ? `${rule.toolName}(${rule.contentPattern})` : rule.toolName
}

export function formatPermissionInputBlock(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): PermissionInputBlock {
  const labels = STRINGS[locale].blocks
  if (request.toolName === 'Bash' || request.toolName === 'Monitor') {
    const command = isRecord(request.input) && typeof request.input.command === 'string'
      ? request.input.command
      : stringifyInput(request.input, 500)
    const description = commandDescription(request.input)
    return { kind: 'bash', label: labels.command, content: command, ...(description ? { description } : {}) }
  }

  const filePath = getFilePath(request.input)
  if (filePath && isFileTool(request.toolName)) {
    return { kind: 'file', label: labels.path, content: filePath }
  }

  const content = stringifyInput(request.input, 220)
  if (!content) return { kind: 'none', label: '', content: '' }
  return { kind: 'json', label: labels.input, content }
}

/** Short label for the "Also waiting" line; an Agent call names its type, a sub-agent's call its asker. */
export function formatPermissionRequestLabel(request: PermissionRequestDto): string {
  const label = toolLabel(request)
  return request.agent ? `${request.agent.id} › ${label}` : label
}

function toolLabel(request: PermissionRequestDto): string {
  if (request.toolName !== 'Agent' || !request.input || typeof request.input !== 'object') {
    return request.toolName
  }
  const subagentType = (request.input as Record<string, unknown>).subagent_type
  return typeof subagentType === 'string' ? `Agent:${subagentType}` : 'Agent'
}

/**
 * The Write title once the preview has told create from overwrite, and the
 * preview's degraded message, in the dialog's language. The preview itself is
 * built in `services/fileToolPreview.ts` in English for the TUI and the logs.
 */
export function formatPermissionPreviewTitle(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const title = formatPermissionTitle(request, locale)
  if (locale !== 'zh' || request.toolName !== 'Write' || request.preview?.kind !== 'diff') return title
  if (request.preview.title === 'Overwrite file') return '覆盖文件'
  if (request.preview.title === 'Create file') return '新建文件'
  return title
}

export function formatPermissionPreviewMessage(message: string, locale: Locale = DEFAULT_LOCALE): string {
  return locale === 'zh' ? translate(message.trim(), PREVIEW_MESSAGES_ZH) : message
}

type Translation = readonly [RegExp, (...groups: string[]) => string]

function translate(value: string, table: readonly Translation[]): string {
  for (const [pattern, render] of table) {
    const match = pattern.exec(value)
    if (match) return render(...match.slice(1).map((group) => group ?? ''))
  }
  return value
}

/**
 * Mirrors of the English sentences `harness/permissions.ts` writes into
 * `reason` (`reasonFor`, `protectedPathBypassReason` and the inline prompts).
 * The harness keeps English for the TUI and the logs; a sentence missing here
 * falls through untranslated rather than disappearing.
 */
const REASONS_ZH: readonly Translation[] = [
  [/^This action changes local state and requires confirmation\.$/, () => '该操作会修改本地文件或状态，需要你确认。'],
  [/^This is a dangerous action and requires explicit confirmation\.$/, () => '这是危险操作，需要你明确确认。'],
  [/^This shell command requires confirmation because it includes: (.+)\.$/, (list) =>
    `这条命令需要确认，因为它包含：${translateCategories(list)}。`],
  [/^Shell safety check: (.+)$/, (list) => `Shell 安全检查：${translateCategories(list)}`],
  [/^This action would normally be auto-denied, but the session has already had (\d+) auto-denials\. Confirm explicitly to proceed, or deny to keep blocking it\.$/, (count) =>
    `该操作通常会被自动拒绝，但本会话已经自动拒绝了 ${count} 次。确认则继续执行，拒绝则继续阻止。`],
  [/^This action would normally be auto-denied \(protected path or deny rule\), but the model has now requested it (\d+) times in a row\. Confirm explicitly to proceed, or deny to keep blocking it\.$/, (count) =>
    `该操作通常会被自动拒绝（受保护路径或拒绝规则），但模型已连续请求 ${count} 次。确认则继续执行，拒绝则继续阻止。`],
  [/^Even in bypass mode, protected paths require explicit confirmation\.(?: Matched protected paths?: (.+)\.)?$/, (paths) =>
    `即使在绕过模式下，受保护路径也需要你明确确认。${paths ? `匹配到：${paths}。` : ''}`],
  [/^Suspicious path: (.+)$/, (detail) => `可疑路径：${detail}`],
]

/** `harness/commandAnalysis.ts` categories and `harness/bashSafety.ts` issue messages. */
const CATEGORIES_ZH: readonly Translation[] = [
  [/^complex shell command$/, () => '复杂命令'],
  [/^destructive filesystem or git operation$/, () => '破坏性的文件或 git 操作'],
  [/^external or shared-state operation$/, () => '外部或共享状态操作'],
  [/^shell wrapper or privilege prefix$/, () => 'shell 包装或提权前缀'],
  [/^dangerous pattern detected$/, () => '危险模式'],
  [/^unsafe shell syntax: (.+)$/, (message) => `不安全的写法（${translate(message, SHELL_ISSUES_ZH)}）`],
]

const SHELL_ISSUES_ZH: readonly Translation[] = [
  [/^contains a carriage return$/, () => '含回车符'],
  [/^contains a UNC-style path$/, () => '含 UNC 路径'],
  [/^contains more than (\d+) shell segments$/, (count) => `超过 ${count} 段命令`],
  [/^uses (.+) as a command prefix$/, (prefix) => `以 ${prefix} 作为命令前缀`],
  [/^uses dangerous zsh builtin (.+)$/, (name) => `使用危险的 zsh 内建命令 ${name}`],
  [/^contains a newline inside double quotes$/, () => '双引号内有换行'],
  [/^contains command substitution$/, () => '命令替换'],
  [/^contains backtick command substitution$/, () => '反引号命令替换'],
  [/^contains ANSI-C shell quoting$/, () => 'ANSI-C 引号'],
  [/^contains a standalone empty quoted argument$/, () => '单独的空引号参数'],
  [/^contains quote characters after a shell comment$/, () => '注释后有引号'],
  [/^contains shell redirection$/, () => '重定向'],
  [/^contains an unclosed shell quote$/, () => '未闭合的引号'],
]

/** `services/fileToolPreview.ts`'s degraded-preview messages. */
const PREVIEW_MESSAGES_ZH: readonly Translation[] = [
  [/^File is too large to preview\.$/, () => '文件太大，无法预览。'],
  [/^Preview omitted: the file is too large to display \((.+)\)\.$/, (size) => `文件太大（${size}），不显示预览。`],
  [/^File content is not available for preview\.$/, () => '读不到文件内容，无法预览。'],
  [/^Missing string content\.$/, () => '缺少要写入的内容，无法预览。'],
  [/^Missing oldString or newString\.$/, () => '缺少 oldString 或 newString，无法预览。'],
  [/^Missing edits array\.$/, () => '缺少 edits 数组，无法预览。'],
  [/^Expected exactly one match for (.+), found (\d+)\.$/, (field, count) =>
    `${field} 应恰好匹配一处，实际匹配 ${count} 处，无法预览。`],
  [/^Overlapping edits: (.+) overlaps with (.+)\.$/, (a, b) => `${a} 与 ${b} 重叠，无法预览。`],
]

function translateReason(reason: string): string {
  return translate(reason.trim(), REASONS_ZH)
}

function translateCategories(list: string): string {
  return list.split(', ').map((category) => translate(category, CATEGORIES_ZH)).join('、')
}

function isFileTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Delete'
}

function getFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  return typeof input.filePath === 'string' ? input.filePath : undefined
}

function stringifyInput(input: unknown, maxLength: number): string {
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength - 3)}...` : raw
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const suffixLength = Math.max(8, Math.floor(maxLength / 3))
  const prefixLength = Math.max(8, maxLength - suffixLength - 3)
  return `${value.slice(0, prefixLength)}...${value.slice(value.length - suffixLength)}`
}

function normalizeSentence(value: string, locale: Locale = DEFAULT_LOCALE): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const strings = STRINGS[locale]
  return strings.terminators.test(trimmed) ? trimmed : `${trimmed}${strings.sentenceTerminator}`
}

const MAX_DESCRIPTION_CHARS = 200

/** One line, bounded: a multi-line or runaway caption would bury the command. */
function commandDescription(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.description !== 'string') return undefined
  const text = input.description.replace(/\s+/g, ' ').trim()
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
