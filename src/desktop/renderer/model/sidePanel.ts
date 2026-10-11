/**
 * The right-hand panel's decisions, as data: which switch governs it for the
 * session on screen, which tab it shows, and what the thread tag above the
 * composer says. Pure, from wire types only.
 *
 * A coordinator or thread session has its own 概览 switch, remembered per
 * project; the browser and sub-agent views become extra tabs beside 概览 there.
 * An ordinary session keeps the browser switch and shows one view at a time.
 */

import type { WireCoordinationThreads } from '../../shellProtocol.js'
import { coordinationCounts, threadBlocked } from './coordinationStatus.js'

export type SideTab = 'browser' | 'plan' | 'subagents' | 'threads'
export type ExtraTab = 'browser' | 'plan' | 'subagents'

export const OVERVIEW_CLOSED_STORAGE_KEY = 'hanekawa.overviewClosed.v1'

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

export interface SidePanelInput {
  /** The session on screen is a coordinator or a thread. */
  readonly coordinated: boolean
  readonly browserOpen: boolean
  readonly sideTab: SideTab
  readonly extras: ReadonlySet<ExtraTab>
  readonly overviewClosed: boolean
}

export function sidePanelView(input: SidePanelInput): { open: boolean; tab: SideTab } {
  if (!input.coordinated) return { open: input.browserOpen, tab: input.sideTab }
  const tab = input.sideTab !== 'threads' && input.extras.has(input.sideTab) ? input.sideTab : 'threads'
  return { open: !input.overviewClosed, tab }
}

export interface SideTabEntry {
  readonly tab: SideTab
  /** An extra tab beside 概览 can be closed back to it. */
  readonly closable: boolean
}

/** The tab strip, in order. `has.coordination` is whether the project has a coordinator or threads. */
export function sideTabEntries(
  input: SidePanelInput,
  tab: SideTab,
  has: { readonly coordination: boolean; readonly subagents: boolean; readonly plan: boolean },
): SideTabEntry[] {
  if (input.coordinated) {
    const extras = (['browser', 'plan', 'subagents'] as const).filter((tab) => input.extras.has(tab))
    return [{ tab: 'threads', closable: false }, ...extras.map((tab) => ({ tab, closable: true }))]
  }
  const entries: SideTabEntry[] = [{ tab: 'browser', closable: false }]
  if (has.plan || tab === 'plan') entries.push({ tab: 'plan', closable: false })
  if (has.subagents || tab === 'subagents') entries.push({ tab: 'subagents', closable: false })
  if (has.coordination || tab === 'threads') entries.push({ tab: 'threads', closable: false })
  return entries.length === 1 ? [] : entries
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

/** Extra tabs that still have something behind them on the session now on screen. */
export function pruneExtras(
  extras: ReadonlySet<ExtraTab>,
  has: { readonly browserTabs: boolean; readonly subagents: boolean; readonly plan: boolean },
): Set<ExtraTab> {
  const kept = new Set(extras)
  if (!has.browserTabs) kept.delete('browser')
  if (!has.subagents) kept.delete('subagents')
  if (!has.plan) kept.delete('plan')
  return kept
}

export function keepSelectedSubagent(selected: string | undefined, ids: readonly string[]): string | undefined {
  return selected !== undefined && ids.includes(selected) ? selected : undefined
}
