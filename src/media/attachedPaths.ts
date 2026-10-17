/**
 * Files and folders dragged into the desktop composer travel as paths only: the
 * submission's text carries one `<attached-paths>` block after the user's words,
 * and the model reads them with its own tools. The renderer parses the block
 * back out to draw the tiles, and the session title leaves it out.
 */

export interface AttachedPath {
  readonly path: string
  readonly kind: 'file' | 'folder'
}

const BLOCK = /\n*<attached-paths>\n([\s\S]*?)\n<\/attached-paths>\s*$/
const LINE = /^(file|folder): (.+)$/

export function appendAttachedPaths(text: string, paths: readonly AttachedPath[]): string {
  if (paths.length === 0) return text
  const lines = paths.map((entry) => `${entry.kind}: ${entry.path}`).join('\n')
  const block = `<attached-paths>\n${lines}\n</attached-paths>`
  return text.length === 0 ? block : `${text}\n\n${block}`
}

/** The user's own words and the paths after them; text without a block comes back unchanged. */
export function splitAttachedPaths(text: string): { text: string; paths: AttachedPath[] } {
  const match = BLOCK.exec(text)
  if (!match) return { text, paths: [] }
  const paths: AttachedPath[] = []
  for (const line of match[1]!.split('\n')) {
    const parsed = LINE.exec(line)
    if (!parsed) return { text, paths: [] }
    paths.push({ kind: parsed[1] as AttachedPath['kind'], path: parsed[2]! })
  }
  return { text: text.slice(0, match.index), paths }
}

export function attachedPathName(entry: AttachedPath): string {
  return entry.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || entry.path
}

/** The tile's corner label: 文件夹, or the extension in capitals, or 文件. */
export function attachedPathBadge(entry: AttachedPath): string {
  if (entry.kind === 'folder') return '文件夹'
  const name = attachedPathName(entry)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '文件'
}
