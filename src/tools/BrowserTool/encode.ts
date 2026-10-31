/**
 * What the non-snapshot operations look like on the way back.
 *
 * Snapshots arrive already rendered — `desktop/browser/encode.ts` did that work
 * inside the projection, and re-wrapping it here would only add a second header
 * to parse. What is left is the tab table, which is the same TSV shape for the
 * same reason: one header line, one line per tab, no punctuation to spend.
 */

import type { BrowserTabState } from '../../runtime/protocol/browserHost.js'

export const TAB_COLUMNS = ['tabId', 'url', 'title', 'flags'] as const

export const NO_TABS = 'No browser tabs are open. Use browser.create_tab to open one.'

export function renderTabs(tabs: readonly BrowserTabState[]): string {
  if (tabs.length === 0) return NO_TABS
  // File names can hold spaces and tabs, so they go below the table, not in `flags`.
  const blocked = tabs.flatMap((tab) =>
    (tab.blockedDownloads ?? []).map((name) => `Blocked a download in tab ${tab.tabId}: ${JSON.stringify(name)} (downloads are cancelled).`),
  )
  // Same reason, and one more: what a page says on its own console is often the
  // whole explanation for "the click did nothing", and it is far too long for a
  // column.
  const errors = tabs.flatMap((tab) =>
    (tab.consoleErrors ?? []).map((message) => `Console error in tab ${tab.tabId}: ${message}`),
  )
  return [TAB_COLUMNS.join('\t'), ...tabs.map(renderTabRow), ...blocked, ...errors].join('\n')
}

/**
 * The page's console errors, as a block under whatever read the page, or `''`.
 *
 * Reported once each — the host hands them over and forgets — so this is the
 * model's only chance to see them.
 */
export function renderConsoleErrors(errors: readonly string[]): string {
  if (errors.length === 0) return ''
  return ['Console errors the page logged:', ...errors.map((error) => `- ${error}`)].join('\n')
}

export function renderTabRow(tab: BrowserTabState): string {
  const flags: string[] = []
  if (tab.loading) flags.push('loading')
  if (tab.takenOver === true) flags.push('takenOver')
  if (tab.error !== undefined) flags.push(`error=${tab.error}`)
  return [tab.tabId, tab.url, tab.title, flags.join(' ')].join('\t')
}

/** The header line above a single tab's answer, e.g. after a navigation. */
export function describeTab(tab: BrowserTabState): string {
  return renderTabs([tab])
}

/** The one-line collapsed summary the UI shows beside the call. */
export function summarizeTabs(tabs: readonly BrowserTabState[]): string {
  return tabs.length === 1 ? '1 tab' : `${tabs.length} tabs`
}

/** A host URL, or the whole string when it is not a URL at all. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
