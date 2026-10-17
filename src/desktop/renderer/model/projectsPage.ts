import type { WireCoordinationThreads } from '../../shellProtocol.js'
import { coordinationCounts, formatLastActivity, isCoordinationProject } from './coordinationStatus.js'
import { coordinationCountsText, type SidebarProjectSessions } from './sidebar.js'

/**
 * The projects page: one card per coordination project. Pure, from the same
 * sidebar history and thread tables the pinned rows read, so the numbers agree.
 */

export const PROJECTS_PAGE_TITLE = '项目调度'
export const PROJECTS_NEW_LABEL = '新建调度'
export const PROJECTS_EMPTY_TITLE = '还没有项目调度'
export const PROJECTS_EMPTY_TEXT =
  '项目调度让一个协调者统领整个文件夹：你说需求，它直接回答或开出多个线程并行处理，进度都汇总在线程页里。'
/** The card's count line when no thread is running or waiting. */
export const PROJECT_IDLE_TEXT = '空闲'

export interface ProjectCard {
  readonly projectRoot: string
  readonly name: string
  readonly path: string
  readonly counts: string
  /** Empty when the project has no timestamp to show. */
  readonly lastActivity: string
}

/** The newest of the coordinator session's and every thread's activity, as epoch ms (0 for none). */
function activityOf(project: SidebarProjectSessions, table: WireCoordinationThreads): number {
  let latest = 0
  const take = (iso: string): void => {
    const at = Date.parse(iso)
    if (at > latest) latest = at
  }
  const coordinator = project.sessions.find((session) => session.id === table.coordinatorSessionId)
  if (coordinator) take(coordinator.updatedAt)
  for (const thread of table.threads) take(thread.lastActivityAt)
  return latest
}

/**
 * Coordination projects, newest activity first; ties keep registry order. The
 * global workspace never has one, and a project being removed is already gone.
 */
export function projectCards(
  projects: readonly SidebarProjectSessions[],
  coordination: ReadonlyMap<string, WireCoordinationThreads>,
  removing: ReadonlySet<string>,
  now: number,
): ProjectCard[] {
  const cards: Array<ProjectCard & { at: number }> = []
  for (const project of projects) {
    const table = coordination.get(project.projectRoot)
    if (project.isGlobal === true || removing.has(project.projectRoot) || !table || !isCoordinationProject(table)) continue
    const { running, blocked } = coordinationCounts(table.threads)
    const at = activityOf(project, table)
    cards.push({
      projectRoot: project.projectRoot,
      name: project.projectName,
      path: project.projectPath ?? project.projectRoot,
      counts: coordinationCountsText(running, blocked) || PROJECT_IDLE_TEXT,
      lastActivity: at === 0 ? '' : formatLastActivity(new Date(at).toISOString(), now),
      at,
    })
  }
  return cards.sort((a, b) => b.at - a.at).map(({ at: _at, ...card }) => card)
}
