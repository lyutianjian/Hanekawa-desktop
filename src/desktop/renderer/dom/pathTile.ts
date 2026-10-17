import { attachedPathBadge, type AttachedPath } from '../../../media/attachedPaths.js'
import { el } from './dom.js'

/** What fits the tile's five lines; a longer path keeps its tail, where the name is. */
const SHOWN_PATH_CHARS = 72

/** A dropped file or folder: its path, and 文件夹 or the extension in the corner. */
export function pathTileNode(entry: AttachedPath): HTMLElement {
  const shown = entry.path.length > SHOWN_PATH_CHARS ? `…\u2060${entry.path.slice(1 - SHOWN_PATH_CHARS)}` : entry.path
  const tile = el('div', 'path-tile',
    el('span', 'path-tile-path', shown),
    el('span', 'path-tile-badge', attachedPathBadge(entry)))
  tile.setAttribute('role', 'listitem')
  tile.setAttribute('title', entry.path)
  return tile
}
