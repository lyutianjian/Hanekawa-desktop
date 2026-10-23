/**
 * Everything this driver reads from or clicks in the page, as expression
 * builders.
 *
 * Two rules keep these safe to poll in a loop:
 *
 * - **Project, never dump.** `Runtime.evaluate` with `returnByValue` serialises
 *   whatever it is handed, so a probe returns counts, ids and short strings — not
 *   `innerHTML`, and never a node (which is not serialisable at all).
 * - **Prefer the app's own hooks.** Rows carry `data-session-id`, badges carry
 *   `aria-label`, panes carry the seeded marker in their text. Reading those means
 *   the driver breaks when the app's contract changes, which is the point, rather
 *   than when its layout is nudged.
 *
 * Clicks go through the app's real handlers (`.click()` on the element the view
 * wired), so a click and a keystroke cannot disagree about what a row means —
 * `activateRow` and `newSessionIntent` exist to make that true, and driving the
 * DOM element is what exercises them.
 *
 * One deliberate exception: `.click()` does not move focus. That matters for the
 * delete confirmation, whose `focusout` handler withdraws it
 * (`dom/sidebarView.ts:89-99`) — a synthetic mouse click leaves the confirmation
 * standing, which is what lets it be screenshotted.
 *
 * Note when editing: every probe below is a template literal, so **no backtick
 * may appear inside one**, including inside a comment. A stray one ends the
 * string and the module fails to parse — which is a build error here, but would
 * be a syntax error inside the page if it ever balanced.
 */

const json = (value) => JSON.stringify(value)

/** The sidebar: collapse state, groups, and every row's badge and flags. */
export const sidebar = () => `(() => {
  const container = document.getElementById('sidebar')
  const rows = [...container.querySelectorAll('.session-row')].map((row) => ({
    sessionId: row.dataset.sessionId,
    index: Number(row.dataset.index),
    // The visible run, not the whole .session-title: the marquee needs the name
    // twice — that is what it wraps onto — and the second copy is aria-hidden
    // scenery. Reading the wrapper concatenated the two, so every assertion about
    // "what this row is called" compared against the name doubled. No backticks
    // in here: this comment lives inside the template literal being evaluated.
    title: (row.querySelector('.session-title-run') || row.querySelector('.session-title') || {}).textContent || '',
    badge: (row.querySelector('.session-badge[aria-label]') || {}).ariaLabel || 'none',
    active: row.classList.contains('active'),
    selected: row.classList.contains('selected'),
    open: row.classList.contains('open'),
    confirming: row.classList.contains('confirming'),
  }))
  return {
    collapsed: container.classList.contains('collapsed'),
    // Collapsed is zero width now, not a 44px rail (S7): the toggle it used to
    // keep reachable lives in the title bar.
    width: Math.round(container.getBoundingClientRect().width),
    // The four regions share one shell now, and that shell is what render()
    // hides — once the fold has settled, not when the class flips.
    shellHidden: (container.querySelector('.sidebar-shell') || {}).hidden ?? null,
    rowCount: rows.length,
    // Rows survive a collapse inside the hidden container: render() returns
    // before rebuilding the list (dom/sidebarView.ts:236-241), so "no rows"
    // only holds when the very first render is already collapsed. What collapse
    // actually guarantees is that none of them is on screen.
    visibleRowCount: [...container.querySelectorAll('.session-row')].filter(
      (row) => row.getClientRects().length > 0,
    ).length,
    rows,
    // One group per workspace, always headed. The age sections are gone: the
    // workspace is the list's only grouping axis, and a group folds shut behind
    // its own heading. The root field is the heading's title — the normalized
    // key the lanes carry too, so driver-side comparisons need no path math.
    groups: [...container.querySelectorAll('.project-group')].map((group) => ({
      root: (group.querySelector('.project-heading') || {}).title || '',
      collapsed: group.classList.contains('collapsed'),
      label: (group.querySelector('.project-heading .btn-label') || {}).textContent || '',
      hasNew: group.querySelector('.project-new') !== null,
      menu: group.querySelector('.project-menu:not([hidden]):not([inert])') !== null,
      empty: group.querySelector('.project-empty') !== null,
      rows: group.querySelectorAll('.session-row').length,
    })),
    empty: container.querySelector('.sidebar-empty') !== null,
  }
})()`

/**
 * The pane subtrees.
 *
 * `visible` is `!hidden`: switching panes only flips visibility
 * (`paneSession.ts:182-191`), so the number of `.pane` elements is the number of
 * live lanes and exactly one of them is visible. `len` is the transcript's text
 * length — the cheapest possible "is it still growing" signal.
 */
export const panes = () => `(() => {
  const area = document.getElementById('transcript-area')
  return [...area.children].map((pane) => {
    const text = (pane.querySelector('.transcript') || {}).textContent || ''
    return {
      visible: !pane.hidden,
      len: text.length,
      head: text.slice(0, 80),
    }
  })
})()`

/**
 * The visible pane's conversation, as boxes.
 *
 * The turn in flight is what the reader is looking at, so the newest question is
 * lifted to the top of the viewport and a pad below the conversation is what
 * lets the scroller travel that far (`model/transcriptAnchor.ts`). The facts
 * fail separately — is the question at the top, is there still room under the
 * last line, and was the pad actually written.
 *
 * `null` when no pane is visible, so a step asserts on the shape rather than on
 * a zero that could mean either thing. No backticks in here: this is a template
 * literal.
 */
