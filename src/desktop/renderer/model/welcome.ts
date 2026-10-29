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
 * The empty-state home page, as data.
 *
 * Drawn in place of a conversation when there is nothing to read yet: a title,
 * the usage card (`dom/usageCardView.ts`, which owns its own state), and above
 * the composer a strip of context pills naming the project and the branch. Both
 * pills are controls when their switcher has somewhere to go, with the same
 * popover shell (`model/projectPicker.ts`, `model/branchPicker.ts`).
 * `dom/welcomeView.ts` builds the nodes; every decision — above all *whether it
 * shows at all* — is here, where it can be tested without a DOM.
 */

export type WelcomePillKind = 'project' | 'branch'

export const WELCOME_TITLE = '接下来做什么？'
/** Shown until `hello` answers; the name is unknown for a frame or two. */
export const WELCOME_PROJECT_FALLBACK = '当前项目'

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
  readonly title: string
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
  receipt: true,
  'turn-failure': true,
  compaction: true,
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

/** One paragraph of the coordinator welcome: plain text, the clickable 「线程」 that opens the panel, or 「读取项目」. */
export type CoordinatorWelcomeSegment = string | { readonly link: 'overview' | 'survey'; readonly label: string }

/**
 * The survey line of the coordinator welcome: `offer` while the project has no
 * thread and the conversation is empty, `started` once the survey thread exists.
 */
export type CoordinatorSurvey = 'offer' | 'started' | undefined

/**
 * The text fixed at the top of a coordinator session's transcript, whatever the
 * conversation holds. Pure interface: never a record, never sent to the model.
 * `survey` adds the 「读取项目」 offer, or the line saying the survey went to look.
 */
export function coordinatorWelcome(input: { projectName: string | undefined; survey: CoordinatorSurvey }): readonly (readonly CoordinatorWelcomeSegment[])[] {
  const place = input.projectName === undefined ? '这个项目' : `「${input.projectName}」`
  return [
    [`你好，欢迎来到${place}。我负责协调这里的工作：有任何需要尽管提，我会直接回答，或者开几个线程并行处理。`],
    ['线程会自己完成工作，你可以在', { link: 'overview', label: '线程' }, '页里查看它们的状态。我会留意正在运行的内容，有任务完成或需要你处理时告诉你。'],
    ...(input.survey === 'offer'
      ? [['想让我先熟悉这个项目，可以点', { link: 'survey', label: '读取项目' } as const, '，我会派一个线程去读文档、目录和最近的提交，然后给你几条建议。']]
      : input.survey === 'started' ? [['我先去了解一下这个项目，然后给你一些建议，马上回来。']] : []),
  ]
}

/**
 * Which survey line the coordinator welcome carries. `table` is the project's
 * thread table, `undefined` until the first pull lands; `pending` covers the
 * click until the table shows the survey thread.
 */
export function coordinatorSurvey(input: {
  table: { readonly openingThreadId?: string; readonly threads: readonly unknown[] } | undefined
  transcript: TranscriptState
  pending: boolean
}): CoordinatorSurvey {
  if (input.table?.openingThreadId !== undefined) return 'started'
  if (!input.table || input.table.threads.length > 0 || input.pending || !isTranscriptEmpty(input.transcript)) return undefined
  return 'offer'
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
  const canSwitchProjects = !state.global && canSwitchProject(state.projectPicker)
  const pills: WelcomePill[] = state.global ? [] : [{
    kind: 'project',
    label: state.projectName ?? WELCOME_PROJECT_FALLBACK,
    icon: 'folder',
    interactive: canSwitchProjects,
  }]
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
    title: WELCOME_TITLE,
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
 * Without this guard every token would rebuild the pills.
 */
export function welcomeRenderSignature(view: WelcomeView): string {
  return [
    view.visible ? '1' : '0',
    ...view.pills.map((pill) => `${pill.kind}:${pill.interactive ? '1' : '0'}:${pill.label}`),
    // Signed, or the render guard swallows the click that opens the switcher —
    // the same failure an unsigned `menuOpen` is in `sidebarRenderSignature`.
    branchPickerSignature(view.branchPicker),
    projectPickerSignature(view.projectPicker),
  ].join(' ')
}
