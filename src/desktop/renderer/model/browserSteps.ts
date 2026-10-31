/**
 * What one `Browser` call did, in the window's words.
 *
 * The tool's own captions are written for the model — an operation id for the
 * call, an English caption block for a screenshot — so the transcript names the
 * operation itself, the way it already names a file or a search pattern. The
 * operation table is a copy of `src/tools/BrowserTool/constants.ts` because the
 * renderer may not reach into the tool half; an operation this file does not
 * know still draws its own id rather than nothing.
 *
 * DOM-free: `model/toolPhrases.ts` reads the row from it and
 * `dom/transcriptView.ts` the body.
 */

import type { ImageAttachmentRef } from '../../../media/types.js'

export const BROWSER_TOOL = 'Browser'

/** One call's operation and the arguments it was given. */
export interface BrowserStep {
  readonly operation: string
  /** The call's arguments, `operation` removed. Never read as anything but data. */
  readonly input: Readonly<Record<string, unknown>>
}

/** `{ browser }` for a `tool_use` input, `{}` for anything that is not one. */
export function browserStepOf(input: unknown): { browser?: BrowserStep } {
  if (typeof input !== 'object' || input === null) return {}
  const { operation, ...rest } = input as Record<string, unknown>
  if (typeof operation !== 'string' || operation.length === 0) return {}
  return { browser: { operation, input: rest } }
}

/** A row's two halves: the verb, and the object it acts on in the stronger ink. */
export interface BrowserRow {
  readonly verb: string
  readonly target: string
}

/**
 * The row: 「截取页面」, 「打开 example.com」, 「点击 e12」. An action that pointed
 * at an element names it, since that is what tells two clicks apart; a bare one
 * — a snapshot, a reload — is the verb alone.
 */
export function browserRow(step: BrowserStep): BrowserRow {
  const { input } = step
  const target = elementTarget(input)
  switch (step.operation) {
    case 'browser.create_tab':
      return input['url'] === undefined ? verb('新建标签页') : verb('打开', host(input['url']))
    case 'tab.navigate':
      return verb('打开', host(input['url']))
    case 'tab.emulate':
      return input['reset'] === true ? verb('清除设备模拟') : verb('模拟', size(input))
    case 'page.click':
    case 'page.hover':
      return verb(step.operation === 'page.click' ? '点击' : '悬停', target)
    case 'page.click_at':
      return verb('点击', `(${value(input['x'])}, ${value(input['y'])})`)
    case 'page.type':
      return verb('输入文本', target)
    case 'page.press_key':
      return verb('按下', keys(input['keys']))
    case 'page.select_option':
      return verb('选择', string(input['label']) ?? string(input['value']) ?? value(input['index']) ?? target)
    case 'page.set_checked':
      return verb(input['checked'] === true ? '勾选' : '取消勾选', target)
    case 'batch':
      return verb('执行', `${batchSteps(step).length} 步浏览器操作`)
    default:
      return verb(ROW_VERBS[step.operation] ?? step.operation)
  }
}

/** The operations whose row is the verb alone. */
const ROW_VERBS: Readonly<Record<string, string>> = {
  'browser.get_state': '查看标签页',
  'browser.close_tab': '关闭标签页',
  'tab.go_back': '后退',
  'tab.go_forward': '前进',
  'tab.reload': '刷新页面',
  'tab.wait_for_load': '等待加载',
  'page.elements.snapshot': '读取页面元素',
  'page.text.snapshot': '读取页面文本',
  'page.screenshot': '截取页面',
  'page.scroll': '滚动页面',
  'page.wait_for': '等待页面',
}

/**
 * One step of a call, with what came back for it.
 *
 * A batch is the tool's many-operation form, and the tool answers it one
 * `[i/n] operation: …` line per step — an answer written for the model, full of
 * tab ids, viewport maths and English. The window splits that answer back into
 * its steps so each reads as its own action: the operation in words, and under
 * it only what a person is reading the step for.
 */
export interface BrowserRun {
  /** A batch's 1-based position. A single call has none: its row is the operation. */
  readonly index?: number
  readonly row: BrowserRow
  /** The picture this step produced. */
  readonly image?: ImageAttachmentRef
  /** The part of this step's answer worth printing (`stepText`). */
  readonly text?: string
  /** The step the batch stopped at. */
  readonly failed?: boolean
  /** A step the batch never reached, because one before it failed. */
  readonly skipped?: boolean
}

/**
 * The call as the steps a reader watches happen: one for a plain call, one per
 * `steps` entry for a batch. `images` arrive in step order, so the *n*-th
 * screenshot step takes the *n*-th picture; a batch stops at its first failure,
 * so nothing after the failing step can own one.
 */