export const conversation = () => `(() => {
  const area = document.getElementById('transcript-area')
  const pane = [...area.children].find((node) => !node.hidden)
  if (!pane) return null
  const scroller = pane.querySelector('.transcript')
  const column = pane.querySelector('.transcript-column')
  if (!scroller || !column) return null
  const scrollerBox = scroller.getBoundingClientRect()
  const columnBox = column.getBoundingClientRect()
  const round = (box) => ({
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    left: Math.round(box.left),
    right: Math.round(box.right),
  })
  // The anchor: the newest user bubble, which is the thing the scroll is aimed
  // at. \`:last-of-type\` would be the last \`.item\` of any kind, so the list is
  // taken and read from the end.
  const bubbles = column.querySelectorAll('.item.user')
  const anchor = bubbles.length > 0 ? bubbles[bubbles.length - 1] : null
  return {
    items: column.children.length,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scrollTop: Math.round(scroller.scrollTop),
    // What the view measured and wrote this paint, as the CSS length it wrote.
    pad: column.style.getPropertyValue('--transcript-pad').trim(),
    scroller: round(scrollerBox),
    column: round(columnBox),
    anchor: anchor ? round(anchor.getBoundingClientRect()) : null,
  }
})()`

/** The visible pane's welcome screen: null when a conversation is showing. */
export const welcome = () => `(() => {
  const area = document.getElementById('transcript-area')
  const pane = [...area.children].find((node) => !node.hidden)
  const welcome = pane ? pane.querySelector('.welcome') : null
  if (!welcome || welcome.hidden) return null
  const title = (welcome.querySelector('.welcome-title') || {}).textContent || ''
  const project = (welcome.querySelector('.welcome-pill.project') || {}).textContent || ''
  return { title: title.trim(), project: project.trim() }
})()`

/** One pane, found by the fixture marker its transcript contains. */
export const paneByMarker = (marker) => `(() => {
  const area = document.getElementById('transcript-area')
  for (const pane of area.children) {
    const text = (pane.querySelector('.transcript') || {}).textContent || ''
    if (text.includes(${json(marker)})) return { found: true, visible: !pane.hidden, len: text.length }
  }
  return { found: false }
})()`

/**
 * The question card docked in the composer (`dom/questionCardView.ts`): the same
 * `#composer-request` the permission request uses, with its own rows and buttons.
 * Centres are returned so a step can aim a real mouse event at a row or a button.
 * No backticks in here: this whole probe is a template literal.
 */
export const questionCard = () => `(() => {
  const card = document.getElementById('composer-request')
  const pick = (selector) => (card.querySelector(selector) || {}).textContent || ''
  const centre = (node) => {
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  return {
    open: !card.hidden && !card.inert && card.getClientRects().length > 0 && Boolean(card.querySelector('.ask-card')),
    settled: card.classList.contains('presence-open'),
    header: pick('.ask-chip'),
    title: pick('.ask-title'),
    progress: pick('.ask-progress'),
    options: [...card.querySelectorAll('.ask-option')].map((node) => ({
      label: (node.querySelector('.ask-option-label') || {}).textContent || '',
      selected: node.classList.contains('selected'),
      ...centre(node),
    })),
    actions: [...card.querySelectorAll('.dialog-btn')].map((node) => ({
      label: node.textContent,
      primary: node.classList.contains('primary'),
      disabled: node.disabled,
      ...centre(node),
    })),
  }
})()`

/**
 * The permission request, which transforms the composer
 * (`dom/permissionRequestView.ts`).
 *
 * Three things are read rather than one, because "drawn" is not the claim: the
 * card has to be on screen *and* the textarea it replaced has to be gone, or the
 * request is a panel floating over a live composer — the modal it replaced with
 * an extra step. `getClientRects()` is what answers that, since the stylesheet
 * hides both halves with `display: none` rather than the `hidden` attribute.
 */
export const permissionRequest = () => `(() => {
  const card = document.getElementById('composer-request')
  const composer = document.getElementById('composer')
  const input = document.getElementById('input')
  const bar = document.getElementById('composer-bar')
  const pick = (selector) => (card.querySelector(selector) || {}).textContent || ''
  const onScreen = (node) => Boolean(node) && node.getClientRects().length > 0
  const box = onScreen(card) ? card.getBoundingClientRect() : null
  const composerBox = composer ? composer.getBoundingClientRect() : null
  return {
    open: !card.hidden && !card.inert && onScreen(card),
    // Coordinates are safe to click only after the capsule's layout handoff.
    // A closing card can remain visible after it has stopped taking answers.
    settled: card.classList.contains('presence-open') && !composer.classList.contains('request-changing'),
    transformed: Boolean(composer) && composer.classList.contains('request-open'),
    // The two halves the card stands in for. Both must be off screen while it is
    // up: a Tab stop left behind would swallow the keys the buttons want.
    inputVisible: onScreen(input),
    barVisible: onScreen(bar),
    title: pick('.request-title'),
    subtitle: pick('.request-subtitle'),
    reason: pick('.request-question'),
    block: pick('.request-block'),
    hotkeys: [...card.querySelectorAll('.kbd')].map((node) => node.textContent),
    // Inside the capsule, not merely near it — the claim is that the input
    // *became* the request. No backticks in here: this is a template literal.
    insideComposer: Boolean(composer) && composer.contains(card),
    box: box ? { left: Math.round(box.left), right: Math.round(box.right) } : null,
    composerBox: composerBox
      ? { left: Math.round(composerBox.left), right: Math.round(composerBox.right) }
      : null,
    actions: [...card.querySelectorAll('.dialog-btn')].map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        label: node.textContent,
        primary: node.classList.contains('primary'),
        danger: node.classList.contains('danger'),
        selected: node.classList.contains('selected'),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    }),
  }
})()`

