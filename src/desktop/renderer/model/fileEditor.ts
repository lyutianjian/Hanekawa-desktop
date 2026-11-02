import type { WorkspaceFile, WorkspaceSaveResult } from '../../../runtime/protocol/workspaceFiles.js'

export type TextDocument = Extract<WorkspaceFile, { kind: 'text' }>
export type FileSaveState = 'clean' | 'dirty' | 'saving' | 'error' | 'conflict'
export const FILE_SAVE_LABELS: Record<FileSaveState, string> = { clean: '已保存', dirty: '有改动', saving: '正在保存…', error: '保存失败', conflict: '外部修改冲突' }

/** One buffer owns its save queue, even while a different session is visible. */
export class FileEditorBuffer {
  content: string
  base: TextDocument
  status: FileSaveState = 'clean'
  error = ''
  disk: WorkspaceFile | null | undefined
  composing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<boolean> | undefined
  private disposed = false
  private refreshing = 0

  constructor(file: TextDocument, private readonly save: (content: string, revision: string) => Promise<WorkspaceSaveResult>, private readonly changed: () => void, private readonly delay = 700) {
    this.content = file.content
    this.base = file
  }

  get dirty(): boolean { return this.content !== this.base.content }

  edit(content: string): void {
    this.content = content
    if (this.status !== 'conflict') this.status = this.saving ? 'saving' : this.dirty ? 'dirty' : 'clean'
    this.schedule()
    this.changed()
  }

  composition(active: boolean): void {
    this.composing = active
    if (active) clearTimeout(this.timer)
    else this.schedule()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.disposed || this.composing || !this.dirty || this.status === 'conflict' || this.saving) return
    this.timer = setTimeout(() => { void this.flush() }, this.delay)
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.saving) return this.saving
    if (this.disposed || this.status === 'conflict' || this.composing) return !this.dirty
    this.saving = this.drain()
    try { return await this.saving } finally { this.saving = undefined }
  }

  private async drain(): Promise<boolean> {
    while (this.dirty && !this.disposed && !this.composing) {
      const content = this.content
      this.status = 'saving'
      this.changed()
      try {
        const result = await this.save(content, this.base.revision)
        if (this.disposed) return false
        if (result.kind === 'conflict') {
          this.disk = result.disk
          this.status = 'conflict'
          this.changed()
          return false
        }
        this.base = { ...this.base, content, revision: result.revision }
        this.error = ''
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.status = 'error'
        this.changed()
        return false
      }
    }
    this.status = this.dirty ? 'dirty' : 'clean'
    this.changed()
    return !this.dirty
  }

  async refresh(read: () => Promise<WorkspaceFile>): Promise<void> {
    const generation = ++this.refreshing
    if (this.saving) await this.saving
    const base = this.base
    try {
      const disk = await read()
      if (this.disposed || generation !== this.refreshing || this.saving || base !== this.base) return
      if (disk.kind === 'text' && disk.revision === this.base.revision && this.status !== 'conflict') return
      if (!this.dirty && disk.kind === 'text') this.accept(disk)
      else { clearTimeout(this.timer); this.disk = disk; this.status = 'conflict'; this.changed() }
    } catch (error) {
      if (this.disposed || generation !== this.refreshing || this.saving || base !== this.base) return
      clearTimeout(this.timer)
      this.disk = null
      this.error = error instanceof Error ? error.message : String(error)
      this.status = 'conflict'
      this.changed()
    }
  }

  accept(file: TextDocument): void {
    clearTimeout(this.timer)
    this.base = file
    this.content = file.content
    this.disk = undefined
    this.error = ''
    this.status = 'clean'
    this.changed()
  }

  async overwrite(): Promise<boolean> {
    if (this.disk?.kind !== 'text') return false
    this.base = this.disk
    this.disk = undefined
    this.status = 'dirty'
    return this.flush()
  }

  dispose(): void { this.disposed = true; this.refreshing++; clearTimeout(this.timer) }
}

export function workspaceRelativeLink(file: string, href: string): string | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return undefined
  let decoded: string
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]!) } catch { return undefined }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\')) return undefined
  const parts = file.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (part === '..') { if (!parts.length) return undefined; parts.pop() }
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}
