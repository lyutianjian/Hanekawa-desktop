/**
 * The browser panel: a tab strip, an address row, and a hole.
 *
 * The hole is the whole point. A `WebContentsView` cannot be a node in this
 * document, so the panel draws everything *around* the page and reports where
 * the page should go; the main process puts a native view there. Three
 * consequences shape this file:
 *
 * - **Geometry is an output of this view, not an input.** Every path that can
 *   move the hole — a resize, a drag, a tab switch, the window being hidden —
 *   ends in one `onBounds` call. There is no other way for the page to learn
 *   where it lives.
 * - **Visibility is explicit.** Nothing the stylesheet does can stop a native
 *   view painting, so "the settings screen covers us" and "the window is
 *   hidden" have to be *told*, not merely styled.
 * - **Unmounting must hide the page.** A panel that goes away without saying so
 *   leaves a web page floating over the window with nothing under it.
 *
 * Decisions live in `model/browserPanel.ts`; this file turns them into nodes.
 */

import { el, replace, required, show } from './dom.js'
import { button } from './controls.js'
import { icon } from './icons.js'
import type { WireBrowserRect, WireBrowserTabInfo } from '../../shellProtocol.js'
import {
  addressLabel,
  browserBanner,
  browserControlState,
  browserOverlay,
  normalizeAddress,
  shouldShowBrowserView,
  tabLabel,
  tabsForLane,
  type BrowserOverlay,
} from '../model/browserPanel.js'

export interface BrowserPanelViewModel {
  /** Every tab the host knows, across every lane. */
  tabs: readonly WireBrowserTabInfo[]
  /** The lane currently on screen; its tabs are the only ones drawn. */
  lane: string | undefined
  activeTabId: string | undefined
  /** The user (or the agent, by opening a tab) asked for the panel. */
  open: boolean
  /** Something in the document covers the panel — the settings screen. */
  occluded: boolean
}

export interface BrowserPanelHandlers {
  onSelectTab(tabId: string): void
  onCloseTab(tabId: string): void
  onNewTab(): void
  onNavigate(tabId: string, url: string): void
  onBack(tabId: string): void
  onForward(tabId: string): void
  onReload(tabId: string): void
  onTakeOver(tabId: string): void
  /** The user handed the tab back to the agent, before sending it a message. */
  onRelease(tabId: string): void
  /** The hole moved, or the page's right to paint changed. */
  onBounds(tabId: string, rect: WireBrowserRect, visible: boolean): void
}

export interface BrowserPanelView {
  render(model: BrowserPanelViewModel): void
  /** Re-measures the hole and re-pushes. Safe to call at any time. */
  measure(): void
  dispose(): void
}