/**
 * Where the docked card is, and what the mouse reaches around it.
 *
 * `getBoundingClientRect` answers in full for a node that is covered or clipped,
 * so matching rectangles prove nothing; `elementFromPoint` is the hit test — what
 * a click in the sidebar and in the middle of the transcript would reach. Neither
 * may land in the dock: a blocking request must not make the rest of the window
 * unreachable.
 */
export const dockScope = () => `(() => {
  const rect = (id) => {
    const node = document.getElementById(id)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) }
  }
  const dock = document.getElementById('composer-request')
  const sidebar = document.getElementById('sidebar')
  const canvasBox = rect('canvas')
  const describe = (x, y) => {
    const hit = document.elementFromPoint(x, y)
    if (!hit) return { id: 'none', inSidebar: false, inDock: false }
    return {
      id: hit.id || hit.className || hit.tagName,
      inSidebar: sidebar ? sidebar.contains(hit) : false,
      inDock: dock ? dock.contains(hit) || hit === dock : false,
    }
  }
  const sidebarBox = sidebar ? sidebar.getBoundingClientRect() : null
  return {
    dock: rect('composer-request'),
    canvas: canvasBox,
    sidebar: sidebarBox ? { left: Math.round(sidebarBox.left), right: Math.round(sidebarBox.right) } : null,
    atSidebar: sidebarBox ? describe(sidebarBox.left + sidebarBox.width / 2, sidebarBox.top + 120) : null,
    atCanvas: canvasBox ? describe((canvasBox.left + canvasBox.right) / 2, (canvasBox.top + canvasBox.bottom) / 2) : null,
  }
})()`

export const surface = () => `(() => {
  const container = document.getElementById('surface')
  const composer = document.getElementById('composer')
  const column = document.querySelector('.composer-column')
  const transcript = document.getElementById('transcript-area')
  const box = container.getClientRects().length > 0 ? container.getBoundingClientRect() : null
  const columnBox = column ? column.getBoundingClientRect() : null
  const composerBox = composer ? composer.getBoundingClientRect() : null
  return {
    // Both conditions: the settings screen hides its siblings from the
    // stylesheet, so the hidden *attribute* alone would report a panel as open
    // while nothing is on screen. Since S9 the panel is inside \`#input-row\`, so
    // what the settings screen hides is its ancestor — the rect is still the
    // honest reading, and the attribute still is not.
    open: !container.hidden && container.getClientRects().length > 0,
    attributeOpen: !container.hidden,
    // todo V3: the panel is one stack floating on the composer's upper edge, on
    // the reading column's own axis. Three separate facts, because they fail
    // separately: does it share the column, is it *above* the composer, and does
    // it leave the transcript's height alone (a float, not a flex sibling).
    rect: box
      ? { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) }
      : null,
    column: columnBox
      ? { width: Math.round(columnBox.width), left: Math.round(columnBox.left), right: Math.round(columnBox.right) }
      : null,
    composerTop: composerBox ? Math.round(composerBox.top) : null,
    // todo V9, same question as the settings menu's: a floating panel on a white
    // page is separated by its shadow, not by its hairline.
    shadow: getComputedStyle(container).boxShadow,
    background: getComputedStyle(container).backgroundColor,
    transcriptHeight: transcript ? Math.round(transcript.getBoundingClientRect().height) : 0,
    // The surface paints its title as a bare h2 (dom/surfaceView.ts:34), not a
    // classed node like the overlay does.
    title: (container.querySelector('h2') || {}).textContent || '',
    rows: [...container.querySelectorAll('.row')].map((row) => ({
      id: row.dataset.rowId,
      label: (row.querySelector('.label') || {}).textContent || '',
      value: (row.querySelector('.value') || {}).textContent || '',
      selected: row.classList.contains('selected'),
    })),
  }
})()`

/**
 * The status bar plus the two fields that left it in 5e: the permission mode is
 * now the composer's pill, and the session name is the canvas header's. Both are
 * still read here, because the stages that assert on them are asking "what does
 * the window say about this session", not "what is in the status bar".
 */
export const status = () => `(() => {
  const text = (id) => (document.getElementById(id) || {}).textContent || ''
  const el = (selector) => document.querySelector(selector)
  return {
    mode: text('chip-permission'),
    usage: text('status-usage'),
    session: (el('#canvas-header .canvas-title') || {}).textContent || '',
    title: document.title,
  }
})()`