export function browserRuns(
  step: BrowserStep,
  images: readonly ImageAttachmentRef[] | undefined,
  text: string | undefined,
  failed: boolean,
): readonly BrowserRun[] {
  if (step.operation !== 'batch') {
    const answer = stepText(step.operation, text, failed)
    return [{
      row: browserRow(step),
      ...(images?.[0] === undefined ? {} : { image: images[0] }),
      ...(answer === undefined ? {} : { text: answer }),
      ...(failed ? { failed: true } : {}),
    }]
  }
  const lines = splitBatchText(text)
  let shot = 0
  // The tool stops at the first step that fails, so everything after that one was
  // asked for and never ran — a row that says so, rather than a row that looks done.
  let stopped = false
  return batchSteps(step).map((child, index) => {
    const line = lines[index]
    const verdict = line === undefined ? undefined : splitVerdict(line, child.operation)
    const answer = stepText(child.operation, verdict?.text, verdict?.failed === true)
    const image = child.operation === 'page.screenshot' ? (images ?? [])[shot] : undefined
    if (image !== undefined) shot += 1
    const run: BrowserRun = {
      index: index + 1,
      row: browserRow(child),
      ...(image === undefined ? {} : { image }),
      ...(answer === undefined ? {} : { text: answer }),
      ...(verdict?.failed === true ? { failed: true } : {}),
      ...(stopped ? { skipped: true } : {}),
    }
    if (verdict?.failed === true) stopped = true
    return run
  })
}

/** The operations whose answer is the document the reader came for. */
const READING = new Set(['browser.get_state', 'page.elements.snapshot', 'page.text.snapshot'])

/** Where a page's own console report starts in an answer, for `stepText` to keep. */
const CONSOLE_HEAD = 'Console errors the page logged:'

/**
 * The part of a step's answer worth printing: all of it for a read and for a
 * failure, a page's console errors under an action — a handler that threw is the
 * only explanation for a click that did nothing — and nothing for an action that
 * went through, whose answer is the tab dump the model needs and a reader does
 * not. The tool's whole answer stays in the record and the copy button.
 */
function stepText(operation: string, text: string | undefined, failed: boolean): string | undefined {
  if (text === undefined || text.length === 0) return undefined
  if (failed || READING.has(operation)) return text
  const at = text.indexOf(CONSOLE_HEAD)
  return at < 0 ? undefined : text.slice(at)
}

/** A batch's own steps, each read the way a top-level call is. */
function batchSteps(step: BrowserStep): readonly BrowserStep[] {
  const steps = step.input['steps']
  if (!Array.isArray(steps)) return []
  return steps.flatMap((entry) => browserStepOf(entry).browser ?? [])
}

/**
 * A batch's answer, back in its steps. The tool writes one `[i/n] operation: …`
 * line per step and that step's own answer under it, so those numbered lines are
 * the only thing that says where one step ends and the next begins.
 */
function splitBatchText(text: string | undefined): readonly (string | undefined)[] {
  const parts: (string | undefined)[] = []
  let at = -1
  for (const line of (text ?? '').split('\n')) {
    const head = /^\[(\d+)\/\d+\] /.exec(line)
    if (head !== null) {
      at = Number(head[1]) - 1
      parts[at] = line.slice(head[0].length)
    } else if (at >= 0 && parts[at] !== undefined) {
      parts[at] = `${parts[at]}\n${line}`
    }
  }
  return parts
}

/** One step's `[i/n]` line without its `operation:` head, and whether that step was the one that failed. */
function splitVerdict(text: string, operation: string): { readonly text: string; readonly failed: boolean } {
  const failed = `${operation} failed: `
  if (text.startsWith(failed)) return { text: text.slice(failed.length), failed: true }
  const plain = `${operation}: `
  return { text: text.startsWith(plain) ? text.slice(plain.length) : text, failed: false }
}

/** One line of the expanded body's parameter list. */
export interface BrowserParam {
  readonly label: string
  readonly value: string
}

/**
 * The call's own arguments, in the order they read, leaving out what the row
 * already said and what only the model cares about (`tabId`, the wait budget).
 * A screenshot's only argument is whether it waited, which the row's picture
 * answers better than a line of text.
 */
