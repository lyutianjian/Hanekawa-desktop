/**
 * The right-hand panel's decisions, as data: which switch governs it for the
 * session on screen, which page it shows, which sections the task page stacks,
 * and what the thread tag above the composer says. Pure, from wire types only.
 *
 * Each page has its own button at the title bar's far end: 任务 (a column of
 * collapsible sections — plan, background commands, sub-agents — each present
 * only while it has something to show), 线程 (only where the project has
 * coordination), 改动 (the session's edited files) and 浏览器, a native view
 * that needs one steady rectangle. A coordinator or thread session's open state
 * is remembered per project; an ordinary session's per lane.
 */

import type { WireCoordinationThreads } from '../../shellProtocol.js'
import { coordinationCounts, threadBlocked } from './coordinationStatus.js'

export type SideMode = 'tasks' | 'threads' | 'changes' | 'browser'
export type SideSection = 'plan' | 'commands' | 'subagents'

export const SIDE_SECTIONS: readonly SideSection[] = ['plan', 'commands', 'subagents']

export const SIDE_MODE_LABELS: Readonly<Record<SideMode, string>> = {
  tasks: '任务',
  threads: '线程',
  changes: '改动',
  browser: '浏览器',
}

/** The key predates the task page; kept so the stored choice carries over. */
export const PANEL_CLOSED_STORAGE_KEY = 'hanekawa.overviewClosed.v1'
export const SECTIONS_COLLAPSED_STORAGE_KEY = 'hanekawa.sideSections.v1'

/** The coordination projects whose panel the user closed. Takes the raw `localStorage` string. */
export function parsePanelClosed(raw: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === 'string') : [])
  } catch {
    return new Set()
  }
}

export function serializePanelClosed(closed: ReadonlySet<string>): string {
  return JSON.stringify([...closed])
}

/** The sections each project's user folded; everything else is open. */
export type SectionsCollapsed = ReadonlyMap<string, ReadonlySet<SideSection>>

export function parseSectionsCollapsed(raw: string | null): SectionsCollapsed {
  const result = new Map<string, Set<SideSection>>()
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result
    for (const [root, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const folded = value.filter((section): section is SideSection => SIDE_SECTIONS.includes(section))
      if (folded.length > 0) result.set(root, new Set(folded))
    }
  } catch {
    // Bad storage reads as nothing folded.
  }
  return result
}

export function serializeSectionsCollapsed(collapsed: SectionsCollapsed): string {
  return JSON.stringify(Object.fromEntries([...collapsed].map(([root, folded]) => [root, [...folded]])))
}

export function isSectionCollapsed(collapsed: SectionsCollapsed, root: string | undefined, section: SideSection): boolean {
  return root !== undefined && collapsed.get(root)?.has(section) === true
}

/** The map with one section of one project folded or opened; the input is left alone. */
export function withSectionCollapsed(collapsed: SectionsCollapsed, root: string, section: SideSection, fold: boolean): SectionsCollapsed {
  const next = new Map(collapsed)
  const folded = new Set(collapsed.get(root))
  if (fold) folded.add(section)
  else folded.delete(section)
  if (folded.size > 0) next.set(root, folded)
  else next.delete(root)
  return next
}

export interface SidePanelInput {
  /** The session on screen is a coordinator or a thread. */
  readonly coordinated: boolean
  /** An ordinary session's switch, per lane. */
  readonly laneOpen: boolean
  /** The mode the user last chose for this kind of session. */
  readonly mode: SideMode
  /** A coordination session's switch, per project. */
  readonly panelClosed: boolean
  /** What each part has behind it. */
  readonly has: {
    readonly plan: boolean
    readonly commands: boolean
    readonly subagents: boolean
    readonly threads: boolean
  }
}

export interface SidePanelView {
  readonly open: boolean
  readonly mode: SideMode
  /** The title bar's buttons, left to right. */
  readonly modes: readonly SideMode[]
  /** The task page's sections that have content, in stacking order. */
  readonly sections: readonly SideSection[]
}

export function sidePanelView(input: SidePanelInput): SidePanelView {
  const sections = SIDE_SECTIONS.filter((section) => input.has[section])
  const modes: SideMode[] = input.has.threads ? ['tasks', 'threads', 'changes', 'browser'] : ['tasks', 'changes', 'browser']
  const mode = modes.includes(input.mode) ? input.mode : 'tasks'
  return { open: input.coordinated ? !input.panelClosed : input.laneOpen, mode, modes, sections }
}

/**
 * The sections to draw. A page opened inside a section (a sub-agent's or a
 * thread's transcript) needs the column's height, so it stands alone while it
 * is open and unfolded; the others come back on its back button.
 */
export function visibleSections(
  sections: readonly SideSection[],
  collapsed: ReadonlySet<SideSection>,
  page: SideSection | undefined,
): { readonly sections: readonly SideSection[]; readonly focus: SideSection | undefined } {
  const focus = page !== undefined && sections.includes(page) && !collapsed.has(page) ? page : undefined
  return { sections: focus === undefined ? sections : [focus], focus }
}

/** A new thread raises the panel only for a user who has not closed it for that project. */
export function autoOpensThreads(started: boolean, panelClosed: boolean): boolean {
  return started && !panelClosed
}

export interface ThreadStripView {
  /** Every thread the project still has a session for, finished or not. */
  readonly total: number
  readonly running: number
  readonly blocked: number
  /** One thread needing the user goes straight to the main canvas; otherwise the thread page opens. */
  readonly target: { readonly kind: 'thread'; readonly sessionId: string } | { readonly kind: 'overview' }
}

/** The chip under a coordination session's messages: there whenever the project has a thread. */
export function threadStripView(
  coordinated: boolean,
  state: WireCoordinationThreads | undefined,
): ThreadStripView | undefined {
  if (!coordinated || state === undefined) return undefined
  const threads = state.threads.filter((thread) => thread.status !== 'stale')
  if (threads.length === 0) return undefined
  const { running, blocked } = coordinationCounts(threads)
  const needsYou = threads.filter((thread) => thread.status === 'needs-you')
  const only = needsYou.length === 1 ? needsYou[0] : undefined
  return { total: threads.length, running, blocked, target: only ? { kind: 'thread', sessionId: only.sessionId } : { kind: 'overview' } }
}

/** The chip's words, the counts that are zero left out. */
export function threadStripText(view: ThreadStripView): { total: string; running: string | undefined; blocked: string | undefined } {
  return {
    total: `${view.total} 个线程`,
    running: view.running > 0 ? `· ${view.running} 个运行中` : undefined,
    blocked: view.blocked > 0 ? `· ${view.blocked} 个需要你` : undefined,
  }
}

/** The thread page's head: the project's thread counts in one line, and whether 全部停止 has anything to stop. */
export function threadsHeadView(strip: ThreadStripView | undefined): { readonly summary: string; readonly canStopAll: boolean } | undefined {
  if (strip === undefined) return undefined
  const text = threadStripText(strip)
  return {
    summary: [text.total, text.running, text.blocked].filter((part) => part !== undefined).join(' '),
    canStopAll: strip.running + strip.blocked > 0,
  }
}

export function keepSelectedSubagent(selected: string | undefined, ids: readonly string[]): string | undefined {
  return selected !== undefined && ids.includes(selected) ? selected : undefined
}