/** The canvas header: identity on the left, "open location" on the right. */
export const canvasHeader = () => `(() => {
  const header = document.getElementById('canvas-header')
  if (!header) return { present: false }
  const pick = (selector) => (header.querySelector(selector) || {}).textContent || ''
  return {
    present: true,
    hidden: header.hidden,
    title: pick('.canvas-title'),
    renaming: header.querySelector('.canvas-title-input') !== null,
    menuItems: [...header.querySelectorAll('.canvas-menu:not([hidden]):not([inert]) .canvas-menu-item')].map((node) => node.textContent),
    openLocation: pick('.canvas-open-location'),
  }
})()`

export const clickHeaderMenu = () =>
  clickOr('#canvas-header .canvas-menu-trigger', 'the canvas header menu')

/**
 * The viewport centre of one node, for `mouseClick`.
 *
 * The dismissal steps need this and cannot use `clickOr`: `element.click()`
 * dispatches a lone `click` straight at the node and produces **no
 * `pointerdown`** at all, which is the event every popover in this renderer
 * closes on (`dom/dismiss.ts`). A menu that only a real press dismisses would
 * pass a synthetic-click smoke and fail in the user's hands — which is exactly
 * the bug this probe was added for.
 */
export const centreOf = (selector) => `(() => {
  const node = document.querySelector(${json(selector)})
  if (!node) return null
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
})()`

/**
 * The frameless window's title bar (6a).
 *
 * `menus` is what the window says instead of Electron's English File/Edit/View —
 * the stage-6 item is that this row exists at all, that its menus open, and that
 * `items` are the app's own commands rather than new ones. The drag region and
 * the OS-painted buttons on the right cannot be read from here: the overlay is
 * outside the document, so a screenshot is the only evidence.
 */
export const titleBar = () => `(() => {
  const bar = document.getElementById('titlebar')
  if (!bar) return { present: false }
  return {
    present: true,
    rail: bar.querySelector('.titlebar-rail') !== null,
    menus: [...bar.querySelectorAll('.titlebar-menu-trigger')].map((node) => node.textContent),
    open: [...bar.querySelectorAll('.titlebar-menu-trigger.open')].map((node) => node.textContent),
    items: [...bar.querySelectorAll('.titlebar-menu-item')].map((node) => node.textContent),
  }
})()`

export const clickTitleBarMenu = (index = 0) =>
  clickOr(`#titlebar .titlebar-menu-shell:nth-of-type(${index + 1}) .titlebar-menu-trigger`, 'a title bar menu')

/** Native exclusion geometry plus real hit targets; page screenshots omit OS buttons. */
export const windowChrome = () => `(() => {
  const bar = document.getElementById('titlebar')
  const overlay = navigator.windowControlsOverlay
  const rect = overlay?.getTitlebarAreaRect()
  const describe = (node) => {
    const box = node.getBoundingClientRect()
    return {
      text: node.textContent, title: node.title,
      x: box.x, y: box.y, width: box.width, height: box.height,
      region: getComputedStyle(node).getPropertyValue('-webkit-app-region'),
    }
  }
  const openMenu = bar.querySelector('.titlebar-menu-trigger.open')?.parentElement.querySelector('.titlebar-menu')
  return {
    platform: window.hanekawa.platform,
    styledPlatform: document.documentElement.dataset.platform,
    viewportWidth: innerWidth,
    overlay: rect ? { visible: overlay.visible, x: rect.x, width: rect.width, height: rect.height } : null,
    bar: describe(bar),
    controls: [...bar.querySelectorAll('.titlebar-rail, .titlebar-menu-trigger')]
      .map((node) => ({ ...describe(node), menu: node.classList.contains('titlebar-menu-trigger') })),
    items: openMenu ? [...openMenu.querySelectorAll('button')].map(describe) : [],
    menuRegion: openMenu ? getComputedStyle(openMenu).getPropertyValue('-webkit-app-region') : null,
    leftInset: getComputedStyle(bar).paddingLeft,
    rightInset: getComputedStyle(bar).paddingRight,
    collapsed: document.getElementById('sidebar').classList.contains('collapsed'),
  }
})()`

export const chip = () => `(() => {
  const pick = (selector) => (document.querySelector(selector) || {}).textContent || ''
  const context = document.getElementById('composer-context')
  return {
    model: pick('#chip-runtime .chip-model-label'),
    effort: pick('#chip-runtime .chip-effort-label'),
    context: {
      present: context !== null,
      hidden: context ? context.hidden : true,
      insideRuntimeChip: document.querySelector('#chip-runtime #composer-context') !== null,
    },
    permission: (document.getElementById('chip-permission') || {}).textContent || '',
    submitState: (document.getElementById('submit') || { className: '' }).className,
  }
})()`

/**
 * The chip's popover and the flyout hanging off one of its rows (S12).
 *
 * The two used to be one full-width `#surface` card per field. `rect` and
 * `transcriptHeight` are still read for the same reason they are on `surface()`:
 * a popover must float over the conversation rather than resize it.
 */