export function createBrowserPanelView(
  nodes: {
    panel: HTMLElement
    tabs: HTMLElement
    address: HTMLElement
    banner: HTMLElement
    hole: HTMLElement
  },
  handlers: BrowserPanelHandlers,
): BrowserPanelView {
  let model: BrowserPanelViewModel = {
    tabs: [],
    lane: undefined,
    activeTabId: undefined,
    open: false,
    occluded: false,
  }
  /** The last push, so an unchanged rect does not cross the wire every frame. */
  let pushed: { tabId: string; rect: WireBrowserRect; visible: boolean } | undefined
  let disposed = false

  // --- the address row, built once ----------------------------------------------
  //
  // Persistent nodes, the same discipline `canvasHeaderView.ts` follows for its
  // rename field: rebuilding an input on every repaint would drop the caret
  // mid-word, and this row repaints on every title change of a loading page.

  const back = button('browser-nav', '←', '后退', () => withActive(handlers.onBack))
  const forward = button('browser-nav', '→', '前进', () => withActive(handlers.onForward))
  const reload = button('browser-nav', '↻', '重新加载', () => withActive(handlers.onReload))
  const url = el('input', 'browser-url')
  url.id = 'browser-url'
  url.type = 'text'
  url.spellcheck = false
  url.placeholder = '输入网址'
  url.setAttribute('aria-label', '网址')
  // One control, three states — see `browserControlState`. Its label and its
  // meaning move together, so the press reads the model rather than a captured
  // handler: a button that says「交还」and reports a takeover would be the worst
  // of the possible bugs here.
  const takeOver = button('browser-nav browser-takeover', '接管', '接管此标签页，暂停 agent 的浏览器操作', () => {
    const action = browserControlState(activeTab()).action
    if (action === 'take-over') withActive(handlers.onTakeOver)
    else if (action === 'release') withActive(handlers.onRelease)
  })
  replace(nodes.address, back, forward, reload, url, takeOver)

  url.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Takes back what was typed; with nothing typed it leaves the field.
      event.preventDefault()
      event.stopPropagation()
      const current = addressLabel(activeTab())
      if (url.value === current) url.blur()
      else url.value = current
      return
    }
    if (event.key !== 'Enter') return
    // Scoped to the field, and stopped here: Enter in an address bar is a
    // navigation, never a composer submit.
    event.preventDefault()
    event.stopPropagation()
    const target = normalizeAddress(url.value)
    const tabId = model.activeTabId
    if (target === undefined || tabId === undefined) return
    handlers.onNavigate(tabId, target)
    url.blur()
  })
  // Leaving the field abandons whatever was half-typed: the bar is a view of the
  // page's address, and a stale draft sitting in it would misreport where the
  // user actually is.
  url.addEventListener('blur', () => {
    url.value = addressLabel(activeTab())
  })

  // --- the hole's own page, built once ---------------------------------------------
  //
  // Two states the site cannot draw for itself: a tab that has never navigated,
  // and one whose navigation failed. Both live *inside* the hole and are
  // absolutely positioned there, so neither changes the rect the page is parked
  // on — and both are drawn only while the native view is told not to paint,
  // because a `WebContentsView` sits above this document entirely.

  const blank = el('p', 'browser-blank', '在上方输入网址开始浏览')
  const failedAddress = el('p', 'browser-error-address')
  const failedReason = el('p', 'browser-error-reason')
  /** The address the error page is about, so 「重试」 does not need the bar re-typed. */
  let failedUrl: string | undefined
  const failure = el(
    'div',
    'browser-error',
    el('p', 'browser-error-title', '无法打开此页面'),
    failedAddress,
    failedReason,
    button('browser-error-retry', '重试', '重新加载此页面', () => {
      const tabId = model.activeTabId
      if (tabId === undefined || failedUrl === undefined || failedUrl === '') return
      handlers.onNavigate(tabId, failedUrl)
    }),
  )
  replace(nodes.hole, blank, failure)

  // --- geometry -------------------------------------------------------------------

  function activeTab(): WireBrowserTabInfo | undefined {
    if (model.activeTabId === undefined) return undefined
    return model.tabs.find((tab) => tab.tabId === model.activeTabId)
  }

  function withActive(run: (tabId: string) => void): void {
    const tabId = model.activeTabId
    if (tabId !== undefined) run(tabId)
  }

  function measure(): void {
    if (disposed) return
    const tabId = model.activeTabId
    // No tab means nothing to position. The *hiding* of a page whose tab just
    // closed is not this branch's job — the host drops the view with the tab.
    if (tabId === undefined) {
      pushed = undefined
      return
    }

    const visible = shouldShowBrowserView({
      open: model.open,
      hasActiveTab: true,
      occluded: model.occluded,
      // `document.hidden`, not `visibilityState`: the boolean is the whole
      // question here — the page may not paint while the window is not being
      // shown — and reading the enum would mean spelling one of its values.
      windowHidden: document.hidden,
      // Read here rather than passed in: `measure()` runs on a resize and on a
      // visibility change too, with no render in between.
      overlaid: browserOverlay(activeTab()).kind !== 'none',
    })
    const box = nodes.hole.getBoundingClientRect()
    const rect: WireBrowserRect = {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
    }

    // A hole inside a `display: none` subtree measures as zeros (and, under the
    // test stub, as `NaN`). Pushing that would park the page at the origin at
    // zero size and then "restore" it a frame later, which reads as a flash.
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return

    if (
      pushed !== undefined &&
      pushed.tabId === tabId &&
      pushed.visible === visible &&
      pushed.rect.x === rect.x &&
      pushed.rect.y === rect.y &&
      pushed.rect.width === rect.width &&
      pushed.rect.height === rect.height
    ) {
      return
    }
    pushed = { tabId, rect, visible }
    handlers.onBounds(tabId, rect, visible)
  }

  // Three subscriptions, because three different things move the hole and none
  // of them implies the others: the panel's own size (a drag, a collapsing
  // sidebar), the window's size, and the window's visibility.
  const onWindowResize = (): void => measure()
  const onVisibility = (): void => measure()
  window.addEventListener('resize', onWindowResize)
  document.addEventListener('visibilitychange', onVisibility)

  // `ResizeObserver` is the first use of it in this renderer, and the DOM test
  // stub has no implementation. Feature-detected rather than assumed so a view
  // built under the stub still renders and still measures on the other two
  // paths — the observer is an optimisation over them, not the only route.
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          measure()
        })
      : undefined
  observer?.observe(nodes.hole)

  // --- rendering ---------------------------------------------------------------------

  function render(next: BrowserPanelViewModel): void {
    if (disposed) return
    model = next
    const own = tabsForLane(next.tabs, next.lane)
    const panelVisible = next.open && !next.occluded

    show(nodes.panel, panelVisible)

    const rows = own.map((tab) => {
      const row = el('div', tabClass(tab, next.activeTabId))
      row.setAttribute('role', 'tab')
      row.setAttribute('aria-selected', String(tab.tabId === next.activeTabId))
      row.appendChild(tabIcon(tab))
      row.appendChild(el('span', 'browser-tab-label', tabLabel(tab)))
      row.appendChild(
        button('browser-tab-close', '✕', '关闭标签页', () => handlers.onCloseTab(tab.tabId)),
      )
      row.addEventListener('click', () => handlers.onSelectTab(tab.tabId))
      return row
    })
    replace(nodes.tabs, ...rows, button('browser-tab-new', '＋', '新建标签页', handlers.onNewTab))

    const tab = activeTab()
    back.disabled = tab === undefined || !tab.canGoBack
    forward.disabled = tab === undefined || !tab.canGoForward
    reload.disabled = tab === undefined
    const control = browserControlState(tab)
    takeOver.disabled = control.disabled
    takeOver.textContent = control.label
    takeOver.title = control.title
    takeOver.setAttribute('aria-label', control.title)
    // The accent pairs the button with the tab's own badge while the user holds
    // the tab: two marks for one state, gone together the moment it ends.
    takeOver.className = `browser-nav browser-takeover${control.action === 'release' ? ' holding' : ''}`
    // Never while the user is typing in it: this repaints on every title update
    // of a loading page, and overwriting a half-typed address would make the bar
    // unusable exactly when someone is trying to leave the page.
    if (document.activeElement !== url) url.value = addressLabel(tab)

    // Above the hole, not in it: the native view covers the hole entirely.
    // Showing it shrinks the hole, which the `measure()` below pushes.
    const banner = browserBanner(tab)
    nodes.banner.textContent = banner ?? ''
    show(nodes.banner, banner !== undefined)

    drawOverlay(browserOverlay(tab))

    // Last, and unconditional: a render that changed which tab is active, or
    // whether the panel is drawn at all, has moved the page.
    measure()
  }

  function drawOverlay(overlay: BrowserOverlay): void {
    show(blank, overlay.kind === 'blank')
    show(failure, overlay.kind === 'error')
    if (overlay.kind !== 'error') {
      failedUrl = undefined
      return
    }
    failedUrl = overlay.url
    // The whole address here, not the host the bar shows: which path failed is
    // half of what tells the user whether they mistyped it.
    failedAddress.textContent = overlay.url
    failedReason.textContent = overlay.reason
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('visibilitychange', onVisibility)
    observer?.disconnect()
    // The page is told to go before this view stops existing. Without it the
    // native view keeps painting over a panel that is no longer in the document
    // — a web page floating on the window with nothing beneath it.
    const tabId = model.activeTabId
    if (tabId !== undefined && pushed !== undefined) {
      handlers.onBounds(tabId, pushed.rect, false)
    }
    pushed = undefined
  }

  return { render, measure, dispose }
}

