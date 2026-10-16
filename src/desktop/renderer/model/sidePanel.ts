/**
 * The right-hand panel's decisions, as data: which switch governs it for the
 * session on screen, which of its two modes it shows, which sections the
 * overview stacks, and what the thread tag above the composer says. Pure, from
 * wire types only.
 *
 * The panel has two modes. The browser is a native view that needs one steady
 * rectangle, so it never joins a stack; the overview is a column of collapsible
 * sections (plan, sub-agents, threads), each present only while it has something
 * to show. A coordinator or thread session has its own 概览 switch, remembered per
 * project; an ordinary session keeps the browser switch.
 */

import type { WireCoordinationThreads } from '../../shellProtocol.js'
import { coordinationCounts, threadBlocked } from './coordinationStatus.js'

export type SideMode = 'browser' | 'overview'
export type SideSection = 'plan' | 'subagents' | 'threads'

export const SIDE_SECTIONS: readonly SideSection[] = ['plan', 'subagents', 'threads']

export const OVERVIEW_CLOSED_STORAGE_KEY = 'hanekawa.overviewClosed.v1'
export const SECTIONS_COLLAPSED_STORAGE_KEY = 'hanekawa.sideSections.v1'

/** The projects whose overview the user closed. Takes the raw `localStorage` string. */
export function parseOverviewClosed(raw: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === 'string') : [])
  } catch {
    return new Set()
  }
}

export function serializeOverviewClosed(closed: ReadonlySet<string>): string {
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
  readonly browserOpen: boolean
  /** The mode the user last chose for this kind of session. */
  readonly mode: SideMode
  readonly overviewClosed: boolean
  /**
   * What each part has behind it. `browser` is always true for an ordinary
   * session; a coordination session has it only once the browser was raised
   * there and its lane still has a tab.
   */
  readonly has: { readonly browser: boolean; readonly plan: boolean; readonly subagents: boolean; readonly threads: boolean }
}

export interface SidePanelView {
  readonly open: boolean
  readonly mode: SideMode
  /** Modes the strip offers; it is drawn only when there are two. */
  readonly modes: readonly SideMode[]
  /** The overview's sections that have content, in stacking order. */
  readonly sections: readonly SideSection[]
}

export function sidePanelView(input: SidePanelInput): SidePanelView {
  const sections = SIDE_SECTIONS.filter((section) => input.has[section])
  const modes: SideMode[] = []
  if (input.has.browser) modes.push('browser')
  if (sections.length > 0) modes.push('overview')
  const mode = modes.includes(input.mode) ? input.mode : modes[0] ?? 'browser'
  return { open: input.coordinated ? !input.overviewClosed : input.browserOpen, mode, modes, sections }
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
export function autoOpensOverview(started: boolean, overviewClosed: boolean): boolean {
  return started && !overviewClosed
}

export interface ThreadStripView {
  /** Every thread the project still has a session for, finished or not. */
  readonly total: number
  readonly running: number
  readonly blocked: number
  /** One thread needing the user goes straight to the main canvas; otherwise the overview opens. */
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

/** The overview's head: the project's thread counts in one line, and whether 全部停止 has anything to stop. */
export function overviewHeadView(strip: ThreadStripView | undefined): { readonly summary: string; readonly canStopAll: boolean } | undefined {
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