export const chipMenu = () => `(() => {
  const menu = document.querySelector('.chip-menu')
  const transcript = document.getElementById('transcript-area')
  const composer = document.getElementById('composer')
  const height = transcript ? Math.round(transcript.getBoundingClientRect().height) : 0
  if (!menu || menu.hidden || menu.hasAttribute('inert')) return { open: false, transcriptHeight: height }
  const flyout = menu.querySelector('.chip-flyout:not([hidden]):not([inert])')
  const rect = menu.getBoundingClientRect()
  return {
    open: true,
    rows: [...menu.querySelectorAll('.chip-menu-row')].map((node) => ({
      label: (node.querySelector('.btn-label') || {}).textContent || '',
      value: (node.querySelector('.chip-menu-value') || {}).textContent || '',
      open: node.classList.contains('open'),
    })),
    flyout: flyout === null ? undefined : {
      title: (flyout.querySelector('.chip-flyout-title') || {}).textContent || '',
      items: [...flyout.querySelectorAll('.chip-flyout-item')].map((node) => ({
        label: (node.querySelector('.btn-label') || {}).textContent || '',
        current: node.classList.contains('active'),
        disabled: node.classList.contains('disabled'),
      })),
      left: Math.round(flyout.getBoundingClientRect().left),
      right: Math.round(flyout.getBoundingClientRect().right),
      bottom: Math.round(flyout.getBoundingClientRect().bottom),
    },
    rect: { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
    canvasLeft: Math.round(document.getElementById('canvas').getBoundingClientRect().left),
    shadow: getComputedStyle(menu).boxShadow,
    composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : 0,
    chipTop: Math.round(document.getElementById('chip-runtime').getBoundingClientRect().top),
    transcriptHeight: height,
  }
})()`

/**
 * The settings screen, including the numbers that stand in for "does the long
 * form scroll inside the window".
 *
 * `#settings-body`'s own overflow is the right question rather than the
 * composer's position: the composer is `display:none` while settings are open
 * (`styles.css:814-819`), so it cannot be pushed anywhere.
 */
export const settings = () => `(() => {
  const container = document.getElementById('settings')
  const body = document.getElementById('settings-body')
  const shell = document.getElementById('shell')
  const titleBar = document.getElementById('titlebar')
  const active = document.activeElement
  const canvas = document.getElementById('canvas')
  const column = container.querySelector('.settings-column')
  // The reading column against the box it is centred in (todo V7). \`body\` is the
  // scroller and keeps its full width; only its content box is the measure to
  // compare against, so the padding is taken out here rather than in the step.
  const bodyStyle = body ? getComputedStyle(body) : null
  const bodyBox = body ? body.getBoundingClientRect() : null
  const columnBox = column ? column.getBoundingClientRect() : null
  const canvasStyle = canvas ? getComputedStyle(canvas) : null
  return {
    open: !container.hidden && !container.hasAttribute('inert'),
    // A modal over the whole window: a press at the sidebar's spot lands on the
    // scrim, not on the sidebar under it.
    scrimHit: document.elementFromPoint(12, Math.round(window.innerHeight / 2))?.id ?? 'none',
    // Which element holds focus decides whether the screen's own keydown handler
    // (and therefore its documented Esc) can fire at all.
    focus: active ? (active.id || active.className || active.tagName) : 'none',
    focusInside: active ? container.contains(active) : false,
    nav: [...container.querySelectorAll('.settings-nav-item')].map((item) => ({
      label: item.textContent,
      selected: item.classList.contains('selected'),
    })),
    title: (container.querySelector('.settings-title') || {}).textContent || '',
    cards: [...container.querySelectorAll('.settings-card-title')].map((node) => node.textContent),
    editor: container.querySelector('.settings-editor-page') !== null,
    rowCount: container.querySelectorAll('.settings-row').length,
    toggles: container.querySelectorAll('[role="switch"]').length,
    error: (container.querySelector('.settings-error') || {}).textContent || '',
    scrollHeight: body ? body.scrollHeight : 0,
    clientHeight: body ? body.clientHeight : 0,
    docScroll: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : 0,
    // The strip has two sources that must agree: \`#titlebar\`'s CSS height and
    // \`titleBarOverlay.height\` in \`main.ts\` (the OS paints its three buttons on
    // the same band). Measuring it lets one assertion cover both.
    titleBarHeight: titleBar ? Math.round(titleBar.getBoundingClientRect().height) : 0,
    column: columnBox
      ? { width: Math.round(columnBox.width), left: Math.round(columnBox.left), right: Math.round(columnBox.right) }
      : null,
    // Derived from \`clientWidth\`, not from the bounding rect: once the form is
    // long enough to scroll, the scrollbar eats into the padding box, and
    // \`right - paddingRight\` would claim ~10px the column can never have.
    bodyContent: body && bodyBox && bodyStyle
      ? (() => {
          const left = Math.round(bodyBox.left + parseFloat(bodyStyle.paddingLeft))
          const width = Math.round(
            body.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight),
          )
          return { left, right: left + width }
        })()
      : null,
    // A border on the canvas would inset \`#overlay\`'s \`inset: 0\` by 1px and break S2's per-edge equality.
    canvasBorder: canvasStyle ? canvasStyle.borderTopWidth : null,
  }
})()`

