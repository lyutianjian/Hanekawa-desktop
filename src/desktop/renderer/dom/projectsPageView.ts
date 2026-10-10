/**
 * The projects page: a card per coordination project, filling the canvas.
 *
 * Rebuilt only when the model output changed (the signature below); it
 * repaints on every coordination push, and a card rebuilt under the pointer
 * would swallow the click on its way.
 */

import {
  PROJECTS_EMPTY_TEXT,
  PROJECTS_EMPTY_TITLE,
  PROJECTS_NEW_LABEL,
  PROJECTS_PAGE_TITLE,
  type ProjectCard,
} from '../model/projectsPage.js'
import { CREATE_BLOCKED_HINT } from '../model/sidebar.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'

export interface ProjectsPageDom {
  render(cards: readonly ProjectCard[], error: string | undefined, canCreate: boolean): void
}

export interface ProjectsPageHandlers {
  onOpen(projectRoot: string): void
  onNew(): void
}

export function createProjectsPageView(root: HTMLElement, handlers: ProjectsPageHandlers): ProjectsPageDom {
  let drawn: string | undefined

  const newButton = (canCreate: boolean): HTMLButtonElement =>
    button('projects-new', PROJECTS_NEW_LABEL, canCreate ? '选择一个文件夹作为新项目' : CREATE_BLOCKED_HINT, () => handlers.onNew(), {
      icon: 'plus',
      enabled: canCreate,
    })

  function card(item: ProjectCard): HTMLElement {
    const node = el(
      'button',
      'project-card',
      el('span', 'project-card-name', item.name),
      el('span', 'project-card-path', item.path),
      el('span', 'project-card-meta', el('span', 'project-card-counts', item.counts), el('span', 'project-card-time', item.lastActivity)),
    )
    node.type = 'button'
    node.title = `打开 ${item.name} 的协调会话`
    node.addEventListener('click', () => handlers.onOpen(item.projectRoot))
    return node
  }

  return {
    render(cards, error, canCreate) {
      const signature = JSON.stringify([cards, error, canCreate])
      if (signature === drawn) return
      drawn = signature
      replace(
        root,
        el('div', 'projects-page',
          el('div', 'projects-head', el('h2', 'projects-title', PROJECTS_PAGE_TITLE), newButton(canCreate)),
          error === undefined ? undefined : el('div', 'projects-error', error),
          cards.length === 0
            ? el('div', 'projects-empty', el('p', 'projects-empty-title', PROJECTS_EMPTY_TITLE), el('p', 'projects-empty-text', PROJECTS_EMPTY_TEXT), newButton(canCreate))
            : el('div', 'projects-list', ...cards.map(card)),
        ),
      )
    },
  }
}
