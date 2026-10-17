import {
  coordinatorWelcome,
  welcomeRenderSignature,
  type WelcomePill,
  type WelcomeView,
} from '../model/welcome.js'
import { BRANCH_PICKER_LABEL, type BranchPickerIntent } from '../model/branchPicker.js'
import { PROJECT_PICKER_LABEL, type ProjectPickerIntent } from '../model/projectPicker.js'
import { createBranchPickerView, type BranchPickerDom } from './branchPickerView.js'
import { createProjectPickerView, type ProjectPickerDom } from './projectPickerView.js'
import { createUsageCard } from './usageCardView.js'
import type { WireUsageDay } from '../../shellProtocol.js'
import { el, reconcile, replace, show } from './dom.js'
import { button } from './controls.js'
import { dismissable } from './dismiss.js'
import { icon } from './icons.js'
import { finishPresenceWithin } from './presence.js'

/**
 * The empty-state home page as DOM.
 *
 * Mounted inside the pane's own subtree rather than as a singleton panel, so it
 * is hidden with the rest of a backgrounded pane. Every decision is
 * `model/welcome.ts`'s, including whether this is visible at all.
 *
 * The scaffolding — the title, the usage card, the pill row and the two pill
 * anchors — is built **once** and only its contents are replaced. The anchors
 * in particular have to survive: the popover inside one is the node that takes
 * focus when it opens, and rebuilding it around that focus would blur it and
 * fire the `focusout` that closes the popover the click just opened. The same
 * goes for the card's segment buttons.
 *
 * The usage numbers never block the page: the card draws its skeleton at once,
 * and each time the page goes from hidden to shown the stats are asked for in
 * the background (the host caches the scan, so this is cheap). A repaint while
 * shown asks for nothing.
 */

export interface WelcomeDom {
  render(view: WelcomeView): void
  /** Puts focus in the branch popover, for the click that opened it. */
  focusBranchPicker(): void
  /** The same, for the project popover. */
  focusProjectPicker(): void
  dispose(): void
}

export interface WelcomeHandlers {
  onBranchIntent: (intent: BranchPickerIntent) => void
  /** Fed the raw chord; answers whether the branch popover consumed it. */
  onBranchKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean
  onProjectIntent: (intent: ProjectPickerIntent) => void
  /** Fed the raw chord; answers whether the project popover consumed it. */
  onProjectKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean
  loadUsage: () => Promise<readonly WireUsageDay[]>
}

