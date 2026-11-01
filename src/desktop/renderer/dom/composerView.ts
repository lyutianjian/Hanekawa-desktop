import { installComposerEditor } from './composerEditor.js'
import { insertSuggestion } from '../../../runtime/suggestions/insertSuggestion.js'
import {
  composerChipView,
  insertMentionToken,
  needsFullAccessConfirm,
  permissionPillView,
  submitButtonView,
} from '../model/composer.js'
import type { AttachmentStripView } from '../model/composerAttachments.js'
import { matchInputCommand } from '../model/commandRouting.js'
import type { AttachedPath } from '../../../media/attachedPaths.js'
import {
  CONTEXT_RATIO_VARIABLE,
  hiddenContextGauge,
  type ContextGaugeView,
} from '../model/usage.js'
import type { RuntimeMenuView } from '../model/runtimeMenu.js'
import type { SurfaceAction, SurfaceRow } from '../model/surfaces.js'
import type { PermissionMode } from '../../../harness/permissions.js'
import type { WireCommandInfo, WireContextBreakdownResult, WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { contextPopoverView } from '../model/contextBreakdown.js'
import { el, reconcile, replace, show } from './dom.js'
import { createPresence, finishPresenceWithin, type Presence } from './presence.js'
import { button } from './controls.js'
import { dismissable } from './dismiss.js'
import { followPointer, rovingFocus } from './focus.js'
import { createHoverCard, fitInCanvas } from './hoverCard.js'
import { createContextPopover, type ContextPopoverState } from './contextPopover.js'
import { icon } from './icons.js'
import { pathTileNode } from './pathTile.js'
import { createTextSwap } from './textSwap.js'

/**
 * The composer: a capsule containing the textarea and an inline action bar.
 *
 * `design_guidance.md`'s anchored composite input — attachment control bottom
 * left, a "model · effort" chip and a round send button bottom right. The chip
 * is where stage-4 decision 4 lands: effort is adjustable next to the message
 * it will affect, and never appears in settings.
 * The context-occupancy indicator sits to the chip's left: it reports the live
 * turn's budget, but it is not part of the decision the chip opens.
 *
 * The chip is **one** button for both fields, and it opens a local popover
 * rather than the full-width `#surface` card: an effort slider, with the model
 * name opening a second page of model choices. The `#surface` pickers are untouched — `/model` and `/effort` still open them —
 * so the chip is a second *route* to the choice, never a second answer about
 * what the options are: `model/runtimeMenu.ts` builds its rows out of the same
 * `modelPickerView` / `effortPickerView` those cards use.
 *
 * Choosing an option runs the row's `SurfaceAction`, which is a
 * `run-command` (`/model …`, `/effort …`) rather than `SessionClient.setModel` /
 * `setEffort`. That is the rule `model/surfaces.ts` already states: the slash
 * command is the user expressing a preference, and it is what writes the choice
 * back to config — `setModel` only points the live runtime somewhere else and
 * silently drops the persistence.
 *
 * The permission pill beside `+` is the exception, and deliberately so: its mode
 * applies to the live gate, which `set-permission-mode` does directly — the host
 * remembers it as the global startup mode for the sessions that follow. Its menu
 * is built here rather than opened as a surface: four fixed options do not need
 * a picker panel.
 */

export interface ComposerView {
  placeCaretAtPoint?(x: number, y: number): void
  insertText(text: string, trailingSpace?: boolean): void
  editValue?(text: string, cursorPos: number): void
  value(): string
  /**
   * The caret offset. `applyFileSuggestion` splices over the `@…` token that
   * ends here, so "the end of the text" is not a usable substitute — a mention
   * edited in the middle of a line would rewrite the wrong span.
   */
  cursorPos(): number
  setValue(text: string, cursorPos?: number, commands?: readonly WireCommandInfo[]): void
  setCommands(commands: readonly WireCommandInfo[]): void
  clear(): void
  focus(): void
  /**
   * Retargets the round button: send (into the running turn, mid-turn) or,
   * with nothing typed mid-turn, stop.
   *
   * It used to *disable* the button, because a second `SessionController.submit`
   * would overwrite the live `AbortController` and leave the first turn
   * impossible to interrupt. The kernel now rejects that outright, so mid-turn
   * input has somewhere to go: the host's message queue. Both this button and the
   * Enter path have to agree on which it is — `requestSubmit()` ignores a
   * disabled button, so a mismatch here silently swallows a click.
   */
  setStreaming(streaming: boolean): void
  /**
   * Repaints the runtime controls — the context indicator, model · effort chip,
   * and permission pill. Driven by the active pane's snapshot, including a
   * missing one, so a pane that has not finished starting shows placeholders
   * rather than the previous pane's model.
   */
  renderRuntime(runtime: WireRuntimeSnapshot | undefined, gauge?: ContextGaugeView, coordinator?: boolean): void
  /**
   * Opens the chip's popover with the rows the pane just built.
   *
   * The pane answers `onOpenRuntimeMenu` asynchronously (the model list is a
   * round trip), so this can arrive after the user has clicked again or after
   * the pane went to the background. It is honoured only while an open is still
   * outstanding, which is what stops a menu appearing over the *next* pane.
   */
  showRuntimeMenu(view: RuntimeMenuView): void
  /**
   * Recomputes the send button's three visual states. Called on every keystroke,
   * because emptiness is one of the inputs.
   */
  refreshSubmit(): void
  /**
   * Shuts any transient popup the composer owns.
   *
   * Called when a pane goes to the background: the composer is a singleton the
   * *active* pane drives, so a menu left open would hang over the *next* pane's
   * runtime and act on it.
   */
  closeMenus(): void
  /**
   * Paints this pane's draft attachment grid (S11). The grid lives in the
   * capsule above the textarea — it is composer content the way the text is,
   * not a popover. Only the active pane may call this; a background pane
   * passes an empty view to clear the paint.
   */
  renderAttachments(view: AttachmentStripView, paths?: readonly AttachedPath[]): void
  /**
   * Why the send button cannot send right now, when it has a say: pending or
   * failed attachments, or drafts against a model with no image capability.
   * Carried on the button's `title`/`aria-label` rather than disabling it —
   * the click still reaches the pane, which explains itself in the transcript.
   */
  setSendBlockNote(note: string | undefined): void
  /** The send gate's title, off the strip the pane just painted. */
  attachStripEl(): HTMLElement
  autosize(): void
  /**
   * Shuts the input for a lane that takes no more messages (a finished
   * thread); the reason stands in as the placeholder. `undefined` reopens it.
   */
  setLocked(reason: string | undefined): void
}

export const MAX_COMPOSER_HEIGHT_PX = 200

export function createComposerView(els: {
  editor: HTMLElement
  input: HTMLTextAreaElement
  submit: HTMLButtonElement
  stop: HTMLButtonElement
  attach: HTMLButtonElement
  /** The context-occupancy indicator, immediately left of the runtime chip. */
  contextIndicator: HTMLElement
  /** The model · effort status label, and the shell its popover is drawn into. */
  chipRuntime: HTMLButtonElement
  chipShell: HTMLElement
  /** The permission-mode pill's trigger, and the shell its menu is drawn into. */
  chipPermission: HTMLButtonElement
  permissionShell: HTMLElement
  /** The draft attachments' strip host, above the textarea in the capsule. */
  attachStrip: HTMLElement
}, actions: {
  onOpenSessionReference?: (ref: string) => void
  onResolveSessionReference?: (ref: string) => Promise<{ title: string; projectName: string } | undefined>
  /** Asks the pane for the menu's rows; answered by `showRuntimeMenu`. */
  onOpenRuntimeMenu: () => void
  /** A row chosen in a flyout — the pane's `runSurfaceAction`. */
  onRuntimeAction: (action: SurfaceAction) => void
  /** Applies a permission mode to the *live* gate — see `permissionPillView`. */
  onSelectPermissionMode: (mode: PermissionMode) => void
  /**
   * Full access was picked and is not on yet: the window asks the user before
   * applying it, so the pill never switches silently into the unguarded mode.
   */
  onRequestFullAccess: () => void
  /**
   * The attachment control. There is no host command behind a file dialog, so
   * it seeds an `@` and lets the existing mention completion take over — the
   * same path typing `@` follows. The callback is what tells the pane to
   * recompute completions, since a programmatic edit fires no `input` event.
   */
  onAttach: () => void
  /** 「选择图片」: the pane puts up the host-side picker (S11). */
  onPickImages: () => void
  /** A draft's ✕. The pane releases the host-side hold for ready drafts. */
  onRemoveAttachment: (draftId: string) => void
  /** A dropped file or folder's ✕. */
  onRemovePath: (path: string) => void
  /** A failed draft's 重试. A draft with no source cannot retry. */
  onRetryAttachment: (draftId: string) => void
  /** A ready draft's 打开原图, from the tile's context affordance: host-resolved. */
  onOpenAttachment: (draftId: string) => void
  /** A ready draft's tile, clicked: the pane opens the window's fullscreen viewer. */
  onPreviewAttachment: (draftId: string) => void
  /**
   * The image files a paste carried. Handed as DOM `File`s on purpose: the
   * pane's import owns reading them (`arrayBuffer`) — the view only routes
   * the event, and `model/composerAttachments.ts` stays DOM-free.
   */
  onPasteImages: (files: readonly File[]) => void
  /** The context indicator's breakdown, from the active pane's host. */
  onLoadContextBreakdown: () => Promise<WireContextBreakdownResult>
}): ComposerView {
  const richEditor = installComposerEditor(els.input, actions)
  let commands: readonly WireCommandInfo[] = []
  const highlight = el('div', 'composer-highlight')
  highlight.setAttribute('aria-hidden', 'true')
  const highlightText = el('div', 'composer-highlight-text')
  highlight.appendChild(highlightText)
  const slashMeasure = el('span', 'composer-slash-measure', '/')
  els.editor.appendChild(highlight)
  els.editor.appendChild(slashMeasure)

  function syncHighlightScroll(): void {
    highlightText.style.setProperty('--composer-scroll-y', `${-els.input.scrollTop}px`)
    highlight.classList.toggle('scrolled', els.input.scrollTop > 0)
    highlight.style.setProperty('--composer-scrollbar-width', `${els.input.offsetWidth - els.input.clientWidth}px`)
  }

  function renderInput(): void {
    if (richEditor) {
      richEditor.render(commands)
      show(highlight, false)
      return
    }
    const text = els.input.value
    const match = matchInputCommand(text, commands)
    els.input.classList.toggle('decorated', match !== undefined)
    show(highlight, match !== undefined)
    els.input.style.setProperty('--composer-input-indent', '0px')
    if (!match) return
    const token = el('span', 'composer-command')
    if (match.command.isSkill) {
      const mark = el('span', 'composer-skill-icon', icon('package'))
      token.appendChild(mark)
      token.appendChild(document.createTextNode(match.command.name))
      replace(highlightText, text.slice(0, match.start), token, text.slice(match.end))
      // Only the first line shifts: the icon replaces the slash, while the
      // textarea keeps the original text and native selection/clipboard.
      els.input.style.setProperty('--composer-input-indent', `${mark.getBoundingClientRect().width - slashMeasure.getBoundingClientRect().width}px`)
    } else {
      token.textContent = text.slice(match.start, match.end)
      replace(highlightText, text.slice(0, match.start), token, text.slice(match.end))
    }
    syncHighlightScroll()
  }

  const autosize = () => {
    // Kept in step with `#composer` / `#input`'s `max-height` in `styles.css`;
    // this one is load-bearing, because `scrollHeight` has to be clamped by
    // something the stylesheet cannot know.
    els.input.style.height = 'auto'
    els.input.style.height = `${Math.min(els.input.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`
    syncHighlightScroll()
  }

  // The last snapshot this view painted, so opening the menu can redraw the pill
  // without waiting for the host to post another one.
  let runtimeSnapshot: WireRuntimeSnapshot | undefined
  /** The active lane is a coordinator: its permission pill is not drawn. */
  let coordinatorLane = false
  /** The context-occupancy indicator's state, painted independently of the chip. */
  let contextGauge: ContextGaugeView = hiddenContextGauge()
  let permissionMenuOpen = false
  let streamingNow = false
  let locked = false
  const defaultPlaceholder = els.input.placeholder
  /** The chip's popover: its rows while open, `undefined` while shut. */
  let runtimeMenu: RuntimeMenuView | undefined
  /** An open asked for and not yet answered; see `showRuntimeMenu`. */
  let runtimeMenuPending = false

  // Icon-only controls; the accessible name comes from `aria-label`, refreshed
  // by `setStreaming` for the one button whose meaning changes.
  replace(els.submit, icon('send'))
  replace(els.stop, icon('stop'))
  // Fixed, unlike the send button's: stopping means one thing in every state.
  // The key is named because Escape is how most people will want to do it.
  els.stop.setAttribute('aria-label', '停止（Esc）')
  els.stop.title = '停止（Esc）'
  replace(els.attach, icon('plus'))
  els.attach.setAttribute('aria-label', '附件')
  els.attach.setAttribute('aria-haspopup', 'menu')
  els.attach.setAttribute('aria-expanded', 'false')
  els.attach.title = '添加附件（图片 / @ 引用项目文件）'

  // --- the attachment control (S11) ------------------------------------------------
  //
  // One button, two entrances: 选择图片 (a host-side picker over the Electron
  // boundary) and 引用项目文件 (the `@` seed that always lived here, handed to
  // the mention completion). A local menu rather than two buttons, so the bar
  // stays one affordance wide and the `@` path keeps its caret-inserting
  // behaviour untouched.
  let attachMenuOpen = false
  let attachMenu: HTMLElement | undefined
  let attachPresence: Presence | undefined
  let attachItems: HTMLButtonElement[] = []
  /** What the strip was last drawn from; repaints are signed, like the pill's. */
  let attachSignature: string | undefined
  /** The send button's explanatory note, applied to title/aria-label. */
  let sendBlockNote: string | undefined

  function closeAttachMenu(): void {
    const returnFocus = attachMenu?.contains(document.activeElement)
    attachMenuOpen = false
    attachPresence?.set(false)
    els.attach.setAttribute('aria-expanded', 'false')
    els.attach.classList.remove('open')
    if (returnFocus) els.attach.focus()
  }

  function renderAttachMenu(): void {
    if (!attachMenuOpen) {
      closeAttachMenu()
      return
    }
    if (attachMenu) {
      attachPresence!.set(true)
      els.attach.setAttribute('aria-expanded', 'true')
      els.attach.classList.add('open')
      return
    }

    const menu = el('div', 'composer-menu attachment-menu')
    // Commands, not a choice among values: `menu`/`menuitem`, which also keeps
    // a screen reader from announcing 「未选中」 on each of them.
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', '附件')
    const pickItem = button('composer-menu-item', '选择图片', '选择图片', () => {
      closeAttachMenu()
      actions.onPickImages()
    })
    pickItem.setAttribute('role', 'menuitem')
    const mentionItem = button('composer-menu-item', '引用项目文件（@）', '在光标处插入 @，引用项目文件', () => {
      closeAttachMenu()
      const next = insertMentionToken(els.input.value, els.input.selectionStart ?? els.input.value.length)
      els.input.value = next.text
      els.input.setSelectionRange(next.cursorPos, next.cursorPos)
      renderInput()
      autosize()
      els.input.focus()
      actions.onAttach()
    })
    mentionItem.setAttribute('role', 'menuitem')
    attachItems.push(pickItem, mentionItem)
    menu.appendChild(pickItem)
    menu.appendChild(mentionItem)
    followPointer(menu, '.composer-menu-item')
    els.attach.parentElement?.appendChild(menu)
    attachMenu = menu
    attachPresence = createPresence(menu)
    attachPresence.set(true)
    els.attach.setAttribute('aria-expanded', 'true')
    els.attach.classList.add('open')
  }

  function toggleAttachMenu(): void {
    attachMenuOpen = !attachMenuOpen
    renderAttachMenu()
    if (attachMenuOpen) attachItems[0]?.focus()
  }
  els.attach.addEventListener('click', toggleAttachMenu)
  // Scope dismissal to the menu and trigger, not the surrounding bar.
  const attachShell = els.attach.parentElement ?? els.attach
  dismissable([els.attach, '.attachment-menu'], {
    isOpen: () => attachMenuOpen,
    close: closeAttachMenu,
  })
  attachShell.addEventListener('keydown', (event) =>
    rovingFocus(event, attachItems, attachMenuOpen, toggleAttachMenu))
  attachShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
    if (next instanceof Node && (els.attach.contains(next) || attachMenu?.contains(next))) return
    if (!attachMenuOpen) return
    closeAttachMenu()
  })
  attachShell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !attachMenuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeAttachMenu()
    els.attach.focus()
  })

  /**
   * The draft grid. Signed for the reason the pill is: `renderAttachments`
   * follows the runtime snapshot tick, which during a turn is once per chunk,
   * and rebuilding a tile the pointer is on at that rate is what the signature
   * guards exist to stop.
   */
  function renderAttachments(view: AttachmentStripView, paths: readonly AttachedPath[] = []): void {
    const signature = [
      ...paths.map((entry) => `${entry.kind}:${entry.path}`),
      ...view.rows.map((row) => `${row.draftId}:${row.state}:${row.label}:${row.detail ?? ''}:${row.thumbUrl ?? ''}`),
    ].join('|')
    if (signature === attachSignature) {
      setSendBlockNote(view.sendBlockNote)
      return
    }
    attachSignature = signature

    replace(els.attachStrip)
    if (view.rows.length === 0 && paths.length === 0) {
      els.attachStrip.removeAttribute('aria-label')
      setSendBlockNote(view.sendBlockNote)
      return
    }
    els.attachStrip.setAttribute('role', 'list')
    els.attachStrip.setAttribute('aria-label', '待发送附件')
    for (const entry of paths) {
      const tile = pathTileNode(entry)
      tile.appendChild(button('attachment-remove', '', `移除 ${entry.path}`, () => actions.onRemovePath(entry.path), { icon: 'close' }))
      els.attachStrip.appendChild(tile)
    }
    for (const row of view.rows) {
      els.attachStrip.appendChild(attachmentTileNode(row))
    }
    setSendBlockNote(view.sendBlockNote)
  }

  /**
   * One square tile per draft.
   *
   * The name is not drawn: at 64px a file name is either truncated to nothing
   * or wider than the picture it labels, so it lives in the `title` and the
   * accessible name instead, where it is still one hover or one screen reader
   * away. An importing tile keeps the box — an import that finishes must not
   * shove the tiles beside it sideways — and carries its words in the same two
   * places. A failed one also says why beside its box: a refusal only a hover
   * could read is a refusal most people never see.
   */
  function attachmentTileNode(row: AttachmentStripView['rows'][number]): HTMLElement {
    const item = el('div', `attachment-tile ${row.state}`)
    item.setAttribute('role', 'listitem')
    // The name and the state's own words, in the two places a 64px square can
    // carry them: the hover tooltip and the accessible name.
    const described = row.detail === undefined ? row.label : `${row.label}（${row.detail}）`
    item.setAttribute('title', described)
    item.setAttribute('aria-label', described)
    // The 64px square the controls hang off. A failed tile is wider than it (the
    // reason sits beside it), so there it is a box of its own.
    const picture = row.state === 'failed' ? el('div', 'attachment-picture') : item

    if (row.state === 'ready') {
      // The thumbnail (S12): the pane's on-demand data URL, painted in place.
      // Absent until that load settles — the alt text carries the facts until
      // then, and the arrival is a signature change so the tile repaints once.
      // Clicking it opens the window's fullscreen viewer, which asks the host
      // for a screen-sized copy of its own.
      const thumb = el('img', 'attachment-thumb')
      thumb.setAttribute('alt', row.label)
      if (row.thumbUrl !== undefined) thumb.setAttribute('src', row.thumbUrl)
      thumb.setAttribute('role', 'button')
      thumb.setAttribute('tabindex', '0')
      thumb.addEventListener('click', () => actions.onPreviewAttachment(row.draftId))
      thumb.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key
        if (key !== 'Enter' && key !== ' ') return
        // The viewer takes focus onto its close button; left alone, this same
        // Enter's keypress would press that button and shut the viewer at once
        // (and Space would scroll the page under it).
        event.preventDefault()
        actions.onPreviewAttachment(row.draftId)
      })
      picture.appendChild(thumb)
    } else {
      // A placeholder of the same size: `importing` pulses, `failed` is a
      // danger-bordered box. Neither is a control — the ✕ and 重试 are — so it
      // is `aria-hidden` and the tile's own label does the talking.
      const placeholder = el('div', 'attachment-placeholder')
      placeholder.setAttribute('aria-hidden', 'true')
      picture.appendChild(placeholder)
    }

    if (row.state === 'failed') {
      const retry = button('attachment-retry', '重试', `重新导入 ${row.label}`, () => {
        actions.onRetryAttachment(row.draftId)
      })
      picture.appendChild(retry)
    }
    // The corner ✕, over the picture rather than after it: the tile is the
    // whole row now, so the remove has nowhere else to sit.
    const remove = button('attachment-remove', '', `移除 ${row.label}`, () => {
      actions.onRemoveAttachment(row.draftId)
    }, { icon: 'close' })
    picture.appendChild(remove)
    if (picture !== item) {
      item.appendChild(picture)
      if (row.detail !== undefined) item.appendChild(el('span', 'attachment-reason', row.detail))
    }
    return item
  }

  function setSendBlockNote(note: string | undefined): void {
    if (note === sendBlockNote) return
    sendBlockNote = note
    applySubmitState()
  }

  function applySubmitState(): void {
    const view = submitButtonView({
      streaming: streamingNow,
      empty: els.input.value.trim().length === 0 && (attachSignature ?? '') === '',
    })
    // Enabled in every state: `requestSubmit()` ignores a disabled button, so a
    // grey-but-meaningful button would swallow the click with no error anywhere.
    els.submit.disabled = locked
    els.submit.classList.remove('idle', 'ready')
    els.submit.classList.add(view.state)
    show(els.submit, !view.showStop)
    show(els.stop, view.showStop)
    // The note rides the button's own tooltip: the click still reaches the
    // pane (which explains itself in the transcript); this is the *why* shown
    // before the click, not a gate the renderer enforces on its own.
    const label = sendBlockNote ?? view.label
    els.submit.setAttribute('aria-label', label)
    els.submit.title = label
  }
  function toggleRuntimeMenu(): void {
    if (runtimeMenu) {
      closeRuntimeMenu()
      return
    }
    // Asked for, not opened: the rows need a round trip, and the answer comes
    // back through `showRuntimeMenu`.
    runtimeMenuPending = true
    actions.onOpenRuntimeMenu()
  }
  els.chipRuntime.addEventListener('click', toggleRuntimeMenu)
  function togglePermissionMenu(): void {
    permissionMenuOpen = !permissionMenuOpen
    renderPermission()
    // The mode in force, so the keyboard starts where the menu says it is.
    if (permissionMenuOpen) (permissionItems.find((item) => item.classList.contains('active')) ?? permissionItems[0])?.focus()
  }
  els.chipPermission.addEventListener('click', togglePermissionMenu)

  // Closed three ways: a press outside the shell, focus leaving it, and Escape.
  // `relatedTarget` is where focus *went*, so a click on a menu item — which
  // happens before the item's own `click` — must not close it. The shell, not
  // the menu, so the pill can still toggle its own popover shut.
  dismissable([els.chipPermission, '.permission-menu'], {
    isOpen: () => permissionMenuOpen,
    close: () => {
      permissionMenuOpen = false
      renderPermission()
    },
  })
  els.permissionShell.addEventListener('keydown', (event) =>
    rovingFocus(event, permissionItems, permissionMenuOpen, togglePermissionMenu))
  els.permissionShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
    if (next instanceof Node && els.permissionShell.contains(next)) return
    if (!permissionMenuOpen) return
    permissionMenuOpen = false
    renderPermission()
  })
  els.permissionShell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !permissionMenuOpen) return
    // Consumed here, so Escape over an open menu does not also reach the global
    // key map and close a surface or a dialog behind it.
    event.preventDefault()
    event.stopPropagation()
    permissionMenuOpen = false
    renderPermission()
    els.chipPermission.focus()
  })

  // Held rather than looked up: `querySelector` is not on the DOM surface
  // `test/helpers/domStub.ts` fakes, and a view that reaches for it would be
  // untestable for the sake of a search it already knows the answer to.
  let permissionMenu: HTMLElement | undefined
  let permissionPresence: Presence | undefined
  let permissionItems: HTMLButtonElement[] = []
  /** What the pill and the chip were last drawn from; see `renderPermission`. */
  let permissionSignature: string | undefined
  let chipSignature: string | undefined
  let contextSignature: string | undefined

  function renderPermission(): void {
    const view = permissionPillView({ runtime: runtimeSnapshot, open: permissionMenuOpen, coordinator: coordinatorLane })
    // `renderRuntime` runs on every snapshot, which during a turn is once per
    // streamed chunk, and the two `replace()` calls below rebuild this pill and
    // its menu whole. Nothing under the pointer may be rebuilt for a repaint
    // that changed nothing — the same rule `dom/settingsView.ts` keeps by id.
    // The open flags are part of the signature, or the guard would swallow the
    // click that opens the menu (`sidebarRenderSignature`'s `menuOpen`).
    const signature = [
      view.hidden ? 'x' : '-',
      view.label,
      view.title,
      view.enabled ? '1' : '0',
      view.open ? '1' : '0',
      view.danger ? 'd' : '-',
      permissionMenuOpen ? '1' : '0',
      view.open ? view.options.map((option) => `${option.mode}:${option.current ? '1' : '0'}`).join(',') : '',
    ].join(' ')
    if (signature === permissionSignature) return
    permissionSignature = signature

    show(els.chipPermission, !view.hidden)
    if (view.hidden) {
      permissionMenuOpen = false
      permissionPresence?.set(false)
      return
    }

    replace(els.chipPermission, el('span', 'btn-label', view.label))
    els.chipPermission.title = view.title
    els.chipPermission.setAttribute('aria-label', view.title)
    els.chipPermission.setAttribute('aria-haspopup', 'listbox')
    els.chipPermission.setAttribute('aria-expanded', view.open ? 'true' : 'false')
    els.chipPermission.disabled = !view.enabled
    els.chipPermission.classList.toggle('open', view.open)
    els.chipPermission.classList.toggle('danger', view.danger)

    if (!view.open) {
      // The model can refuse to open (no snapshot yet); the flag has to follow,
      // or the next click would read as "close" and do nothing visible.
      permissionMenuOpen = false
      const returnFocus = permissionMenu?.contains(document.activeElement)
      permissionPresence?.set(false)
      if (returnFocus) els.chipPermission.focus()
      return
    }

    if (!permissionMenu) {
      permissionMenu = el('div', 'composer-menu permission-menu')
      permissionMenu.setAttribute('role', 'listbox')
      permissionMenu.setAttribute('aria-label', '权限模式')
      permissionItems = view.options.map((option) => {
        const item = button(`composer-menu-item${option.danger ? ' danger' : ''}`, option.label, option.label, () => {
          permissionMenuOpen = false
          renderPermission()
          // Read live: the menu is built once and lives across mode changes.
          if (needsFullAccessConfirm(runtimeSnapshot?.permissionMode, option.mode)) actions.onRequestFullAccess()
          else actions.onSelectPermissionMode(option.mode)
          els.input.focus()
        })
        item.setAttribute('role', 'option')
        return item
      })
      reconcile(permissionMenu, permissionItems)
      followPointer(permissionMenu, '.composer-menu-item')
      els.permissionShell.appendChild(permissionMenu)
      permissionPresence = createPresence(permissionMenu)
    }
    view.options.forEach((option, index) => {
      const item = permissionItems[index]!
      item.classList.toggle('active', option.current)
      item.setAttribute('aria-selected', option.current ? 'true' : 'false')
    })
    permissionPresence!.set(true)
  }

  // --- the chip's popover ------------------------------------------------------

  let runtimeMenuNode: HTMLElement | undefined
  let runtimePresence: Presence | undefined
  let pickerPages: HTMLElement[] = []
  let modelPageOpen = false
  let modelLink: HTMLButtonElement | undefined
  let effortRange: HTMLInputElement | undefined
  let modelItems: HTMLButtonElement[] = []

  const pickerCanvas = els.chipShell.closest('#canvas')
  if (pickerCanvas && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (runtimeMenu && runtimeMenuNode) fitInCanvas(runtimeMenuNode)
    }).observe(pickerCanvas)
  }

  dismissable([els.chipRuntime, '.chip-menu'], {
    isOpen: () => runtimeMenu !== undefined,
    close: closeRuntimeMenu,
  })
  els.chipShell.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    if (next === null) return
    if (next instanceof Node && els.chipShell.contains(next)) return
    closeRuntimeMenu()
  })
  els.chipShell.addEventListener('keydown', (event) => {
    if (runtimeMenu && (event.key === 'Escape' || (modelPageOpen && event.key === 'ArrowLeft'))) {
      event.preventDefault()
      event.stopPropagation()
      if (modelPageOpen) showPickerPage(false)
      else closeRuntimeMenu()
      return
    }
    // A native range owns its arrow keys, Home and End.
    if (runtimeMenu && event.target === effortRange) return
    const items = modelPageOpen ? modelItems.filter((item) => !item.disabled) : [modelLink, effortRange].filter(
      (item): item is HTMLButtonElement | HTMLInputElement => item !== undefined && !item.disabled,
    )
    rovingFocus(event, runtimeMenu ? items : [], runtimeMenu !== undefined, toggleRuntimeMenu)
  })

  function closeRuntimeMenu(): void {
    runtimeMenuPending = false
    if (!runtimeMenu) return
    const returnFocus = runtimeMenuNode?.contains(document.activeElement)
    runtimeMenu = undefined
    runtimePresence?.set(false)
    els.chipRuntime.setAttribute('aria-expanded', 'false')
    els.chipRuntime.classList.remove('open')
    renderChip()
    if (returnFocus) els.chipRuntime.focus()
  }

  function showPickerPage(models: boolean, focus = true): void {
    modelPageOpen = models
    pickerPages.forEach((page, index) => {
      const open = index === (models ? 1 : 0)
      page.classList.toggle('open', open)
      page.setAttribute('aria-hidden', String(!open))
      if (open) page.removeAttribute('inert')
      else page.setAttribute('inert', '')
    })
    modelLink?.setAttribute('aria-expanded', String(models))
    if (!focus) return
    const availableModels = modelItems.filter((item) => !item.disabled)
    if (models) (availableModels.find((item) => item.getAttribute('aria-selected') === 'true') ?? availableModels[0]
      ?? runtimeMenuNode?.querySelector<HTMLButtonElement>('.chip-picker-back'))?.focus()
    else if (effortRange && !effortRange.disabled) effortRange.focus()
    else modelLink?.focus()
  }

  function chooseRuntimeRow(row: SurfaceRow): void {
    if (!row.action || row.current) return
    closeRuntimeMenu()
    actions.onRuntimeAction(row.action)
    els.input.focus()
  }

  function renderRuntimePicker(view: RuntimeMenuView): void {
    const model = view.entries.find((entry) => entry.key === 'model')!
    const effort = view.entries.find((entry) => entry.key === 'effort')!
    const value = el('div', 'chip-effort-value')
    const valueText = createTextSwap(value, 'chip-effort-label-text')
    valueText.set(effort.value)
    value.setAttribute('aria-live', 'polite')
    // The level and the model are one button, not a level above a small link: the
    // reference's target is the whole block, and its hover highlight is that
    // block's box. The level stays inside because it is the slider's live readout
    // (`aria-live`), which is why it is not part of the button's own name.
    const modelRow = el('span', 'chip-picker-model-row',
      el('span', 'btn-label', model.value),
      icon('chevron-right'),
    )
    modelLink = button('chip-picker-model', '', '选择模型', () => showPickerPage(true))
    replace(modelLink, value, modelRow)
    modelLink.setAttribute('aria-expanded', 'false')
    modelLink.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      showPickerPage(true)
    })
    const choices = effort.rows.filter((row) => row.action && !row.disabled)
    const current = choices.findIndex((row) => row.current)
    let selectedEffort = choices[current]?.id
    const slider = el('div', 'chip-effort-slider')
    const fill = el('div', 'chip-effort-fill')
    const ticks = el('div', 'chip-effort-ticks', ...choices.map(() => el('span', 'chip-effort-tick')))
    const knob = el('div', 'chip-effort-knob')
    for (const decoration of [fill, ticks, knob]) decoration.setAttribute('aria-hidden', 'true')
    const range = el('input', 'chip-effort-range')
    range.type = 'range'
    range.min = '0'
    range.max = String(Math.max(choices.length - 1, 1))
    range.step = '1'
    range.value = String(Math.max(current, 0))
    range.disabled = choices.length < 2
    range.setAttribute('aria-label', effort.title)
    range.setAttribute('aria-valuetext', effort.value)
    range.title = choices.map((row) => row.label).join(' · ')
    effortRange = range
    const paintSlider = (): void => {
      slider.style.setProperty('--effort-ratio', String(Number(range.value) / Number(range.max)))
      Array.from(ticks.children).forEach((tick, index) => {
        tick.classList.toggle('filled', index <= Number(range.value))
      })
    }
    paintSlider()
    slider.classList.toggle('custom-budget', current < 0)
    slider.classList.toggle('disabled', range.disabled)
    range.addEventListener('input', () => {
      const row = choices[Number(range.value)]
      if (!row) return
      slider.classList.remove('custom-budget')
      valueText.set(row.label)
      range.setAttribute('aria-valuetext', row.label)
      paintSlider()
    })
    // Preview while dragging; persist once, on release (or a keyboard change).
    range.addEventListener('change', () => {
      const row = choices[Number(range.value)]
      if (!row?.action || row.id === selectedEffort) return
      selectedEffort = row.id
      actions.onRuntimeAction(row.action)
    })
    replace(slider, fill, ticks, knob, range)
    const effortContent = el('div', 'chip-picker-content',
      el('div', 'chip-effort-card', modelLink, slider),
    )

    const back = button('chip-picker-back', model.title, '返回思考强度', () => showPickerPage(false), {
      icon: 'chevron-left',
    })
    const list = el('div', 'chip-model-list')
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', model.title)
    modelItems = model.rows.map((row) => {
      const item = button(`chip-model-option${row.disabled ? ' disabled' : ''}`, row.label,
        row.disabledReason ?? row.label, () => chooseRuntimeRow(row), { enabled: row.action !== undefined })
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(row.current === true))
      const note = row.disabledReason ?? row.detail
      if (note) item.appendChild(el('span', 'chip-model-note', note))
      if (row.current) item.appendChild(icon('check'))
      return item
    })
    replace(list, ...modelItems)
    if (!modelItems.length) list.appendChild(el('div', 'chip-picker-empty', '暂无可用模型'))
    followPointer(list, '.chip-model-option')
    pickerPages = [
      el('div', 'chip-picker-page', effortContent),
      el('div', 'chip-picker-page', el('div', 'chip-picker-content', back, list)),
    ]
    replace(runtimeMenuNode!, ...pickerPages)
    showPickerPage(false, false)
  }

  function renderChip(): void {
    const chip = composerChipView(runtimeSnapshot)
    // Signed for the reason the permission pill is: this runs per streamed
    // chunk and the `replace()` below rebuilds the whole button. `open` is part
    // of the signature because the menu swaps what the pill says.
    const open = runtimeMenu !== undefined
    const signature = [chip.label, chip.title, chip.enabled ? '1' : '0', open ? '1' : '0'].join(' ')
    if (signature === chipSignature) return
    chipSignature = signature

    // Closed, the pill is the two values it opens. Open, it names the decision
    // instead: the menu beneath it already says `最高` and the model, and the
    // reference's pill turns into the invitation at that moment. The icon rides
    // along at every width and the stylesheet swaps it for the words once the
    // row is too narrow to hold them.
    replace(
      els.chipRuntime,
      icon('model', 'icon chip-model-icon'),
      ...(open
        ? [el('span', 'chip-prompt-label', chip.label)]
        : [el('span', 'chip-model-label', chip.model), el('span', 'chip-effort-label', chip.effort)]),
      icon('chevron-down', 'icon chip-chevron'),
    )
    const title = chip.title
    els.chipRuntime.title = title
    els.chipRuntime.setAttribute('aria-label', title)
    els.chipRuntime.setAttribute('aria-haspopup', 'dialog')
    els.chipRuntime.disabled = !chip.enabled
  }

  /**
   * The independent occupancy indicator. A hover shows its one-line figure; a
   * click opens the breakdown, fetched from the host on open and again whenever
   * the figure moves while it is open. The whole subtree is signed for the same
   * reason the chip is: streaming repaints must not rebuild what the pointer is over.
   */
  const contextRing = el('span', 'context-gauge')
  contextRing.setAttribute('aria-hidden', 'true')
  // The ring sits in a real button rather than the shell being a `role=button`:
  // the shell also holds the popover, and a button may not contain the popover's
  // own buttons. The button is also what puts the indicator in the tab order.
  const contextTrigger = el('button', 'context-trigger', contextRing)
  contextTrigger.type = 'button'
  contextTrigger.setAttribute('aria-haspopup', 'dialog')
  contextTrigger.setAttribute('aria-expanded', 'false')
  const contextCard = createHoverCard(els.contextIndicator, 'context-tooltip')
  const contextPopover = createContextPopover({
    onCompact: () => {
      setContextOpen(false)
      contextTrigger.focus()
      actions.onRuntimeAction({ kind: 'run-command', line: '/compact' })
    },
  })
  let contextOpen = false
  let contextLoad = 0

  async function loadContextBreakdown(): Promise<void> {
    const token = ++contextLoad
    let state: ContextPopoverState
    try {
      const { breakdown } = await actions.onLoadContextBreakdown()
      const runtime = runtimeSnapshot
      state = breakdown && runtime?.status === 'ready' && runtime.usableContextWindow
        ? {
            kind: 'ready',
            view: contextPopoverView(breakdown, runtime.contextWindow ?? runtime.usableContextWindow, runtime.usableContextWindow),
          }
        : { kind: 'empty' }
    } catch (error) {
      state = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    if (token !== contextLoad || !contextOpen) return
    contextPopover.paint(state)
    if (contextPopover.presence.phase !== 'closed') return
    contextPopover.presence.set(true)
    fitInCanvas(contextPopover.node)
  }

  function setContextOpen(open: boolean): void {
    if (open === contextOpen) return
    contextOpen = open
    contextTrigger.setAttribute('aria-expanded', String(open))
    els.contextIndicator.classList.toggle('open', open)
    contextSignature = undefined
    renderContextGauge()
    if (open) void loadContextBreakdown()
    else contextPopover.presence.set(false)
  }

  contextTrigger.addEventListener('click', () => setContextOpen(!contextOpen))
  els.contextIndicator.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && contextOpen) {
      event.preventDefault()
      event.stopPropagation()
      setContextOpen(false)
      contextTrigger.focus()
    }
  })
  els.contextIndicator.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null || (next instanceof Node && els.contextIndicator.contains(next))) return
    setContextOpen(false)
  })
  dismissable([els.contextIndicator], { isOpen: () => contextOpen, close: () => setContextOpen(false) })

  function renderContextGauge(): void {
    const signature = [
      contextGauge.visible ? `${contextGauge.level}:${contextGauge.ratio}:${contextGauge.title}` : '',
      contextOpen ? '1' : '0',
    ].join(' ')
    if (signature === contextSignature) return
    const moved = contextSignature !== undefined
    contextSignature = signature

    show(els.contextIndicator, contextGauge.visible)
    if (!contextGauge.visible) {
      contextCard.finish()
      contextOpen = false
      contextTrigger.setAttribute('aria-expanded', 'false')
      els.contextIndicator.classList.remove('open')
      contextPopover.presence.finish()
      replace(els.contextIndicator)
      contextTrigger.removeAttribute('aria-label')
      return
    }

    contextRing.className = `context-gauge ${contextGauge.level}`
    contextRing.style.setProperty(CONTEXT_RATIO_VARIABLE, String(contextGauge.ratio))
    contextCard.set(contextOpen
      ? undefined
      : { title: '已使用', lead: `${contextGauge.percent} · ${contextGauge.used} / ${contextGauge.usable}`, rows: [] })
    reconcile(els.contextIndicator, [contextTrigger, contextCard.node, contextPopover.node])
    contextTrigger.setAttribute('aria-label', contextGauge.title.replace(/\n/g, '；'))
    if (contextOpen && moved) void loadContextBreakdown()
  }

  els.input.addEventListener('input', () => {
    renderInput()
    applySubmitState()
  })
  els.input.addEventListener('compositionend', () => renderInput())
  els.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace' || event.isComposing) return
    const match = matchInputCommand(els.input.value, commands)
    const cursor = els.input.selectionStart
    if (!match?.command.isSkill || cursor !== els.input.selectionEnd || cursor <= match.start) return
    if (cursor > match.end && els.input.value.slice(match.end, cursor).trim() !== '') return
    // Let the browser delete the selected token, retaining its undo history.
    els.input.setSelectionRange(match.start, Math.max(match.end, cursor))
  })
  // A draft past the height cap scrolls, and its top line then sits half under
  // the capsule's edge. The stylesheet fades that edge, but only while there is
  // something above it — at rest the first line must stay fully inked.
  els.input.addEventListener('scroll', () => {
    els.input.classList.toggle('scrolled', els.input.scrollTop > 0)
    syncHighlightScroll()
  })
  // Paste: an image in the clipboard becomes an attachment rather than text.
  // Only files make that call — a plain-text paste, even of a path, stays the
  // textarea's business (path pastes are the TUI's rule; here the picker, drag
  // and paste cover the image entrances). The event is left alone otherwise,
  // so the browser's own text insert still runs.
  const onPasteImages = actions.onPasteImages
  els.input.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0 || !files.some((file) => file.type.startsWith('image/'))) return
    event.preventDefault()
    onPasteImages(files)
  })
  // Painted before the first snapshot too, or the chip stays enabled with
  // `index.html`'s placeholder in it and opens a menu of nothing.
  renderChip()
  renderContextGauge()
  renderPermission()
  applySubmitState()
  renderInput()

  return {
    editValue(text, cursorPos) {
      if (richEditor) richEditor.editValue(text, cursorPos)
      else { els.input.value = text; els.input.setSelectionRange(cursorPos, cursorPos) }
      renderInput()
      autosize()
      applySubmitState()
    },
    placeCaretAtPoint(x, y) { richEditor?.placeCaretAtPoint(x, y) },
    insertText(text, trailingSpace = false) {
      const start = els.input.selectionStart ?? els.input.value.length
      const end = els.input.selectionEnd ?? start
      const next = insertSuggestion(els.input.value, start, end, text, trailingSpace)
      if (richEditor) richEditor.editValue(next.text, next.cursorPos)
      else {
        els.input.value = next.text
        els.input.setSelectionRange(next.cursorPos, next.cursorPos)
      }
      renderInput()
      autosize()
      applySubmitState()
    },
    value: () => els.input.value,
    // `selectionStart` is null only for input types that have no selection;
    // a textarea always reports one, and the end of the text is the safe read.
    cursorPos: () => els.input.selectionStart ?? els.input.value.length,
    setCommands(next) {
      commands = next
      renderInput()
      autosize()
    },
    setValue(text, cursorPos, nextCommands) {
      if (nextCommands !== undefined) commands = nextCommands
      els.input.value = text
      if (cursorPos !== undefined) els.input.setSelectionRange(cursorPos, cursorPos)
      renderInput()
      autosize()
      // A programmatic edit fires no `input` event, so the button state has to be
      // recomputed by hand — otherwise a restored draft leaves it reading "idle".
      applySubmitState()
    },
    clear() {
      els.input.value = ''
      renderInput()
      autosize()
      applySubmitState()
    },
    focus() {
      els.input.focus()
    },
    setLocked(reason) {
      if (locked === (reason !== undefined) && (reason ?? defaultPlaceholder) === els.input.placeholder) return
      locked = reason !== undefined
      els.input.disabled = locked
      els.input.placeholder = reason ?? defaultPlaceholder
      applySubmitState()
    },
    setStreaming(streaming) {
      // Stop takes the send button's place only while nothing is typed; see
      // `submitButtonView`.
      streamingNow = streaming
      applySubmitState()
    },
    renderRuntime(runtime, gauge, coordinator) {
      runtimeSnapshot = runtime
      coordinatorLane = coordinator === true
      contextGauge = gauge ?? hiddenContextGauge()
      renderChip()
      renderContextGauge()
      renderPermission()
    },
    showRuntimeMenu(view) {
      // A late answer: the user has clicked again, or the pane went to the
      // background and `closeMenus` cleared the request.
      if (!runtimeMenuPending) return
      runtimeMenuPending = false
      // The model can refuse to open (no snapshot yet); nothing is drawn, and the
      // next click asks again rather than reading as "close".
      if (!view.enabled) return
      closeRuntimeMenu()
      runtimeMenu = view

      if (!runtimeMenuNode) {
        runtimeMenuNode = el('div', 'chip-menu')
        runtimeMenuNode.setAttribute('role', 'dialog')
        runtimeMenuNode.setAttribute('aria-label', '模型与思考强度')
        els.chipShell.appendChild(runtimeMenuNode)
        runtimePresence = createPresence(runtimeMenuNode)
      }
      renderRuntimePicker(view)
      runtimePresence!.set(true)
      fitInCanvas(runtimeMenuNode)
      els.chipRuntime.setAttribute('aria-expanded', 'true')
      els.chipRuntime.classList.add('open')
      renderChip()
      showPickerPage(false)
    },
    refreshSubmit: applySubmitState,
    renderAttachments,
    setSendBlockNote,
    attachStripEl: () => els.attachStrip,
    closeMenus() {
      closeRuntimeMenu()
      closeAttachMenu()
      contextCard.finish()
      setContextOpen(false)
      contextPopover.presence.finish()
      if (permissionMenuOpen) {
        permissionMenuOpen = false
        renderPermission()
      }
      // Called on pane switches: no outgoing visual may overlay the next pane.
      finishPresenceWithin(els.chipShell)
      finishPresenceWithin(els.permissionShell)
      finishPresenceWithin(attachShell)
    },
    autosize,
  }
}
