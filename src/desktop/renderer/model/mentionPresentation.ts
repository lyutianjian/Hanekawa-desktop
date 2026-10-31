import type { FileSuggestion } from '../../../runtime/suggestions/atToken.js'

export type MentionIcon = 'folder' | 'file' | 'message-circle' | 'file-code' | 'file-image' | 'file-text' | 'JS' | 'TS'
export interface MentionPresentation {
  name: string
  detail: string
  icon: MentionIcon
  title: string
  accessibleName: string
}

export function mentionPresentation(suggestion: FileSuggestion): MentionPresentation {
  const { path, kind } = suggestion.metadata
  if (kind === 'session') {
    const detail = suggestion.metadata.projectName ?? ''
    return { name: suggestion.displayText, detail, icon: 'message-circle', title: `${suggestion.displayText} · ${detail}`, accessibleName: `会话 ${suggestion.displayText} ${detail}` }
  }
  const normalized = path.replace(/\/$/, '')
  const split = normalized.lastIndexOf('/')
  const name = normalized.slice(split + 1)
  const parent = split < 0 ? '.' : normalized.slice(0, split)
  const detail = kind === 'directory' && parent === '.' ? '' : parent
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const icon: MentionIcon = kind === 'directory' ? 'folder'
    : /^(js|jsx|mjs|cjs)$/.test(ext) ? 'JS'
      : /^(ts|tsx|mts|cts)$/.test(ext) ? 'TS'
        : /^(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/.test(ext) ? 'file-image'
          : /^(md|mdx|txt|text|rst|log)$/.test(ext) ? 'file-text'
            : /^(py|rs|go|c|h|cpp|hpp|java|kt|swift|sh|bash|zsh|json|yaml|yml|toml|html|css|vue|svelte|sql|xml|rb|php)$/.test(ext) ? 'file-code' : 'file'
  return { name, detail, icon, title: path, accessibleName: `${kind === 'directory' ? '文件夹' : '文件'} ${name} ${detail}` }
}
