import { type TranscriptItemKind, type TranscriptState } from './transcript.js'
import {
  branchPickerSignature,
  branchPickerView,
  createBranchPickerState,
  type BranchPickerState,
  type BranchPickerView,
} from './branchPicker.js'
import {
  canSwitchProject,
  createProjectPickerState,
  projectPickerSignature,
  projectPickerView,
  type ProjectPickerEntry,
  type ProjectPickerState,
  type ProjectPickerView,
} from './projectPicker.js'

/**
 * The empty-state welcome screen, as data.
 *
 * Drawn in place of a conversation when there is nothing to read yet: a
 * masthead (a wordmark and the Hero line naming the project) hung off a single
 * brand-coloured rule, a strip of context pills, and one line of key hints.
 * `dom/welcomeView.ts` builds the nodes; every decision — above all *whether it
 * shows at all* — is here, where it can be tested without a DOM.
 *
 * The pills used to be three, all read-only, and the Hero's project name used to
 * be a button opening a workspace switcher. Both of those are gone: a「本地」pill
 * naming the one runtime that has ever existed carried no information, and the
 * switcher hung off the Hero *sentence*, where its popover was clipped by the
 * canvas. What is left is the project it runs in and the branch it is on — and
 * both are things worth changing from here, so both pills are controls, with the
 * same shape and the same popover shell (`model/projectPicker.ts`,
 * `model/branchPicker.ts`). The Hero's project name stays a plain `<span>`: the
 * switcher belongs on the pill, which is a pill-shaped control in a row of them,
 * not in the middle of a sentence.
 *
 * There is no graphic mark. The screen used to open with an icon above three
 * guidance cards, which is the shape every agent shell ships and therefore the
 * shape none of them is recognised by; the identity is carried by type instead —
 * the wordmark's tracking, the Hero's serif at display size, and the 2px rule
 * the whole block hangs on. The rule is the only "graphic", and it is a token
 * (`--accent-brand`), not a drawing.
 *
 * The cards went with it. They were guidance, not templates — clicking one only
 * focused the composer — and the hint line does that job in one row: it names
 * the three affordances a new user cannot guess (`/`, `@`, the permission
 * chord) instead of restating what a coding agent is for.
 */

export type WelcomePillKind = 'project' | 'branch'

/** The Hero line, split so the project name can be its own node. */
export const WELCOME_TITLE_BEFORE = '你想让我们在 '
export const WELCOME_TITLE_AFTER = ' 中构建什么？'
/** The global workspace's Hero: no project segment, nothing to name. */
export const WELCOME_GLOBAL_TITLE = '你想让我们构建什么？'
/** Where the global workspace's records land — the pill says so. */
export const WELCOME_GLOBAL_LOCATION = '~/.myagent'
/** Shown until `hello` answers; the name is unknown for a frame or two. */
export const WELCOME_PROJECT_FALLBACK = '当前项目'

/**
 * The wordmark above the Hero.
 *
 * Lower case, and set in the mono stack by the sheet: upper case in a CJK
 * interface reads as a system banner, lower case reads as a signature — which
 * is what this is. It is the product's name, so it is not translated.
 */
export const WELCOME_WORDMARK = 'hanekawa'

/**
 * The one row that replaced the three guidance cards.
 *
 * Only affordances a first-time user cannot guess, and only ones that are true
 * of every session: the two composer prefixes and the permission chord. Keys
 * are separate from the label so the view can set them in the mono stack
 * without parsing a sentence.
 */
export interface WelcomeHint {
  readonly keys: readonly string[]
  readonly label: string
}

export const WELCOME_HINTS: readonly WelcomeHint[] = [
  { keys: ['/'], label: '命令' },
  { keys: ['@'], label: '引用文件' },
  { keys: ['Shift', 'Tab'], label: '切换权限模式' },
]

export interface WelcomePill {
  readonly kind: WelcomePillKind
  readonly label: string
  readonly icon: 'folder' | 'branch'
  /**
   * Whether this pill is a control — it opens the switcher that hangs off it.
   * A pill with nowhere to go stays a `<span>`, because a button that does
   * nothing when clicked is a worse lie than plain text.
   */
  readonly interactive: boolean
}

