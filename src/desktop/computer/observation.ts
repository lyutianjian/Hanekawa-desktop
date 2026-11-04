import type { ComputerNode } from './nativeSchema.js'

export interface ObservationBaseline { snapshotId: string; revision: number; nodes: ComputerNode[] }

/** Diffs compare data, never snapshot-prefixed strings. Every read gets new refs. */
export function renderObservation(snapshotId: string, revision: number, nodes: ComputerNode[], previous?: ObservationBaseline): { text: string; truncated: boolean; mode: 'full' | 'diff'; baseRevision: number | null } {
  const before = new Map(previous?.nodes.map(node => [node.identity, node]))
  const lines = [`snapshotId=${snapshotId}; revision=${revision}; refs are ${snapshotId}:e<index>. ${previous ? `Diff: baseRevision=${previous.revision}. Clear removed/from refs in that baseline before applying rows at new indices. Unchanged indices use this NEW snapshot prefix.` : 'Full AX tree.'}`]
  const rows: { line: string; depth: number }[] = []
  const add = (line: string, depth = 0) => rows.push({ line, depth })
  for (const node of nodes) {
    const old = before.get(node.identity)
    if (old && JSON.stringify(old) === JSON.stringify(node)) continue
    add(`${previous ? old ? '~ ' : '+ ' : ''}${'  '.repeat(node.depth)}${snapshotId}:e${node.index}${old && old.index !== node.index ? ` (from ${previous!.snapshotId}:e${old.index})` : ''} ${node.role} ${JSON.stringify(node.label)} value=${JSON.stringify(node.value)}${node.enabled ? '' : ' disabled'}${node.settable ? ' writable' : ''} actions=${JSON.stringify(node.actions)} writableAttributes=${JSON.stringify(node.writableAttributes)}${node.windowId ? ` windowId=${node.windowId}` : ''}${node.selectedTextRange ? ` selectedTextRange=${JSON.stringify(node.selectedTextRange)}` : ''}${node.bounds ? ` bounds=${JSON.stringify(node.bounds)}` : ''}`, node.depth)
  }
  if (previous) {
    const current = new Set(nodes.map(n => n.identity))
    for (const old of previous.nodes) if (!current.has(old.identity)) add(`- ${previous.snapshotId}:e${old.index}`)
    if (rows.length === 0) add('No AX tree changes.')
  }
  const truncated = lines[0]!.length + rows.reduce((sum, row) => sum + row.line.length + 1, 0) > 28_000
  const notice = 'Output truncated. Shallow nodes are prioritized; descendants may be omitted between rows. Read get_state with rootRef to inspect a subtree.'
  if (truncated) {
    let remaining = 28_000 - lines[0]!.length - notice.length - 1
    const selected = new Set<typeof rows[number]>()
    // Preserve branch entry refs before spending the budget on long lists.
    for (const row of [...rows].sort((a, b) => a.depth - b.depth)) {
      if (row.line.length + 1 > remaining) continue
      selected.add(row)
      remaining -= row.line.length + 1
    }
    for (const row of rows) if (selected.has(row)) lines.push(row.line)
    lines.push(notice)
  } else lines.push(...rows.map(row => row.line))
  return { text: lines.join('\n'), truncated, mode: previous ? 'diff' : 'full', baseRevision: previous?.revision ?? null }
}