export function createWelcomeView(
  container: HTMLElement,
  handlers: WelcomeHandlers,
): WelcomeDom {
  // --- the scaffolding, built once ------------------------------------------

  const title = el('h1', 'welcome-title')
  const head = el('div', 'welcome-head', icon('cat', 'icon welcome-mark'), title)
  const usage = createUsageCard()
  const usageSlot = el('div', 'welcome-usage')
  const pills = el('div', 'welcome-pills')

  /**
   * One switchable pill's home: the anchor its popover is positioned against,
   * and the slot the pill itself is swapped in and out of.
   *
   * Persistent for the focus reason in the header, and positioned by the
   * stylesheet, so nothing here measures or writes geometry. The pill gets a
   * slot of its own because the popover is the anchor's other child, and
   * swapping the pill around it must not touch it.
   */
  const unregister: Array<() => void> = []
  const pillAnchor = (kind: WelcomePill['kind'], isOpen: () => boolean, close: () => void) => {
    const anchor = el('div', `welcome-${kind}-anchor welcome-pill-anchor`)
    const slot = el('div', `welcome-${kind}-slot welcome-pill-slot`)
    anchor.appendChild(slot)
    // A press anywhere else closes the popover (`dom/dismiss.ts`), which
    // otherwise has only Escape and picking a row: it hangs over the transcript,
    // and the transcript is exactly the unfocusable scenery a `focusout` cannot
    // see.
    //
    // Scoped to the anchor — the popover *and* the pill that opens it — rather
    // than to the pill row around them: closing on a press on the trigger would
    // let its own `click` re-open the popover the user was shutting. The pill
    // closes it itself, as a toggle.
    unregister.push(dismissable([anchor], { isOpen, close }))
    // The second of the three ways every popover closes. `relatedTarget === null`
    // is this view's own repaint rather than the user leaving, and answering it
    // with a close would shut the popover on the paint that drew it.
    anchor.addEventListener('focusout', (event) => {
      const next = (event as FocusEvent).relatedTarget
      if (next === null) return
      if (next instanceof Node && anchor.contains(next)) return
      close()
    })
    return { anchor, slot }
  }

  /** Whether each popover was drawn open: what a press outside may dismiss. */
  let branchOpen = false
  let projectOpen = false

  const branch = pillAnchor('branch', () => branchOpen, () => handlers.onBranchIntent({ kind: 'close' }))
  const branchPicker: BranchPickerDom = createBranchPickerView(
    branch.anchor,
    handlers.onBranchIntent,
    handlers.onBranchKey,
  )
  const project = pillAnchor('project', () => projectOpen, () => handlers.onProjectIntent({ kind: 'close' }))
  const projectPicker: ProjectPickerDom = createProjectPickerView(
    project.anchor,
    handlers.onProjectIntent,
    handlers.onProjectKey,
  )

  /** Which switcher a pill toggles, and what its control says it does. */
  const opener = (kind: WelcomePill['kind'], open: boolean): { label: string; toggle: () => void } => {
    const kindOfIntent = open ? 'close' : 'open'
    return kind === 'branch'
      ? { label: BRANCH_PICKER_LABEL, toggle: () => handlers.onBranchIntent({ kind: kindOfIntent }) }
      : { label: PROJECT_PICKER_LABEL, toggle: () => handlers.onProjectIntent({ kind: kindOfIntent }) }
  }

  const pillNode = (pill: WelcomePill, open: boolean): HTMLElement => {
    if (!pill.interactive) {
      const node = el('span', `welcome-pill ${pill.kind}`)
      node.appendChild(icon(pill.icon))
      node.appendChild(el('span', 'welcome-pill-label', pill.label))
      return node
    }
    const { label, toggle } = opener(pill.kind, open)
    const node = button(`welcome-pill ${pill.kind}`, pill.label, label, toggle, { icon: pill.icon })
    node.setAttribute('aria-haspopup', 'dialog')
    node.setAttribute('aria-expanded', String(open))
    return node
  }

  /**
   * The last drawn signature. Load-bearing: this renders from the pane's single
   * transcript paint, which runs once per streamed token.
   */
  let drawn: string | undefined
  /** Whether the scaffolding is in the container. See the `visible` branch. */
  let mounted = false
  let shown = false
  /** Only the newest request may fill the card. */
  let request = 0
  const refreshUsage = (): void => {
    const mine = ++request
    void handlers.loadUsage().then(
      (days) => { if (mine === request) usage.setDays(days) },
      () => {
        if (mine !== request) return
        usage.setUnavailable(() => {
          usage.setDays(undefined)
          refreshUsage()
        })
      },
    )
  }
  return {
    dispose() {
      for (const stop of unregister) stop()
    },
    focusBranchPicker() {
      branchPicker.focusPanel()
    },
    focusProjectPicker() {
      projectPicker.focusPanel()
    },
    render(view) {
      const signature = welcomeRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      branchOpen = view.branchPicker.open
      projectOpen = view.projectPicker.open
      show(container, view.visible)
      if (!view.visible) {
        // The contents go, the scaffolding stays: an invisible page must not
        // keep a button Tab can walk into from the composer, but the two pill
        // anchors have to survive as nodes — they are the only things here that
        // hold focus. `model/welcome.ts` forces both popovers shut whenever the
        // screen is invisible, and a shut popover draws nothing focusable.
        shown = false
        replace(usageSlot)
        branchPicker.render(view.branchPicker)
        finishPresenceWithin(branch.anchor)
        projectPicker.render(view.projectPicker)
        finishPresenceWithin(project.anchor)
        replace(pills)
        return
      }
      if (!mounted) {
        replace(container, head, usageSlot, pills)
        mounted = true
      }
      title.textContent = view.title
      reconcile(usageSlot, [usage.element])
      if (!shown) {
        shown = true
        refreshUsage()
      }
      // Each pill goes *into* its persistent anchor, ahead of the popover the
      // anchor already holds — a read-only pill included, so a project that
      // becomes switchable later does not have to move between two homes.
      const rendered: HTMLElement[] = []
      for (const pill of view.pills) {
        const home = pill.kind === 'branch' ? branch : project
        replace(home.slot, pillNode(pill, pill.kind === 'branch' ? branchOpen : projectOpen))
        rendered.push(home.anchor)
      }
      // `reconcile`, not `replace`: the anchors are in this list, and detaching
      // one — even for the rest of one script turn — would blur the popover
      // inside it, which is the `focusout` that closes the popover the click
      // opened.
      reconcile(pills, rendered)
      branchPicker.render(view.branchPicker)
      projectPicker.render(view.projectPicker)
    },
  }
}

/** The coordinator's fixed welcome; 「线程」 is a chip that opens the thread page, 「读取项目」 one that starts the survey. */
export function createCoordinatorWelcome(
  input: Parameters<typeof coordinatorWelcome>[0],
  onOpenOverview: () => void,
  onStartSurvey: () => void,
): HTMLElement {
  const paragraphs = coordinatorWelcome(input).map((segments) =>
    el('p', undefined, ...segments.map((segment) =>
      typeof segment === 'string'
        ? segment
        : segment.link === 'overview'
          ? button('coordinator-welcome-link', segment.label, '打开线程页', onOpenOverview, { icon: 'overview' })
          : button('coordinator-welcome-link', segment.label, '派一个线程了解这个项目', onStartSurvey, { icon: 'folder' }))))
  return el('div', 'coordinator-welcome', ...paragraphs)
}