export interface WelcomeState {
  /** A coordinator session has its own fixed welcome in the transcript instead of the Hero. */
  readonly coordinator?: boolean
  readonly transcript: TranscriptState
  /** From `hello.projectName`; undefined until the pane has started. */
  readonly projectName: string | undefined
  /** From `hello.projectIsGlobal`: the home-rooted workspace, not a project. */
  readonly global: boolean
  /**
   * From `hello.gitBranch` and then from every switch this pane performs;
   * undefined outside a repository or when detached.
   */
  readonly branch: string | undefined
  /** Whether this pane was given a way to switch branches. */
  readonly canSwitchBranch: boolean
  /**
   * The branch switcher. Held here rather than beside the welcome screen
   * because it *is* part of the empty state: it hangs off the branch pill, and
   * closing it is one of the things drawing a conversation does.
   */
  readonly branchPicker: BranchPickerState
  /**
   * The project switcher, held here for the reason `branchPicker` is: it hangs
   * off a pill of the empty state, so drawing a conversation closes it.
   *
   * Its rows come from `app.ts`'s session-history pull — the same list the
   * sidebar groups by — handed down through the pane, and its `current` is this
   * pane's own project root (`hello.projectRoot`), never a display name.
   */
  readonly projectPicker: ProjectPickerState
}

export interface WelcomeView {
  readonly visible: boolean
  readonly global: boolean
  readonly titleBefore: string
  readonly projectLabel: string
  readonly titleAfter: string
  readonly wordmark: string
  readonly hints: readonly WelcomeHint[]
  readonly pills: readonly WelcomePill[]
  readonly branchPicker: BranchPickerView
  readonly projectPicker: ProjectPickerView
}

/**
 * Which item kinds mean "a conversation has started".
 *
 * A keyed table rather than a list of exceptions, so adding a
 * `TranscriptItemKind` fails the build *by name* instead of silently defaulting
 * to one side. `notice` and `error` are false because a fresh draft already
 * carries startup notices — treating them as content would mean the welcome
 * screen never appeared at all, which is the bug this table exists to prevent.
 */
const COUNTS_AS_CONVERSATION = {
  user: true,
  assistant: true,
  thinking: true,
  tool: true,
  subagent: true,
  duration: true,
  'thread-notes': true,
  notice: false,
  error: false,
} as const satisfies Record<TranscriptItemKind, boolean>

/**
 * Nothing has been said yet.
 *
 * The two extra clauses are not redundant belt: a turn that has begun must never
 * leave the Hero on screen, and `tool-progress` / thinking can both be live
 * before any item lands.
 */
export function isTranscriptEmpty(state: TranscriptState): boolean {
  if (state.toolProgress !== undefined || state.isThinking) return false
  return !state.items.some((item) => COUNTS_AS_CONVERSATION[item.kind])
}

/** One paragraph of the coordinator welcome: plain text, or the clickable 「概览」 that opens the panel. */
export type CoordinatorWelcomeSegment = string | { readonly link: 'overview'; readonly label: string }

/**
 * The text fixed at the top of a coordinator session's transcript, whatever the
 * conversation holds. Pure interface: never a record, never sent to the model.
 * `opening` adds the line for a project that opened with a survey thread.
 */
export function coordinatorWelcome(input: { projectName: string | undefined; opening: boolean }): readonly (readonly CoordinatorWelcomeSegment[])[] {
  const place = input.projectName === undefined ? '这个项目' : `「${input.projectName}」`
  return [
    [`你好，欢迎来到${place}。我负责协调这里的工作：有任何需要尽管提，我会直接回答，或者开几个线程并行处理。`],
    ['线程会自己完成工作，你可以在', { link: 'overview', label: '概览' }, '里查看它们的状态。我会留意正在运行的内容，有任务完成或需要你处理时告诉你。'],
    ...(input.opening ? [['我先去了解一下这个项目，然后给你一些建议，马上回来。']] : []),
  ]
}

