/**
 * The one global key handler's decision table.
 *
 * The load-bearing rule is the priority order, and specifically that **an open
 * dialog outranks interrupting the turn**. `ToolRunner.run` does not pass its
 * abort signal into `PermissionGate.approve`, so a turn parked on a permission
 * prompt is not released by `interrupt()` — if Escape interrupted instead of
 * answering, the prompt would stay open, the loop would stay parked, and the only
 * way out would be killing the window. `test/rendererShellModel.test.ts` pins this,
 * and swapping the two branches is a mutation that test catches.
 *
 * DOM-free on purpose: this module is imported by a test, which compiles it in
 * the base tsconfig program where there is no DOM lib — hence the structural key
 * shape rather than `KeyboardEvent`.
 */

export interface KeyChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

export interface ShellState {
  /** A blocking UI request is being drawn. It owns the keyboard outright. */
  readonly hasOverlay: boolean
  /**
   * The `/rewind` panel is open. Modal — it owns the keyboard the way the
   * terminal's restore mode blocks input — but it ranks *below* `hasOverlay`,
   * because nothing in the agent loop is waiting on it.
   */
  readonly hasRewind: boolean
  /** A *picker* is open: dismissible, blocks nothing, and its rows are pickable. */
  readonly hasSurface: boolean
  /**
   * A slash command's information table is open (`/session`, `/cost`, `/help`).
   *
   * Separate from `hasSurface` because the two panels answer the arrows
   * differently: a command view is a table of facts with no pickable row, so
   * Enter must still mean "send my message". Only Escape and a press outside
   * apply to both.
   */
  readonly hasCommandView: boolean
  /**
   * Which source is filling the dropdown, if any.
   *
   * A bare boolean used to be enough. It stopped being enough when file mentions
   * arrived: Enter on a command suggestion accepts *and runs*, but Enter on a
   * file suggestion must only accept — `@src/foo.ts` is a fragment of a sentence
   * still being written, and submitting there sends half a prompt.
   */
  readonly completions: 'none' | 'command' | 'file'
  readonly isStreaming: boolean
  readonly inputEmpty: boolean
}

/**
 * What the window itself has open, beside the active pane's {@link ShellState}.
 *
 * These are window-level because none belongs to one pane: a popover hangs off
 * the sidebar or the composer, a screen replaces the canvas, and the viewer
 * covers everything. They matter to Escape only — and only when focus is not
 * inside the layer, since a focused layer handles its own Escape. Focus falls to
 * `<body>` whenever a repaint destroys the focused node, which is how Escape
 * used to reach "interrupt the turn" with a menu still open.
 */
export interface WindowLayers {
  /** The fullscreen image viewer, drawn over every other layer. */
  readonly viewer: boolean
  /** The settings screen or the projects page, each replacing the canvas. */
  readonly screen: boolean
  /** A menu, picker or confirmation (`dom/dismiss.ts`). */
  readonly popover: boolean
}

export const NO_LAYERS: WindowLayers = { viewer: false, screen: false, popover: false }

export type KeyAction =
  /** Hand the chord to the dialog's own key map. */
  | 'overlay'
  /** Hand the chord to the rewind panel's own key map. */
  | 'rewind'
  | 'close-viewer'
  | 'close-popover'
  | 'close-screen'
  | 'close-surface'
  | 'move-surface-up'
  | 'move-surface-down'
  | 'activate-surface'
  | 'accept-completion'
  | 'submit-completion'
  | 'move-completion-up'
  | 'move-completion-down'
  | 'close-completions'
  | 'interrupt'
  | 'submit'
  /** A turn is in flight: hand the text to the host's message queue instead. */
  | 'enqueue'
  | 'newline'
  | 'none'

/**
 * Where focus sat when a key arrived — the one input to the key map that is
 * not pane state. Structural for the same reason {@link KeyChord} is: `app.ts`
 * reads it off `event.target`, and this module never sees a DOM node.
 */
export interface KeyTarget {
  /** The composer's own field. The key map decides for it, always. */
  readonly composer: boolean
  /** A text field: `input`, `textarea`, `select`, or an editable region. */
  readonly editable: boolean
  /** A control that presses itself on Enter and Space: a button or a link. */
  readonly pressable: boolean
  /**
   * Inside the layer the action routes to: the docked request card for
   * `'overlay'`, the rewind panel for `'rewind'`. False for every other action.
   */
  readonly inLayer: boolean
}

/**
 * Whether the focused control answers this key itself, so the key map must
 * leave it alone.
 *
 * A field other than the composer keeps what is typed into it (the sidebar
 * search, a settings input, the browser's address bar), and a button or link
 * keeps the Enter and Space that press it. Left to the key map, Escape in
 * those fields stopped the turn and Enter on a thumbnail sent the draft.
 *
 * A blocking request and the rewind panel used to be exempt and take every key
 * wherever focus was, so typing in the sidebar search while a permission card
 * waited answered the card — `y` allowed, Escape denied. They now take only
 * keys from their own card, and keys focus has no use for (the page itself, a
 * row with no keyboard meaning, the composer the card has replaced). That is
 * still enough to answer them from anywhere a stray repaint drops focus.
 */