/**
 * The resolved theme, the preference behind it, and what the palette actually
 * paints (todo V9).
 *
 * Three readings rather than one, because they fail separately: the attribute
 * (`app.ts` resolved the preference and wrote it), the tokens (the light block
 * layered on) and the paint (a rule really used them). A half-applied palette —
 * the failure that light-mode blindness produces — changes the attribute and
 * leaves the paint dark-on-dark, so the attribute alone proves nothing.
 *
 * `stored` is `localStorage['ui-theme']`, which lives in Electron's *default*
 * userData: `--cwd=` does not isolate it, so a step that changes it owes the
 * developer's machine a restore.
 */
export const theme = () => `(() => {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const token = (name) => style.getPropertyValue(name).trim()
  const paintOf = (node) => {
    if (!node) return null
    const own = getComputedStyle(node)
    return { background: own.backgroundColor, color: own.color }
  }
  return {
    resolved: root.dataset.theme || 'none',
    stored: localStorage.getItem('ui-theme'),
    // Named, not swept: a sweep would compare whatever happens to be declared
    // and could not tell a missing override from a token that has none.
    tokens: {
      '--surface-base': token('--surface-base'),
      '--surface-canvas': token('--surface-canvas'),
      '--surface-card': token('--surface-card'),
      '--surface-hover': token('--surface-hover'),
      '--surface-active': token('--surface-active'),
      '--text-primary': token('--text-primary'),
      '--text-secondary': token('--text-secondary'),
      '--border-subtle': token('--border-subtle'),
      '--border-strong': token('--border-strong'),
      '--shadow-float': token('--shadow-float'),
      '--surface-scrim': token('--surface-scrim'),
    },
    // The one the light block deliberately does not override: the knob rides
    // a saturated accent fill in both themes. The scrim used to sit here, but
    // the 2026 palette made it themed — light paper needs the harder dim — so
    // it is asserted with the themed tokens above now.
    fixed: {
      '--surface-knob': token('--surface-knob'),
    },
    canvas: paintOf(document.getElementById('canvas')),
    body: paintOf(document.body),
  }
})()`

/**
 * An open pill dropdown, and whether anything is clipping it (todo D3).
 *
 * `lastItemHit` is the assertion that matters, and it is the only one available:
 * a clipped element still reports its full `getBoundingClientRect()`, so the
 * geometry alone cannot tell "hangs out of the card" from "cut off at its edge".
 * Hit testing can — `elementFromPoint` returns what is actually painted at a
 * point, and a clipped-away option is not.
 *
 * `menuBottom > cardBottom` is the non-vacuity half: if the menu no longer
 * extends past its card, this probe stopped exercising the defect.
 */
export const settingsMenu = () => `(() => {
  const menu = document.querySelector('#settings .settings-menu')
  if (!menu || menu.hidden || menu.hasAttribute('inert')) return { open: false }
  const items = [...menu.querySelectorAll('.settings-menu-item')]
  const last = items[items.length - 1]
  const card = menu.closest('.settings-card')
  const body = document.getElementById('settings-body')
  const box = last ? last.getBoundingClientRect() : null
  const x = box ? Math.round(box.left + box.width / 2) : 0
  const y = box ? Math.round(box.top + box.height / 2) : 0
  const inViewport = box ? y > 0 && y < window.innerHeight && x > 0 && x < window.innerWidth : false
  const hit = inViewport ? document.elementFromPoint(x, y) : null
  const own = getComputedStyle(menu)
  return {
    open: true,
    itemCount: items.length,
    labels: items.map((item) => item.textContent),
    // todo V9: the float shadow D3 added is the thing that only matters on a
    // white page — on the dark canvas the border does the separating.
    shadow: own.boxShadow,
    background: own.backgroundColor,
    menuBottom: Math.round(menu.getBoundingClientRect().bottom),
    cardBottom: card ? Math.round(card.getBoundingClientRect().bottom) : 0,
    bodyBottom: body ? Math.round(body.getBoundingClientRect().bottom) : 0,
    inViewport,
    // Not identity with the item: the hit may land on a child of it.
    lastItemHit: hit ? menu.contains(hit) : false,
    hitClass: hit ? (hit.className || hit.tagName) : 'none',
  }
})()`

// --- clicks ------------------------------------------------------------------

const clickOr = (selector, what) => `(() => {
  const node = document.querySelector(${json(selector)})
  if (!node) throw new Error('no ' + ${json(what)} + ' matching ' + ${json(selector)})
  node.click()
  return true
})()`

export const clickRow = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-open`, 'session row')

export const clickDelete = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-delete`, 'delete button')

export const clickConfirmYes = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-confirm-yes`, 'delete confirmation')

export const clickSurfaceRow = (rowId) => clickOr(`#surface .row[data-row-id="${rowId}"]`, 'surface row')

// --- the attachment strip (S26) -------------------------------------------------

/**
 * The composer's draft attachment strip, plus the send button's note.
 *
 * The strip is a singleton the active pane repaints, so what this reads is
 * *that pane's* drafts — which is exactly what the pane-isolation assertions
 * need. `sendNote` is the note the send button carries as its tooltip while
 * images block the send (S11): the host's submission gate is the authority,
 * this is the why a user sees before the round trip that would fail.
 */