/**
 * The 16px slot at the head of a tab, in its three states.
 *
 * One slot, always the same size, because the point of it is that the strip
 * stays aligned: a spinner that replaced the icon by *inserting* a node would
 * shift every label sideways for the length of every load.
 */
function tabIcon(tab: WireBrowserTabInfo): HTMLElement | SVGSVGElement {
  if (tab.loading) return icon('spinner', 'icon browser-tab-icon loading')
  if (tab.favicon === undefined) return el('span', 'browser-tab-icon')
  const image = el('img', 'browser-tab-icon')
  image.setAttribute('src', tab.favicon)
  // Decoration beside a label that already names the site.
  image.setAttribute('alt', '')
  return image
}

function tabClass(tab: WireBrowserTabInfo, activeTabId: string | undefined): string {
  const classes = ['browser-tab']
  if (tab.tabId === activeTabId) classes.push('active')
  if (tab.takenOver === true) classes.push('taken-over')
  return classes.join(' ')
}

/** The ids `index.html` declares for the panel, resolved in one place. */
export function browserPanelNodes(): {
  panel: HTMLElement
  tabs: HTMLElement
  address: HTMLElement
  banner: HTMLElement
  hole: HTMLElement
} {
  return {
    panel: required('browser-view'),
    tabs: required('browser-tabs'),
    address: required('browser-address'),
    banner: required('browser-banner'),
    hole: required('browser-hole'),
  }
}