export function ownedByTarget(key: string, action: KeyAction, target: KeyTarget): boolean {
  if (target.composer) return false
  if ((action === 'overlay' || action === 'rewind') && target.inLayer) return false
  if (target.editable) return true
  return target.pressable && (key === 'Enter' || key === ' ')
}

/**
 * Whether accepting a completion should also send it.
 *
 * Shared by Enter and by a click on the row, so the mouse cannot end up
 * submitting where the keyboard only fills in. Both exceptions are the same:
 * a file mention is a fragment of a sentence, and mid-turn there is nothing to
 * submit into.
 */
export function completionAcceptMode(state: ShellState): 'accept' | 'submit' {
  return state.isStreaming || state.completions === 'file' ? 'accept' : 'submit'
}

export function resolveKey(chord: KeyChord, state: ShellState, layers: WindowLayers = NO_LAYERS): KeyAction {
  // 0. The viewer is the topmost layer on screen, a blocking request's card
  //    included, so Escape closes it before anything beneath it hears the key.
  if (chord.key === 'Escape' && layers.viewer) return 'close-viewer'

  // 1. A blocking request first, always. See the note above.
  if (state.hasOverlay) return 'overlay'

  // 2. The rewind panel, which is modal but not blocking. It sits here rather
  //    than first because a permission prompt is holding the agent loop and this
  //    is only holding the user — and it sits above everything below because
  //    every one of its options is destructive, so a keystroke must not fall
  //    through to the composer while a confirm screen is up.
  if (state.hasRewind) return 'rewind'

  // 2b. Escape unwinds the window's layers top-down before it can mean anything
  //     below: a popover floats above a screen, a screen replaces the composer
  //     and so everything the composer owns (3–6).
  if (chord.key === 'Escape') {
    if (layers.popover) return 'close-popover'
    if (layers.screen) return 'close-screen'
  }

  // 3. The completion dropdown, which owns Tab/arrows/Enter while it is open.
  if (state.completions !== 'none') {
    if (chord.key === 'Tab') return 'accept-completion'
    if (chord.key === 'ArrowUp') return 'move-completion-up'
    if (chord.key === 'ArrowDown') return 'move-completion-down'
    if (chord.key === 'Escape') return 'close-completions'
    // Enter accepts *and runs*, matching the terminal
    // (`useKeyboardShortcuts.ts:286-291` submits rather than filling in). Tab is
    // the accept-only affordance; requiring two Enters for `/model` would be a
    // gratuitous difference between the two shells.
    //
    // A file mention is the exception, and mid-turn there is nothing to submit
    // into, so both degrade to accepting.
    if (chord.key === 'Enter' && chord.shiftKey !== true) {
      return completionAcceptMode(state) === 'accept' ? 'accept-completion' : 'submit-completion'
    }
  }

  // 4. A dismissible panel — either kind, since Escape means the same to both.
  if ((state.hasSurface || state.hasCommandView) && chord.key === 'Escape') return 'close-surface'

  // 5. Picking a row out of that panel — but only while the composer is empty.
  //
  // The panel does not block, so a user may open `/model`, start typing, and hit
  // Enter meaning "send my message". Taking Enter unconditionally would silently
  // switch models instead. Note this can never contend with the dropdown above:
  // completions require a typed `/` or `@`, so the two are mutually exclusive by
  // construction.
  //
  // `hasCommandView` is deliberately absent: that panel has no pickable row, so
  // taking Enter there would make it impossible to send a message with `/session`
  // still on screen.
  if (state.hasSurface && state.inputEmpty) {
    if (chord.key === 'ArrowUp') return 'move-surface-up'
    if (chord.key === 'ArrowDown') return 'move-surface-down'
    if (chord.key === 'Enter' && chord.shiftKey !== true) return 'activate-surface'
  }

  if (chord.key === 'Escape') {
    // 6. Only now does Escape mean "stop the turn".
    if (state.isStreaming) return 'interrupt'
    return 'none'
  }

  if (chord.key === 'Enter') {
    if (chord.shiftKey === true) return 'newline'
    if (state.inputEmpty) return 'none'
    // A turn in flight queues the message rather than sending it, matching the
    // terminal (`App.tsx`'s `handleSubmit` enqueues whenever a turn is running).
    // It used to be dropped instead, because `SessionController.submit` had no
    // in-flight guard and a second call would overwrite the live
    // `AbortController`, leaving the first turn impossible to interrupt. The
    // guard is now in the kernel, so the message has somewhere to go.
    if (state.isStreaming) return 'enqueue'
    return 'submit'
  }

  return 'none'
}