export const attachmentStrip = () => `(() => {
  const strip = document.getElementById('composer-attachments')
  const submit = document.getElementById('submit')
  const rows = [...strip.children].map((row) => ({
    state: row.classList.contains('ready') ? 'ready' : row.classList.contains('failed') ? 'failed' : 'importing',
    // The tile draws no name — a 64px square cannot carry one — so the facts
    // live in its accessible name, which is what a user hears and hovers.
    label: row.getAttribute('aria-label') || '',
    hasThumb: row.querySelector('.attachment-thumb') !== null,
    thumbLoaded: [...row.querySelectorAll('.attachment-thumb')].some(
      (img) => (img.getAttribute('src') || '').startsWith('data:image/'),
    ),
    hasRetry: row.querySelector('.attachment-retry') !== null,
    hasRemove: row.querySelector('.attachment-remove') !== null,
  }))
  return {
    role: strip.getAttribute('role'),
    ariaLabel: strip.getAttribute('aria-label') || '',
    rows,
    // Thumbs carrying the marker a step planted: a repaint that rebuilt a row
    // would drop it, which is the observable half of "the strip does not
    // rebuild rows per snapshot tick".
    markedThumbs: strip.querySelectorAll('.attachment-thumb[data-smoke-mark]').length,
    sendNote: submit ? (submit.title || '') : '',
  }
})()`

/** Plants a marker on the first ready row's thumbnail, for the repaint assertions. */
export const markAttachmentThumb = () => `(() => {
  const thumb = document.querySelector('#composer-attachments .attachment-thumb')
  if (!thumb) return false
  thumb.setAttribute('data-smoke-mark', '1')
  return true
})()`

/**
 * Dispatches a real paste carrying one image file at the composer input.
 *
 * The event is synthetic but the handler chain is not: this is the same
 * `paste` listener `composerView` wires, reading the same `clipboardData.files`
 * shape an OS paste produces, so the bytes travel renderer → wire → host store
 * exactly as a user's paste does. The OS-level half — a real screenshot on the
 * real clipboard — is the manual check S26 records outside this driver.
 */
export const pasteImageFile = (name, base64, mime) => imageFileEvent('paste', 'input', name, base64, mime)

/**
 * Dispatches a real drop carrying one image file at the composer capsule.
 *
 * Same construction as the paste, aimed at the form element `app.ts` wires the
 * drop listener to. Navigation suppression and the image-only filter are that
 * handler's own code, not this probe's.
 */
export const dropImageFile = (name, base64, mime) => imageFileEvent('drop', 'input-row', name, base64, mime)

function imageFileEvent(type, targetId, name, base64, mime) {
  return `(() => {
    const target = document.getElementById(${json(targetId)})
    if (!target) throw new Error('no ' + ${json(targetId)} + ' to receive the ' + ${json(type)})
    const bytes = Uint8Array.from(atob(${json(base64)}), (ch) => ch.charCodeAt(0))
    const file = new File([bytes], ${json(name)}, { type: ${json(mime)} })
    const data = new DataTransfer()
    data.items.add(file)
    const init = { bubbles: true, cancelable: true }
    const event = ${type === 'paste'
      ? 'new ClipboardEvent("paste", { ...init, clipboardData: data })'
      : 'new DragEvent("drop", { ...init, dataTransfer: data })'}
    target.dispatchEvent(event)
    return true
  })()`
}

/** Clicks one tile's ✕, by index — the remove path the grid itself wires. */
export const clickAttachmentRemove = (index) => `(() => {
  const row = document.querySelectorAll('#composer-attachments .attachment-tile')[${index}]
  if (!row) throw new Error('no attachment tile ' + ${index})
  const remove = row.querySelector('.attachment-remove')
  if (!remove) throw new Error('no remove button on attachment row ' + ${index})
  remove.click()
  return true
})()`

/** Clicks the first ready tile's thumbnail — the fullscreen viewer's own trigger. */
export const clickAttachmentThumb = () =>
  clickOr('#composer-attachments .attachment-tile.ready .attachment-thumb', 'a ready thumbnail')

/**
 * The fullscreen image viewer (S12), and what a second open would answer with.
 *
 * The viewer opens on the thumbnail the tile already holds and settles onto the
 * screen-sized copy the host renders, so a step can watch both tiers: it is
 * open on the click's own frame, and `srcIsDataUrl` holds throughout. The zoom
 * label is the control's whole readout, which makes "− and + are wired"
 * observable without measuring pixels.
 */
export const imageViewer = () => `(() => {
  const panel = document.getElementById('lightbox')
  if (!panel || panel.hidden || panel.hasAttribute('inert')) return { open: false }
  const image = panel.querySelector('.lightbox-image')
  const steps = [...panel.querySelectorAll('.lightbox-zoom-step')]
  return {
    open: true,
    // The scrim fades in over its own transition, so a screenshot taken on the
    // click's frame catches it at opacity 0. A step that wants the *look* waits
    // for this to be 'open'; one that wants the wiring does not have to.
    settled: panel.classList.contains('presence-open'),
    role: panel.getAttribute('role'),
    ariaLabel: panel.getAttribute('aria-label') || '',
    caption: (panel.querySelector('.lightbox-caption') || {}).textContent || '',
    zoom: (panel.querySelector('.lightbox-zoom-label') || {}).textContent || '',
    hasClose: panel.querySelector('.lightbox-close') !== null,
    zoomSteps: steps.length,
    zoomDisabled: steps.map((step) => step.disabled === true),
    srcIsDataUrl: (image ? image.getAttribute('src') || '' : '').startsWith('data:image/'),
  }
})()`

