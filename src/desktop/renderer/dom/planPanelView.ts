import type { ExitDialogInput } from '../../../harness/planModeManager.js'
import { button } from './controls.js'
import { copyText } from './clipboard.js'
import { el, replace } from './dom.js'
import { markdownNode } from './markdownView.js'

/**
 * The side panel's 「计划」 tab: the whole plan the assistant proposed, as
 * markdown, with the plan file's path and a copy button underneath.
 *
 * Repainted only when the plan changes — the pane repaints on every stream
 * delta, and a plan rebuilt under the reader would drop their scroll position.
 */
export interface PlanPanelView {
  render(plan: ExitDialogInput | undefined): void
}

const COPIED_MS = 1500

export function createPlanPanelView(container: HTMLElement): PlanPanelView {
  let drawn: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    render(plan) {
      const key = plan === undefined ? '' : `${plan.planFilePath}\n${plan.planContent}`
      if (key === drawn) return
      drawn = key
      clearTimeout(timer)
      if (plan === undefined) {
        replace(container, el('div', 'plan-panel-empty', '还没有计划'))
        return
      }
      const empty = plan.planContent.trim().length === 0
      const copy = button('plan-panel-copy', '复制', '复制计划', () => {
        // The label follows the write: 「已复制」 for a copy that did not happen is worse than no label.
        void copyText(plan.planContent).then((ok) => {
          setLabel(ok ? '已复制' : '复制失败')
          clearTimeout(timer)
          timer = setTimeout(() => setLabel('复制'), COPIED_MS)
        })
      }, { icon: 'copy', enabled: !empty })
      const setLabel = (text: string): void => { copy.lastElementChild!.textContent = text }
      const path = el('span', 'plan-panel-path', plan.planFilePath)
      path.setAttribute('title', plan.planFilePath)
      replace(
        container,
        el('div', 'plan-panel-body', empty ? el('div', 'plan-panel-empty', '计划是空的') : markdownNode(plan.planContent, 'md plan-md')),
        el('div', 'plan-panel-foot', path, copy),
      )
    },
  }
}