export function browserParams(step: BrowserStep): readonly BrowserParam[] {
  const { input } = step
  switch (step.operation) {
    case 'browser.create_tab':
    case 'tab.navigate':
      return params([['网址', string(input['url'])]])
    case 'page.click':
      return params([
        ['目标', elementTarget(input)],
        ['按键', input['button'] === undefined ? undefined : STRINGS[String(input['button'])]],
        ['次数', count(input['clickCount'])],
      ])
    case 'page.click_at':
      return params([['坐标', `(${value(input['x'])}, ${value(input['y'])})`], ['按键', string(input['button'])]])
    case 'page.type':
      return params([
        ['目标', elementTarget(input)],
        ['文本', clip(string(input['text']) ?? '')],
        ...(input['clear'] === true ? [['先清空', '是'] as const] : []),
        ...(input['submit'] === true ? [['回车提交', '是'] as const] : []),
      ])
    case 'page.press_key':
      return params([['目标', elementTarget(input)], ['按键', keys(input['keys'])]])
    case 'page.select_option':
      return params([
        ['目标', elementTarget(input)],
        ['值', string(input['value'])],
        ['标签', string(input['label'])],
        ['序号', value(input['index'])],
      ])
    case 'page.set_checked':
      return params([['目标', elementTarget(input)], ['勾选', input['checked'] === true ? '是' : '否']])
    case 'page.hover':
      return params([['目标', elementTarget(input)]])
    case 'page.scroll':
      return params([
        ['目标', elementTarget(input)],
        ['方向', input['direction'] === undefined ? undefined : STRINGS[String(input['direction'])]],
        ['距离', input['amount'] === undefined ? undefined : `${value(input['amount'])} px`],
      ])
    case 'page.wait_for':
      return params([
        ['选择器', string(input['selector'])],
        ['文本', string(input['text'])],
        ['状态', input['state'] === undefined ? undefined : STRINGS[String(input['state'])]],
        ['网址', string(input['url'])],
        ['稳定', input['stableForMs'] === undefined ? undefined : `${value(input['stableForMs'])} ms`],
      ])
    case 'tab.wait_for_load':
      return params([['等到', input['until'] === undefined ? undefined : STRINGS[String(input['until'])] ?? string(input['until'])]])
    case 'tab.emulate':
      return params([
        ['预设', string(input['preset'])],
        ['尺寸', dimensions(input)],
        ['像素比', value(input['deviceScaleFactor'])],
      ])
    case 'page.elements.snapshot':
    case 'page.text.snapshot':
      return params([['范围', string(input['scope'])], ['角色', string(input['role'])], ['文本', string(input['text'])]])
    default:
      return []
  }
}

const STRINGS: Readonly<Record<string, string | undefined>> = {
  left: '左键', right: '右键', middle: '中键',
  up: '向上', down: '向下', top: '到顶部', bottom: '到底部',
  visible: '可见', hidden: '隐藏', attached: '已加载', detached: '已移除',
  enabled: '可用', disabled: '不可用', checked: '已勾选', unchecked: '未勾选',
  domcontentloaded: 'DOM 就绪', load: '加载完成', networkidle: '网络空闲',
}

function params(entries: readonly (readonly [string, string | undefined])[]): readonly BrowserParam[] {
  return entries.flatMap(([label, value]) => (value === undefined || value.length === 0 ? [] : [{ label, value }]))
}

function verb(value: string, target = ''): BrowserRow {
  return { verb: value, target }
}

/** The element a call pointed at, named the way the model named it: the ref it read, else the selector. */
function elementTarget(input: Readonly<Record<string, unknown>>): string {
  return string(input['ref']) ?? string(input['selector']) ?? ''
}

function size(input: Readonly<Record<string, unknown>>): string {
  return string(input['preset']) ?? dimensions(input)
}

function dimensions(input: Readonly<Record<string, unknown>>): string {
  const width = input['width']
  const height = input['height']
  return width === undefined || height === undefined ? '' : `${value(width)}×${value(height)}`
}

function keys(value: unknown): string {
  return Array.isArray(value) ? value.filter((key) => typeof key === 'string').join(' + ') : ''
}

/** Only the origin's host: a row has one line, and the path is the page's own business. */
function host(url: unknown): string {
  const raw = string(url)
  if (raw === undefined) return ''
  try {
    return new URL(raw).host || raw
  } catch {
    return raw
  }
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function value(input: unknown): string | undefined {
  return typeof input === 'number' ? String(input) : string(input)
}

function count(input: unknown): string | undefined {
  return typeof input === 'number' && input > 1 ? `×${input}` : undefined
}

/** A parameter line is a line, not a document: the text was typed field by field. */
function clip(text: string): string {
  return text.length > 600 ? `${text.slice(0, 599)}…` : text
}