import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SIDE_WIDTH_MAX,
  SIDE_WIDTH_MIN,
  SIDE_WIDTH_STORAGE_KEYS,
  addressLabel,
  browserControlState,
  browserOverlay,
  clampSideWidth,
  newTabsForLane,
  normalizeAddress,
  parseSideWidth,
  resolveActiveTab,
  shouldShowBrowserView,
  tabLabel,
  tabsForLane,
} from '../src/desktop/renderer/model/browserPanel.js'
import type { WireBrowserTabInfo } from '../src/desktop/shellProtocol.js'

/**
 * The browser panel's decisions, without a window.
 *
 * Everything the panel has to get right that is *not* compositing — which lane's
 * tabs are on screen, which one survives a close, when the native view may
 * paint, and what a typed address means — is arithmetic over data and is tested
 * here. The `WebContentsView` actually covering its hole is the smoke's job.
 */

function tab(overrides: Partial<WireBrowserTabInfo> & { tabId: string; lane: string }): WireBrowserTabInfo {
  return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, ...overrides }
}

// --- width ---------------------------------------------------------------------

test('a panel width is clamped to its bounds and rounded', () => {
  assert.equal(clampSideWidth(SIDE_WIDTH_MIN - 200), SIDE_WIDTH_MIN)
  assert.equal(clampSideWidth(SIDE_WIDTH_MAX + 200), SIDE_WIDTH_MAX)
  assert.equal(clampSideWidth(512.6), 513)
})

test('no stored width, or one that is not a number, leaves the stylesheet default', () => {
  // The browser's default is a share of the window, which no stored number can
  // stand in for — so a bad value is not answered with the floor either.
  assert.equal(parseSideWidth(null), undefined)
  assert.equal(parseSideWidth('not a width'), undefined)
  assert.equal(parseSideWidth(String(SIDE_WIDTH_MAX + 500)), SIDE_WIDTH_MAX)
})

test('each mode remembers its own width', () => {
  assert.notEqual(SIDE_WIDTH_STORAGE_KEYS.browser, SIDE_WIDTH_STORAGE_KEYS.overview)
})

// --- which tabs ------------------------------------------------------------------

test('a lane sees only its own tabs, and no lane sees none', () => {
  const tabs = [tab({ tabId: 'a', lane: '1' }), tab({ tabId: 'b', lane: '2' }), tab({ tabId: 'c', lane: '1' })]
  assert.deepEqual(tabsForLane(tabs, '1').map((t) => t.tabId), ['a', 'c'])
  // Before the first `activate` there is no active pane. Answering with every
  // lane's tabs would draw another session's browser.
  assert.deepEqual(tabsForLane(tabs, undefined), [])
})

test('the preferred tab wins while it exists, and its neighbour inherits when it closes', () => {
  const tabs = [tab({ tabId: 'a', lane: '1' }), tab({ tabId: 'b', lane: '1' })]
  assert.equal(resolveActiveTab(tabs, '1', 'a'), 'a')
  // 'a' was closed: the fallback is the last remaining tab, so closing the
  // active tab lands on a neighbour rather than on an empty panel.
  assert.equal(resolveActiveTab([tabs[1]!], '1', 'a'), 'b')
  assert.equal(resolveActiveTab(tabs, '1', undefined), 'b')
  assert.equal(resolveActiveTab(tabs, '2', undefined), undefined)
})

test('only an arriving tab is new, and only on the lane on screen', () => {
  const tabs = [tab({ tabId: 'a', lane: '1' }), tab({ tabId: 'b', lane: '2' })]
  assert.deepEqual(newTabsForLane(tabs, '1', new Set()).map((t) => t.tabId), ['a'])
  // The same tab, loaded / renamed / navigated: a change, not an arrival. This
  // is the whole of what keeps a panel the user closed from springing open.
  const changed = [tab({ tabId: 'a', lane: '1', title: '载入完成', url: 'https://example.com' })]
  assert.deepEqual(newTabsForLane(changed, '1', new Set(['a', 'b'])), [])
  assert.deepEqual(newTabsForLane(tabs, undefined, new Set()), [])
})

// --- who is driving ------------------------------------------------------------------

test('the control reads the tab: nobody driving, agent driving, user holding', () => {
  const idle = browserControlState(tab({ tabId: 'a', lane: '1' }))
  assert.equal(idle.disabled, true)
  assert.equal(idle.action, 'none')
  assert.match(idle.title, /没有 agent/)

  const driven = browserControlState(tab({ tabId: 'a', lane: '1', agentActive: true }))
  assert.deepEqual([driven.label, driven.disabled, driven.action], ['接管', false, 'take-over'])

  // Taken over reads as the way back, whether or not the tab still claims a
  // driver: the badge and the button are one state.
  const held = browserControlState(tab({ tabId: 'a', lane: '1', agentActive: true, takenOver: true }))
  assert.deepEqual([held.label, held.disabled, held.action], ['交还', false, 'release'])
  assert.equal(browserControlState(undefined).disabled, true)
})

// --- visibility --------------------------------------------------------------------

