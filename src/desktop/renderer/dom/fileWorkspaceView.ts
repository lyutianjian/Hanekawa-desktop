import { FileTree } from '@pierre/trees'
import type { SessionClient } from '../../../runtime/protocol/client.js'
import type { WorkspaceEntry } from '../../../runtime/protocol/workspaceFiles.js'
import { workspaceRelativeLink } from '../model/fileEditor.js'
import { FileEditorView } from './fileEditorView.js'
import { createFilePreview, imageDataUrl } from './filePreviewView.js'
import { el, replace } from './dom.js'
import { button } from './controls.js'

interface FileTab {
  path: string
  element: HTMLElement
  editor?: FileEditorView
  revision?: string
  dispose(): void
}

export interface FileWorkspaceBinding { client: SessionClient; sessionId: string; label: string }

export class FileWorkspace {
  readonly element = el('div', 'file-workspace')
  readonly tabs = new Map<string, FileTab>()
  private readonly tabBar = el('div', 'file-tabs')
  private readonly breadcrumb = el('div', 'file-breadcrumb')
  private readonly content = el('div', 'file-content')
  private readonly notice = el('div', 'file-notice')
  private readonly treeHost = el('div', 'file-tree')
  private readonly filter = el('input', 'file-filter')
  private readonly scopeLabel = el('span', 'file-filter-scope')
  private readonly entries = new Map<string, WorkspaceEntry[]>()
  private readonly loading = new Set<string>()
  private readonly tree: FileTree
  private readonly off: () => void
  private readonly resize: ResizeObserver
  private selected: string | undefined
  private searchRoot = ''
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private searchSequence = 0
  private opening = 0
  private disposed = false
  private refreshing = false
  private refreshAgain = false
  private hidden = false
  private pathsSignature = ''

