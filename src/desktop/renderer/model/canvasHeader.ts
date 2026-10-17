import type { WireLaneInfo } from '../../shellProtocol.js'
import type { ThreadTone } from './coordinationStatus.js'

/**
 * The canvas header bar (`design_guidance.md` 三.1).
 *
 * Session identity on the left — folder icon, title, a `⋯` menu — and "open in
 * editor" on the right. The two items the document puts beside it (split view,
 * right inspector) have no backend and are omitted, per the stage-5 decision
 * table.
 *
 * Derived entirely from `WireLaneInfo`, which already carries the session id,
 * its title, and the project the lane belongs to — and which the host
 * re-broadcasts on a rename (`sessionTitle` is a lane field). So the header is a
 * *window*-level view like the sidebar: it never reaches into a `PaneSession`,
 * and `paneSession.ts` needs no new dependency for it.
 *
 * Pure, DOM-free, and therefore unit-tested directly; `dom/canvasHeaderView.ts`
 * only turns this into nodes.
 */

export interface CanvasHeaderMenuItem {
  readonly id: 'rename' | 'delete' | 'confirm-delete' | 'cancel-delete'
  readonly label: string
  /** Destructive items are drawn in the danger colour and read out as such. */
  readonly danger?: boolean
}

/**
 * The thread crumb that replaces the title on a thread session: 「← 协调 · 线程名 [状态] [停止]」.
 * The caller has already labelled the status, so this only carries what to draw.
 */
export interface CanvasHeaderBreadcrumb {
  readonly backLabel: string
  readonly threadTitle: string
  readonly statusLabel: string
  readonly tone: ThreadTone
  /** The 停止 button is offered only while a stop would apply. */
  readonly canStop: boolean
}

export interface CanvasHeaderThread {
  readonly title: string
  readonly statusLabel: string
  readonly tone: ThreadTone
  readonly canStop: boolean
}

export interface CanvasHeaderView {
  /**
   * False when no lane is active, and false while the active pane is still a
   * draft: an empty window and a fresh session both draw no header at all.
   */
  readonly visible: boolean
  readonly title: string
  /** The project the session belongs to, for the "open in editor" button's name. */
  readonly projectName: string
  readonly projectRoot: string
  readonly sessionId: string
  readonly menuOpen: boolean
  readonly menuItems: readonly CanvasHeaderMenuItem[]
  /** True while the title is being edited; the header swaps the label for an input. */
  readonly renaming: boolean
  readonly openLocationLabel: string
  readonly openLocationTitle: string
  /** Present on a thread session; replaces the title while not renaming. */
  readonly breadcrumb: CanvasHeaderBreadcrumb | undefined
}

/** The same fallback the sidebar rows use, so one session has one name. */
export const UNTITLED_SESSION = '未命名会话'

const EMPTY: CanvasHeaderView = {
  visible: false,
  title: '',
  projectName: '',
  projectRoot: '',
  sessionId: '',
  menuOpen: false,
  menuItems: [],
  renaming: false,
  openLocationLabel: '',
  openLocationTitle: '',
  breadcrumb: undefined,
}

export function canvasHeaderView(input: {
  lane: WireLaneInfo | undefined
  menuOpen: boolean
  renaming: boolean
  /**
   * The session the menu is asking about, not a boolean: the header is redrawn
   * from whichever lane is active, and a bare flag would carry a pending
   * confirmation onto the next session the user switched to.
   */
  pendingDelete: string | undefined
  /**
   * Whether the pane has a conversation yet.
   *
   * A draft has nothing this bar can say: its title is the placeholder, and
   * rename/delete are about a session that is not on disk in any meaningful
   * sense. Drawing the row anyway cost 34px above a welcome screen that already
   * names the project — the same "a label for the absence of news" the status
   * line was cured of. It appears with the first message, which
   * `onFirstContent` already repaints on.
   */
  hasConversation: boolean
  /** The session's coordination role, when it belongs to a project's coordination. */
  role?: 'coordinator' | 'thread'
  /** The thread this session runs, already labelled by the caller. Used only with `role: 'thread'`. */
  thread?: CanvasHeaderThread
}): CanvasHeaderView {
  const { lane } = input
  if (!lane || !input.hasConversation) return EMPTY

  const confirming = input.pendingDelete !== undefined && input.pendingDelete === lane.sessionId
  // Two steps in the menu itself rather than deferring to the sidebar's own
  // confirmation: the row may be filtered out by the search box or scrolled out
  // of view, and a delete that asks somewhere the user is not looking reads as
  // nothing having happened.
  const menuItems: CanvasHeaderMenuItem[] = confirming
    ? [
        { id: 'confirm-delete', label: '确认删除', danger: true },
        { id: 'cancel-delete', label: '取消' },
      ]
    : [
        { id: 'rename', label: '重命名' },
        { id: 'delete', label: '删除会话', danger: true },
      ]

  return {
    visible: true,
    title: lane.sessionTitle ?? UNTITLED_SESSION,
    projectName: lane.projectName,
    projectRoot: lane.projectRoot,
    sessionId: lane.sessionId,
    // A menu cannot be open while the title is being edited: both want the same
    // keystrokes, and Escape has to mean one thing.
    menuOpen: input.menuOpen && !input.renaming,
    menuItems,
    renaming: input.renaming,
    // Names the editor it hands off to: 「打开位置」 read as "show in Finder".
    openLocationLabel: 'VS Code',
    openLocationTitle: `在 VS Code 中打开 ${lane.projectName}`,
    breadcrumb: input.role === 'thread' && input.thread
      ? {
          backLabel: '← 协调',
          threadTitle: input.thread.title,
          statusLabel: input.thread.statusLabel,
          tone: input.thread.tone,
          canStop: input.thread.canStop,
        }
      : undefined,
  }
}

/**
 * What a committed rename should send, or `undefined` when it is a no-op.
 *
 * Trimmed, and an unchanged or empty title is *not* sent: `rename-session`
 * writes the index and broadcasts to every lane, and blurring the input without
 * typing must not cost that.
 */
export function renameCommit(current: string, next: string): string | undefined {
  const trimmed = next.trim()
  if (trimmed.length === 0 || trimmed === current) return undefined
  return trimmed
}
