import { completionRows, type CompletionState } from '../model/completion.js'
import { el, replace } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The completion dropdown, for both slash commands and `@` file mentions.
 *
 * Split out of `composerView.ts` in 4e. Both completion sources reduce to the
 * same two fields before they get here, which is the whole reason this file
 * never had to learn what a file mention is.
 */

export interface SuggestionsView {
  render(state: CompletionState): void
}

/** A row was picked with the mouse; the index is its slot in `completionRows`. */
export type SuggestionSelect = (index: number) => void

/**
 * `field` is the text field the list completes. It is told which option is
 * the current one (`aria-activedescendant`), because focus never leaves it: the
 * arrows move a highlight, not focus, and without this a screen reader heard
 * nothing as the highlight moved.
 */
export function createSuggestionsView(
  container: HTMLElement,
  onSelect: SuggestionSelect,
  field?: HTMLElement,
): SuggestionsView {
  // The rows as last painted. Arrowing changes only the highlight, so a list
  // whose rows read the same keeps its nodes and moves two classes, instead
  // of rebuilding every row per key press.
  let painted: { signature: string; nodes: HTMLElement[] } | undefined
  const presence = createPresence(container, {
    onClosed: () => {
      replace(container)
      painted = undefined
    },
  })
  const point = (id: string | undefined): void => {
    if (!field) return
    if (id === undefined) field.removeAttribute('aria-activedescendant')
    else field.setAttribute('aria-activedescendant', id)
  }
  const highlight = (nodes: readonly HTMLElement[], selectedIndex: number): HTMLElement | undefined => {
    nodes.forEach((node, index) => {
      node.classList.toggle('selected', index === selectedIndex)
      node.setAttribute('aria-selected', String(index === selectedIndex))
    })
    return nodes[selectedIndex]
  }
  return {
    render(state) {
      const rows = completionRows(state)
      if (rows.length === 0) {
        point(undefined)
        painted = undefined
        presence.set(false)
        return
      }
      const selectedIndex = state.kind === 'none' ? -1 : state.selectedIndex
      const signature = JSON.stringify(rows.map((row) => [row.displayText, row.description ?? '']))
      if (painted?.signature === signature) {
        const selected = highlight(painted.nodes, selectedIndex)
        point(selected?.id)
        selected?.scrollIntoView({ block: 'nearest' })
        return
      }
      let selected: HTMLElement | undefined
      const nodes = rows.map((row, index) => {
        const node = el('div', `suggestion${index === selectedIndex ? ' selected' : ''}`)
        node.id = `suggestion-${index}`
        if (index === selectedIndex) selected = node
        node.setAttribute('role', 'option')
        node.setAttribute('aria-selected', String(index === selectedIndex))
        node.appendChild(el('span', 'name', row.displayText))
        node.appendChild(el('span', 'description', row.description ?? ''))
        // `mousedown` with the default prevented, not `click`: accepting a
        // suggestion splices over the `@…` token *at the caret*, and the browser's
        // default mousedown would take focus — and the caret — off the textarea
        // before the handler ever ran.
        node.addEventListener('mousedown', (event) => {
          event.preventDefault()
          onSelect(index)
        })
        return node
      })
      replace(container, ...nodes)
      painted = { signature, nodes }
      presence.set(true)
      point(selected?.id)
      // The list scrolls inside a fixed height; arrowing past its edge used to
      // move the highlight out of sight. `nearest` scrolls only when it must.
      selected?.scrollIntoView({ block: 'nearest' })
    },
  }
}