test('the native view paints only when every condition holds', () => {
  const base = {
    open: true,
    hasActiveTab: true,
    occluded: false,
    windowHidden: false,
    overlaid: false,
  }
  assert.equal(shouldShowBrowserView(base), true)
  assert.equal(shouldShowBrowserView({ ...base, open: false }), false)
  assert.equal(shouldShowBrowserView({ ...base, hasActiveTab: false }), false)
  // These three are the ones a DOM-only panel would forget: a WebContentsView
  // is not in the document, so neither a covering screen, nor a hidden window,
  // nor the panel's own error page stops it painting on its own.
  assert.equal(shouldShowBrowserView({ ...base, occluded: true }), false)
  assert.equal(shouldShowBrowserView({ ...base, windowHidden: true }), false)
  assert.equal(shouldShowBrowserView({ ...base, overlaid: true }), false)
})

// --- the hole's own page ----------------------------------------------------------

test('a tab that has never navigated is blank, and one that is loading is not', () => {
  assert.deepEqual(browserOverlay(tab({ tabId: 'a', lane: '1' })), { kind: 'blank' })
  // The first navigation has begun and the page is about to paint; our own
  // text over it would be a flash.
  assert.deepEqual(browserOverlay(tab({ tabId: 'a', lane: '1', loading: true })), { kind: 'none' })
  assert.deepEqual(
    browserOverlay(tab({ tabId: 'a', lane: '1', url: 'https://example.com/' })),
    { kind: 'none' },
  )
  assert.deepEqual(browserOverlay(undefined), { kind: 'none' })
})

test('a failed navigation names the address it was about, not the page still loaded', () => {
  // Nothing committed, so `url` is the page the tab was showing before the
  // attempt. The error page — and the address bar — are about the other one.
  const failed = tab({
    tabId: 'a',
    lane: '1',
    url: 'https://example.com/',
    error: 'ERR_NAME_NOT_RESOLVED',
    errorUrl: 'https://nope.invalid/x',
  })
  assert.deepEqual(browserOverlay(failed), {
    kind: 'error',
    url: 'https://nope.invalid/x',
    reason: '域名找不到',
  })
  assert.equal(addressLabel(failed), 'nope.invalid')
})

test('the three named causes read as words, and anything else keeps its code', () => {
  const reason = (error: string): string => {
    const overlay = browserOverlay(tab({ tabId: 'a', lane: '1', error }))
    assert.equal(overlay.kind, 'error')
    return overlay.kind === 'error' ? overlay.reason : ''
  }
  assert.equal(reason('ERR_CONNECTION_REFUSED'), '连接被拒')
  assert.equal(reason('ERR_CONNECTION_TIMED_OUT'), '连接超时')
  // An unmapped code is not flattened into 「其他」: it is the only handle the
  // user has for searching what actually went wrong.
  assert.equal(reason('ERR_SSL_PROTOCOL_ERROR'), 'ERR_SSL_PROTOCOL_ERROR')
})

// --- the address bar ------------------------------------------------------------------

test('a bare host gets https, and a full URL is preserved', () => {
  assert.equal(normalizeAddress('example.com'), 'https://example.com/')
  assert.equal(normalizeAddress('  example.com/a?b=1 '), 'https://example.com/a?b=1')
  assert.equal(normalizeAddress('http://example.com/x'), 'http://example.com/x')
})

test('host:port is a host, and a local one gets http', () => {
  assert.equal(normalizeAddress('localhost:3000'), 'http://localhost:3000/')
  assert.equal(normalizeAddress('localhost:3000/api?x=1'), 'http://localhost:3000/api?x=1')
  assert.equal(normalizeAddress('localhost'), 'http://localhost/')
  assert.equal(normalizeAddress('127.0.0.1:8080'), 'http://127.0.0.1:8080/')
  assert.equal(normalizeAddress('192.168.1.20:5173'), 'http://192.168.1.20:5173/')
  assert.equal(normalizeAddress('[::1]:8000'), 'http://[::1]:8000/')
  assert.equal(normalizeAddress('example.com:8443'), 'https://example.com:8443/')
  // A scheme the user typed is theirs, local host or not.
  assert.equal(normalizeAddress('https://localhost:3000'), 'https://localhost:3000/')
  assert.equal(normalizeAddress('172.32.0.1'), 'https://172.32.0.1/')
})

test('anything but http and https is not an address', () => {
  // `file:` by name: this partition is the agent's browsing context, and a
  // file:// document there reads the user's disk with a page's privileges.
  assert.equal(normalizeAddress('file:///etc/passwd'), undefined)
  assert.equal(normalizeAddress('javascript:alert(1)'), undefined)
  assert.equal(normalizeAddress('data:text/html,<b>x'), undefined)
  assert.equal(normalizeAddress(''), undefined)
  assert.equal(normalizeAddress('   '), undefined)
})

test('a typo stays a typo — there is no search fallback', () => {
  // Falling back to a search engine would ship whatever the user typed, which
  // may be a path or a password, to a third party on a slip of the keyboard.
  assert.equal(normalizeAddress('https://'), undefined)
})

// --- labels -----------------------------------------------------------------------------

test('a tab reads as its title, then its host, then a placeholder', () => {
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1', title: '示例', url: 'https://example.com/x' })), '示例')
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1', url: 'https://example.com/x' })), 'example.com')
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1' })), '新标签页')
})

test('the address bar shows a host, and shows nothing for a tab that never navigated', () => {
  assert.equal(addressLabel(tab({ tabId: 'a', lane: '1', url: 'https://example.com/deep/path' })), 'example.com')
  assert.equal(addressLabel(tab({ tabId: 'a', lane: '1' })), '')
  assert.equal(addressLabel(undefined), '')
})