/** Closes the viewer through its own ✕ — the first of its three documented exits. */
export const clickImageViewerClose = () =>
  clickOr('#lightbox .lightbox-close', 'the viewer close button')

/** Clicks the viewer's − or + — index 0 is out, index 1 is in. */
export const clickImageViewerZoom = (index) => `(() => {
  const step = document.querySelectorAll('#lightbox .lightbox-zoom-step')[${index}]
  if (!step) throw new Error('no viewer zoom step ' + ${index})
  step.click()
  return true
})()`

/** The image thumbnails the visible pane's transcript paints (S12). */
export const transcriptImageTiles = () => `(() => {
  const area = document.getElementById('transcript-area')
  const pane = [...area.children].find((node) => !node.hidden)
  if (!pane) return []
  return [...pane.querySelectorAll('.user-image-thumb')].map((tile) => ({
    // The facts live in the alt: the tile is pixels, and the alt is what the
    // live region reads whether or not the data URL has settled.
    text: tile.getAttribute('alt') || '',
    labelled: (tile.getAttribute('role') || '') === 'button',
    loaded: (tile.getAttribute('src') || '').startsWith('data:image/'),
  }))
})()`

/** Clicks one transcript image thumbnail, by index — the fullscreen viewer. */
export const clickTranscriptImageTile = (index) => `(() => {
  const tile = document.querySelectorAll('.user-image-thumb')[${index}]
  if (!tile) throw new Error('no transcript image tile ' + ${index})
  tile.click()
  return true
})()`

/**
 * Types a line into the composer and sends it, the way a user does.
 *
 * `Input.insertText` per character would be the more faithful path, but the
 * renderer recomputes everything it cares about from one `input` event, and this
 * is the only step that needs a slash command rather than a wire command —
 * `app.post` would bypass `classifyInput`, which is exactly the part under test.
 */
export const submitLine = (line) => `(() => {
  const input = document.getElementById('input')
  const submit = document.getElementById('submit')
  if (!input || !submit) throw new Error('no composer to type into')
  input.value = ${json(line)}
  input.dispatchEvent(new Event('input'))
  submit.click()
  return true
})()`

export const clickChip = () => clickOr('#chip-runtime', 'the model · effort chip')

/**
 * Opens a row's flyout. The affordance is hover, and `Input.dispatchMouseEvent`
 * cannot be aimed without measuring the row first, so the event is dispatched at
 * the node — the listener is on the row itself and does not rely on bubbling.
 */
export const hoverChipRow = (label) => `(() => {
  const row = [...document.querySelectorAll('.chip-menu-row')].find(
    (node) => (node.querySelector('.btn-label') || {}).textContent === ${json(label)},
  )
  if (!row) throw new Error('no chip menu row labelled ' + ${json(label)})
  row.dispatchEvent(new MouseEvent('mouseenter'))
  return true
})()`

/** An option in the open flyout, by its visible label. */
export const clickChipFlyoutItem = (label) => `(() => {
  const item = [...document.querySelectorAll('.chip-flyout-item')].find(
    (node) => (node.querySelector('.btn-label') || {}).textContent === ${json(label)},
  )
  if (!item) throw new Error('no flyout option labelled ' + ${json(label)})
  item.click()
  return true
})()`

/** The first row-level pill on the current settings page. */
export const clickSettingsPill = () => clickOr('#settings .settings-pill', 'settings pill')

/** Settings nav items are identified by their visible label, which is their id. */
export const clickSettingsNav = (label) => `(() => {
  const item = [...document.querySelectorAll('.settings-nav-item')].find((node) => node.textContent === ${json(label)})
  if (!item) throw new Error('no settings category labelled ' + ${json(label)})
  item.click()
  return true
})()`

/** An option in an open pill dropdown, by its visible label (dom/controls.ts:188). */
export const clickSettingsMenuItem = (label) => `(() => {
  const item = [...document.querySelectorAll('#settings .settings-menu-item')].find(
    (node) => node.textContent === ${json(label)},
  )
  if (!item) throw new Error('no dropdown option labelled ' + ${json(label)})
  item.click()
  return true
})()`

/**
 * Writes `localStorage['ui-theme']` directly.
 *
 * The one probe that bypasses the app's own path, and it exists for exactly one
 * job: S11's `finally`. The preference is not isolated by `--cwd=`, so a step
 * that dies mid-switch would otherwise leave the developer's real window in a
 * theme they did not pick. Everything a step *asserts* still goes through the
 * settings screen.
 */
export const setStoredTheme = (value) => `(() => {
  const next = ${json(value)}
  if (next === null) localStorage.removeItem('ui-theme')
  else localStorage.setItem('ui-theme', next)
  return localStorage.getItem('ui-theme')
})()`