  constructor(readonly binding: FileWorkspaceBinding, private readonly report: (error: unknown) => void) {
    const header = el('div', 'file-explorer-header', el('span', 'file-explorer-title', '文件'))
    const browser = el('div', 'file-tree-column')
    const body = el('div', 'file-workspace-body')
    const left = el('div', 'file-document-column', this.tabBar, this.breadcrumb, this.content)
    const divider = el('div', 'file-tree-resizer')
    const toggle = button('file-button', '目录', '显示或隐藏文件目录', () => this.element.classList.toggle('file-tree-hidden'))
    let narrow = false
    this.resize = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return
      const next = entry.contentRect.width < 400
      if (next !== narrow) { narrow = next; this.element.classList.toggle('file-tree-hidden', narrow) }
    })
    this.resize.observe(this.element)
    header.append(toggle, button('file-button', '刷新', '重新读取文件与目录', () => { void this.refresh() }))
    this.filter.placeholder = '筛选文件…'
    this.filter.setAttribute('aria-label', '按文件名或相对路径筛选')
    this.filter.addEventListener('input', (event) => { if (!(event as InputEvent).isComposing) this.queueSearch() })
    this.filter.addEventListener('compositionend', () => this.queueSearch())
    this.filter.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.filter.value = ''; this.queueSearch(); this.treeHost.focus() }
    })
    this.scopeLabel.textContent = '筛选跳过依赖与构建目录'
    const scope = button('file-button', '整个目录', '切回工作目录内筛选', () => { this.searchRoot = ''; this.scopeLabel.textContent = '筛选跳过依赖与构建目录'; this.queueSearch() })
    browser.append(this.filter, el('div', 'file-filter-tools', this.scopeLabel, scope), this.treeHost)
    this.treeHost.tabIndex = -1
    this.tree = new FileTree({ paths: [], initialExpansion: 'closed', flattenEmptyDirectories: false, density: 'compact',
      onSelectionChange: (paths) => {
        const path = paths.at(-1)
        if (!path) return
        if (path.endsWith('/')) {
          const directory = path.slice(0, -1)
          this.searchRoot = directory
          this.scopeLabel.textContent = `筛选范围：${directory}`
          void this.loadDirectory(directory).then(() => { const item = this.tree.getItem(path); if (item && 'expand' in item) item.expand() }).catch(this.report)
        } else void this.open(path)
      },
    })
    this.tree.render({ containerWrapper: this.treeHost })
    this.tree.subscribe(() => {
      if (this.disposed || this.filter.value.trim()) return
      const focused = this.tree.getFocusedItem()
      if (focused?.isDirectory()) {
        const directory = focused.getPath().replace(/\/$/, '')
        if (!this.entries.has(directory) && !this.loading.has(directory)) void this.loadDirectory(directory).catch(this.report)
      }
    })
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-orientation', 'vertical')
    divider.setAttribute('aria-label', '调整文件目录宽度')
    divider.tabIndex = 0
    let width = 190
    try { width = Math.max(160, Math.min(320, Number(localStorage.getItem('hanekawa.fileTreeWidth.v1')) || 190)) } catch {}
    const setWidth = (value: number) => { width = Math.max(160, Math.min(320, value)); this.element.style.setProperty('--file-tree-width', `${width}px`); divider.setAttribute('aria-valuenow', String(width)) }
    setWidth(width)
    let startX = 0, startWidth = width
    divider.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; startX = event.clientX; startWidth = width; divider.setPointerCapture(event.pointerId); event.preventDefault() })
    divider.addEventListener('pointermove', (event) => { if (divider.hasPointerCapture(event.pointerId)) setWidth(startWidth + startX - event.clientX) })
    const remember = () => { try { localStorage.setItem('hanekawa.fileTreeWidth.v1', String(width)) } catch {} }
    divider.addEventListener('pointerup', (event) => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); remember() })
    divider.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(width + (event.key === 'ArrowLeft' ? 10 : -10)); remember() } })
    body.append(left, divider, browser)
    this.element.append(header, this.notice, body)
    this.element.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.flush() }
      // The tree has its own Shadow DOM keymap; editor shortcuts must not reach the chat.
      event.stopPropagation()
    })
    this.off = binding.client.onWorkspaceFilesChanged((sessionId, change) => {
      if (sessionId !== binding.sessionId) return
      if (change.error) this.showNotice(change.error)
      void this.refresh(change.paths)
    })
    binding.client.setFileGuard(() => this.guard())
    this.paintTabs()
    void this.loadDirectory('').catch((error) => this.showNotice(String(error)))
  }

  private showNotice(text: string): void { this.notice.textContent = text; this.notice.hidden = !text }

  private async loadDirectory(directory: string, force = false): Promise<void> {
    if (this.disposed || this.loading.has(directory) || (!force && this.entries.has(directory))) return
    this.loading.add(directory)
    if (!this.entries.size) this.showNotice('正在读取目录…')
    try {
      let offset: number | undefined = 0
      const entries: WorkspaceEntry[] = []
      do {
        const page = await this.binding.client.listWorkspaceFiles(this.binding.sessionId, directory, offset)
        if (this.disposed) return
        entries.push(...page.entries)
        offset = page.nextOffset
        this.entries.set(directory, [...entries])
        this.paintTree()
      } while (offset !== undefined)
      const directories = new Set(entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path))
      for (const cached of this.entries.keys()) {
        if (cached === directory || (directory && !cached.startsWith(directory + '/'))) continue
        const child = directory ? directory + '/' + cached.slice(directory.length + 1).split('/')[0] : cached.split('/')[0]!
        if (!directories.has(child)) this.entries.delete(cached)
      }
      this.paintTree()
      this.showNotice(entries.length || directory ? '' : '目录为空')
      this.updateWatch()
    } finally { this.loading.delete(directory) }
  }

  private paintTree(): void {
    if (this.filter.value.trim()) return
    const paths = [...this.entries.values()].flat().map((entry) => entry.path + (entry.kind === 'directory' ? '/' : ''))
    const signature = paths.join('\0')
    if (signature === this.pathsSignature) return
    this.pathsSignature = signature
    const expanded = paths.filter((path) => { const item = this.tree.getItem(path); return item && 'isExpanded' in item && item.isExpanded() })
    this.tree.resetPaths(paths, { initialExpandedPaths: expanded })
  }

  private queueSearch(): void {
    const sequence = ++this.searchSequence
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => { void this.search(sequence) }, 150)
  }

  private async search(sequence: number): Promise<void> {
    try {
      const query = this.filter.value.trim()
      const result = await this.binding.client.searchWorkspaceFiles(this.binding.sessionId, this.searchRoot, query)
      if (this.disposed || sequence !== this.searchSequence || result.cancelled) return
      if (!query) { this.pathsSignature = ''; this.paintTree(); this.showNotice(''); return }
      const paths = result.entries.map((entry) => entry.path + (entry.kind === 'directory' ? '/' : ''))
      this.tree.resetPaths(paths, { initialExpandedPaths: paths.flatMap((path) => path.split('/').slice(0, -1).map((_, i) => path.split('/').slice(0, i + 1).join('/') + '/')) })
      this.showNotice(result.truncated ? '显示前 500 个匹配，请缩小筛选范围' : paths.length ? '' : '没有匹配的文件')
    } catch (error) { if (sequence === this.searchSequence) this.showNotice(String(error)) }
  }

  async open(path: string): Promise<void> {
    const sequence = ++this.opening
    if (this.selected !== path) void this.tabs.get(this.selected ?? '')?.editor?.buffer.flush()
    if (!this.tabs.has(path)) {
      this.showNotice('正在打开文件…')
      try {
        const file = await this.binding.client.readWorkspaceFile(this.binding.sessionId, path)
        if (this.disposed || sequence !== this.opening) return
        if (file.kind === 'text') {
          const editor = new FileEditorView(file,
            (content, revision) => this.binding.client.saveWorkspaceFile(this.binding.sessionId, path, content, revision),
            () => { this.paintTabLabels() },
            (node) => this.decorateMarkdown(node, path))
          this.tabs.set(path, { path, element: editor.element, editor, dispose: () => editor.dispose() })
        } else {
          const preview = createFilePreview(file, (kind, name) => this.binding.client.readPdfResource(this.binding.sessionId, kind, name))
          this.tabs.set(path, { path, ...preview, revision: 'revision' in file ? file.revision : undefined })
        }
        this.showNotice('')
      } catch (error) { if (!this.disposed && sequence === this.opening) this.showNotice(String(error)); return }
    }
    this.selected = path
    this.paintTabs()
    this.updateWatch()
  }

  private decorateMarkdown(node: HTMLElement, path: string): void {
    for (const anchor of node.querySelectorAll<HTMLAnchorElement>('a')) {
      const href = anchor.getAttribute('href') ?? ''
      const target = workspaceRelativeLink(path, href)
      if (target) { anchor.removeAttribute('target'); anchor.addEventListener('click', (event) => { event.preventDefault(); void this.open(target) }) }
      else if (!/^(https?:|mailto:)/i.test(href)) { anchor.removeAttribute('href') }
    }
    for (const placeholder of node.querySelectorAll<HTMLElement>('[data-file-image]')) {
      const target = workspaceRelativeLink(path, placeholder.dataset.fileImage ?? '')
      if (!target) continue
      void this.binding.client.readWorkspaceFile(this.binding.sessionId, target).then(async (file) => {
        if (file.kind !== 'image') return
        const src = await imageDataUrl(file.bytes, file.mime)
        if (this.disposed || !node.contains(placeholder)) return
        const image = el('img'); image.alt = placeholder.textContent ?? ''; image.src = src; placeholder.replaceChildren(image)
      }).catch(() => { placeholder.title = '本地图片无法读取' })
    }
  }

  private paintTabs(): void {
    replace(this.tabBar)
    for (const tab of this.tabs.values()) {
      const item = el('div', `file-tab${this.selected === tab.path ? ' selected' : ''}`)
      item.dataset.path = tab.path
      item.append(button('file-tab-select', tab.path.split('/').at(-1)!, tab.path, () => { void this.open(tab.path) }),
        el('span', 'file-tab-dirty', '•'),
        button('file-tab-close', '', `关闭 ${tab.path}`, () => { void this.closeTab(tab.path) }, { icon: 'close' }))
      this.tabBar.append(item)
      tab.element.hidden = tab.path !== this.selected
      if (tab.element.parentNode !== this.content) this.content.append(tab.element)
    }
    this.paintTabLabels()
    replace(this.breadcrumb, el('span', 'file-current-path', `${this.binding.label}${this.selected ? ` / ${this.selected}` : ''}`))
    if (this.selected) {
      const path = this.selected
      this.breadcrumb.append(button('file-button', '外部打开', '使用系统应用打开此文件', () => { void this.binding.client.openWorkspaceFile(this.binding.sessionId, path).catch(this.report) }))
    }
    this.content.querySelector('.file-empty-selection')?.remove()
    if (!this.tabs.size) this.content.append(el('div', 'file-empty file-empty-selection', '从右侧目录树选择文件'))
    this.tabs.get(this.selected ?? '')?.editor?.focus()
  }

  private paintTabLabels(): void {
    for (const item of this.tabBar.querySelectorAll<HTMLElement>('.file-tab')) {
      const tab = this.tabs.get(item.dataset.path ?? '')
      if (tab) item.classList.toggle('unsaved', tab.editor?.buffer.dirty === true || tab.editor?.buffer.status === 'conflict')
    }
  }

  private async closeTab(path: string): Promise<void> {
    const tab = this.tabs.get(path)
    if (!tab) return
    if (tab.editor && !await tab.editor.buffer.flush() && !window.confirm(`${path} 尚未保存。放弃这些修改并关闭？`)) return
    tab.dispose(); this.tabs.delete(path)
    if (this.selected === path) this.selected = [...this.tabs.keys()].at(-1)
    this.paintTabs(); this.updateWatch()
  }

  private updateWatch(): void {
    const paths = new Set(this.hidden ? [] : this.entries.keys())
    for (const path of this.tabs.keys()) paths.add(path.split('/').slice(0, -1).join('/'))
    void this.binding.client.watchWorkspaceFiles(this.binding.sessionId, [...paths].slice(0, 128)).then((result) => { if (result.error) this.showNotice(result.error) }).catch((error) => { if (!this.disposed) this.showNotice(String(error)) })
  }

  async refresh(paths?: string[]): Promise<void> {
    if (this.disposed) return
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = true
    try {
      if (!this.hidden) for (const directory of paths ?? this.entries.keys()) if (this.entries.has(directory)) await this.loadDirectory(directory, true).catch((error) => this.showNotice(String(error)))
      await Promise.all([...this.tabs.values()].map(async (tab) => {
        const read = () => this.binding.client.readWorkspaceFile(this.binding.sessionId, tab.path)
        if (tab.editor) return tab.editor.refresh(read)
        try {
          const file = await read()
          if (this.disposed || this.tabs.get(tab.path) !== tab || file.kind === 'text') return
          if ('revision' in file && file.revision === tab.revision) return
          const preview = createFilePreview(file, (kind, name) => this.binding.client.readPdfResource(this.binding.sessionId, kind, name))
          preview.element.hidden = tab.path !== this.selected
          tab.element.replaceWith(preview.element)
          tab.dispose()
          this.tabs.set(tab.path, { path: tab.path, ...preview, revision: 'revision' in file ? file.revision : undefined })
        } catch (error) { if (!this.disposed) this.showNotice(`${tab.path}：${String(error)}`) }
      }))
    } finally {
      this.refreshing = false
      if (this.refreshAgain) { this.refreshAgain = false; void this.refresh() }
    }
  }

  async flush(): Promise<boolean> { return (await Promise.all([...this.tabs.values()].map((tab) => tab.editor?.buffer.flush() ?? true))).every(Boolean) }

  async guard(): Promise<boolean> {
    if (await this.flush()) return true
    if (!window.confirm('仍有文件未保存或存在外部修改冲突。放弃未保存的修改并继续？')) return false
    for (const tab of this.tabs.values()) if (tab.editor) tab.editor.buffer.accept(tab.editor.buffer.base)
    return true
  }

  hasPending(): boolean { return [...this.tabs.values()].some((tab) => tab.editor && (tab.editor.buffer.dirty || tab.editor.buffer.status === 'conflict')) }
  setVisible(visible: boolean): void { this.hidden = !visible; if (!visible) void this.flush(); else void this.refresh(); this.updateWatch() }
  dispose(): void { this.disposed = true; this.off(); this.resize.disconnect(); this.binding.client.setFileGuard(undefined); clearTimeout(this.searchTimer); this.tree.cleanUp(); for (const tab of this.tabs.values()) tab.dispose(); this.tabs.clear(); this.element.remove() }
}