export function createWelcomeState(overrides: Partial<WelcomeState> = {}): WelcomeState {
  return {
    transcript: { items: [], generation: 0, toolProgress: undefined, isThinking: false, thinkingCount: 0 },
    projectName: undefined,
    global: false,
    branch: undefined,
    canSwitchBranch: false,
    branchPicker: createBranchPickerState(),
    projectPicker: createProjectPickerState(),
    ...overrides,
  }
}

export function welcomeView(state: WelcomeState): WelcomeView {
  // A control exactly when the popover has somewhere to go. True in the global
  // workspace too: 最近 is not a project, but the added projects are still where
  // a session started from here would belong, so the pill leads into them.
  const canSwitchProjects = canSwitchProject(state.projectPicker)
  const pills: WelcomePill[] = [
    state.global
      ? // The global workspace has no name worth drawing — where its records
        // land is the useful fact.
        {
          kind: 'project',
          label: WELCOME_GLOBAL_LOCATION,
          icon: 'folder',
          interactive: canSwitchProjects,
        }
      : {
          kind: 'project',
          label: state.projectName ?? WELCOME_PROJECT_FALLBACK,
          icon: 'folder',
          interactive: canSwitchProjects,
        },
  ]
  // Absent rather than hidden: a pill with nothing to say is not drawn, so the
  // view has no `hidden` state for `dom/` to interpret.
  if (state.branch !== undefined) {
    pills.push({
      kind: 'branch',
      label: state.branch,
      icon: 'branch',
      interactive: state.canSwitchBranch,
    })
  }

  const visible = state.coordinator !== true && isTranscriptEmpty(state.transcript)
  return {
    visible,
    global: state.global,
    // The global Hero drops the “在 X 中” segment — there is no X to name.
    titleBefore: state.global ? WELCOME_GLOBAL_TITLE : WELCOME_TITLE_BEFORE,
    projectLabel: state.global ? '' : state.projectName ?? WELCOME_PROJECT_FALLBACK,
    titleAfter: state.global ? '' : WELCOME_TITLE_AFTER,
    // Constants, carried on the view rather than reached for by `dom/`: the
    // renderer's rule is that the view layer decides nothing, and "which three
    // hints" is a decision even when it never changes.
    wordmark: WELCOME_WORDMARK,
    hints: WELCOME_HINTS,
    pills,
    // The popover hangs off the pills, so it cannot outlive them: a turn
    // starting takes the whole empty state off screen, and a picker left `open`
    // in the state would be drawn again the moment the conversation was cleared.
    branchPicker: branchPickerView(
      visible ? state.branchPicker : { ...state.branchPicker, open: false },
    ),
    // Forced shut off screen for the same reason, and also when the pill it
    // hangs off is not a control: a list with nothing but the current project in
    // it has no row anyone could pick.
    projectPicker: projectPickerView(
      visible && canSwitchProjects ? state.projectPicker : { ...state.projectPicker, open: false },
    ),
  }
}

/**
 * Everything the DOM depends on, in one string.
 *
 * Load-bearing rather than an optimisation: the view is rendered from
 * `paneSession`'s single transcript paint, which runs once per streamed token.
 * Without this guard every token would rebuild a heading and three pills. The
 * wordmark and the hint row are omitted because they are constant.
 */
export function welcomeRenderSignature(view: WelcomeView): string {
  return [
    view.visible ? '1' : '0',
    // Signed: the global Hero is different text, and an unsigned field here is
    // exactly the stale-paint bug this signature exists to prevent.
    view.global ? 'g' : 'p',
    view.projectLabel,
    ...view.pills.map((pill) => `${pill.kind}:${pill.interactive ? '1' : '0'}:${pill.label}`),
    // Signed, or the render guard swallows the click that opens the switcher —
    // the same failure an unsigned `menuOpen` is in `sidebarRenderSignature`.
    branchPickerSignature(view.branchPicker),
    projectPickerSignature(view.projectPicker),
  ].join(' ')
}
