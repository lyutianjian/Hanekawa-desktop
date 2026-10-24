import { el, type Child } from './dom.js'
import { highlightShell } from '../model/syntax.js'

/** Shell source as text and `.syn-*` spans; plain text when it cannot be highlighted. */
export function shellNodes(code: string): Child[] {
  const runs = highlightShell(code)
  if (runs === undefined) return [code]
  return runs.map((run) => run.kind === undefined ? run.text : el('span', `syn-${run.kind}`, run.text))
}
