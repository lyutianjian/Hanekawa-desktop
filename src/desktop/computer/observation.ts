import type { ComputerNode } from './nativeSchema.js'

/** Diffs compare data, never snapshot-prefixed strings. Every read gets new refs. */
export function renderObservation(snapshotId: string, nodes: ComputerNode[], previous?: ComputerNode[]): { text: string; truncated: boolean } {
  const before = new Map(previous?.map(node => [node.index, node]))
  const lines = [`snapshotId=${snapshotId}; refs are ${snapshotId}:e<index>. ${previous ? 'Diff: unchanged indices use this NEW snapshot prefix.' : 'Full AX tree.'}`]
  let size = lines[0]!.length
  let truncated = false
  const add = (line: string) => { if (size + line.length > 28_000) { truncated = true; return }; lines.push(line); size += line.length + 1 }
  for (const node of nodes) {
    const old = before.get(node.index)
    if (old && JSON.stringify(old) === JSON.stringify(node)) continue
    add(`${previous ? old ? '~ ' : '+ ' : ''}${'  '.repeat(node.depth)}${snapshotId}:e${node.index} ${node.role} ${JSON.stringify(node.label)} value=${JSON.stringify(node.value)}${node.enabled ? '' : ' disabled'}${node.settable ? ' writable' : ''} actions=${JSON.stringify(node.actions)}${node.bounds ? ` bounds=${JSON.stringify(node.bounds)}` : ''}`)
  }
  if (previous) {
    const current = new Set(nodes.map(n => n.index))
    for (const old of previous) if (!current.has(old.index)) add(`- e${old.index}`)
    if (lines.length === 1) add('No AX tree changes.')
  }
  if (truncated) lines.push('Output truncated. Read get_state with rootRef to inspect a subtree, or disableDiffing:true for a full read.')
  return { text: lines.join('\n'), truncated }
}
