import path from 'node:path'
import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { applyLineEndings, decodeTextBuffer, writeTextFile } from '../../tools/textFile.js'
import type { PdfResourceKind, WorkspaceEntry, WorkspaceFile, WorkspaceFilesChanged, WorkspaceListing, WorkspaceSaveResult, WorkspaceSearchResult } from '../../runtime/protocol/workspaceFiles.js'

export const TEXT_LIMIT = 5 * 1024 * 1024
export const PREVIEW_LIMIT = 50 * 1024 * 1024
const PAGE_SIZE = 1000
const SEARCH_LIMIT = 500
const SKIP_SEARCH = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'vendor'])
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const relativePath = (value: string): string => value.split(path.sep).join('/')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function editable(bytes: Buffer): boolean {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
  return (utf16 ? bytes.length % 2 === 0 : isUtf8(bytes)) && !decodeTextBuffer(bytes).content.includes('\0')
}

async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('请选择普通文件')
    if (info.size > limit) throw new Error('文件超过预览大小限制，请在外部应用打开')
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > limit || offset > info.size) throw new Error('读取期间文件大小发生变化，请重试')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

/** A session-owned filesystem view. It never reads the renderer's idea of a root. */
export class WorkspaceFiles {
  private watchers = new Map<string, FSWatcher>()
  private watchGeneration = 0
  private searchGeneration = 0
  private changed = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly cwd: string, private readonly onChange: (event: WorkspaceFilesChanged) => void = () => {}) {}

  async resolve(relative: string): Promise<string> {
    if (this.disposed) throw new Error('文件会话已关闭')
    if (path.isAbsolute(relative) || relative.includes('\0') || relative.includes('\\')) throw new Error('需要工作目录内的相对路径')
    const root = await realpath(this.cwd)
    const candidate = path.resolve(root, relative || '.')
    if (!inside(root, candidate)) throw new Error('路径超出当前工作目录')
    const target = await realpath(candidate)
    if (!inside(root, target)) throw new Error('符号链接指向工作目录外，不能在这里打开')
    return target
  }

  async list(relative = '', offset = 0): Promise<WorkspaceListing> {
    const directory = await this.resolve(relative)
    const entries = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry): Promise<WorkspaceEntry> => {
      const item: WorkspaceEntry = { name: entry.name, path: relativePath(path.posix.join(relative, entry.name)), kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file' }
      if (entry.isSymbolicLink()) {
        try { if ((await stat(await this.resolve(item.path))).isDirectory()) item.kind = 'directory' } catch { /* An outside or broken link remains visible but cannot be entered. */ }
      }
      return item
    }))
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const end = offset + PAGE_SIZE
    return { entries: entries.slice(offset, end), ...(end < entries.length ? { nextOffset: end } : {}) }
  }

  async search(relative: string, query: string): Promise<WorkspaceSearchResult> {
    const generation = ++this.searchGeneration
    const result: WorkspaceSearchResult = { entries: [], truncated: false, cancelled: false }
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return result
    const start = await this.resolve(relative)
    const queue = [{ absolute: start, relative }]
    while (queue.length > 0) {
      if (generation !== this.searchGeneration || this.disposed) return { ...result, cancelled: true }
      const next = queue.shift()!
      let entries
      try { entries = await readdir(next.absolute, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (generation !== this.searchGeneration || this.disposed) return { ...result, cancelled: true }
        const file = path.posix.join(next.relative, entry.name)
        if (file.toLocaleLowerCase().includes(needle)) {
          result.entries.push({ name: entry.name, path: file, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file' })
          if (result.entries.length === SEARCH_LIMIT) return { ...result, truncated: true }
        }
        if (entry.isDirectory() && !SKIP_SEARCH.has(entry.name)) queue.push({ absolute: path.join(next.absolute, entry.name), relative: file })
      }
    }
    return result
  }

  async read(relative: string): Promise<WorkspaceFile> {
    const target = await this.resolve(relative)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('请选择文件；符号链接目录请从实际目录打开')
    const extension = path.extname(relative).toLowerCase()
    const mime = IMAGES[extension]
    const media = mime !== undefined || extension === '.pdf'
    if (info.size > (media ? PREVIEW_LIMIT : TEXT_LIMIT)) return { kind: 'unsupported', path: relative, size: info.size, reason: '文件超过预览大小限制，请在外部应用打开' }
    const bytes = await boundedRead(target, media ? PREVIEW_LIMIT : TEXT_LIMIT)
    const revision = digest(bytes)
    if (media) return { kind: mime ? 'image' : 'pdf', mime: mime ?? 'application/pdf', path: relative, size: bytes.length, revision, bytes: new Uint8Array(bytes) }
    if (!editable(bytes)) return { kind: 'unsupported', path: relative, size: bytes.length, reason: '二进制或暂不支持的文本编码，请在外部应用打开' }
    return { kind: 'text', path: relative, size: bytes.length, revision, content: decodeTextBuffer(bytes).content }
  }

  async save(relative: string, content: string, expectedRevision: string): Promise<WorkspaceSaveResult> {
    let target: string
    let bytes: Buffer
    try { target = await this.resolve(relative); bytes = await boundedRead(target, TEXT_LIMIT) }
    catch (error) { if (missing(error)) return { kind: 'conflict', disk: null }; throw error }
    if (digest(bytes) !== expectedRevision) return { kind: 'conflict', disk: await this.read(relative) }
    if (!editable(bytes)) throw new Error('此文件不是可编辑文本')
    const file = decodeTextBuffer(bytes)
    const encoded = Buffer.from((file.bom ? '\uFEFF' : '') + applyLineEndings(content, file.lineEndings), file.encoding)
    if (encoded.length > TEXT_LIMIT) throw new Error('编辑内容超过 5 MiB 限制')
    await writeTextFile(target, content, file)
    return { kind: 'saved', revision: digest(encoded) }
  }

  async setWatch(paths: string[]): Promise<{ error?: string }> {
    const generation = ++this.watchGeneration
    const wanted = new Set(paths.slice(0, 128))
    for (const [key, watcher] of this.watchers) if (!wanted.has(key)) { watcher.close(); this.watchers.delete(key) }
    const failures: string[] = []
    for (const relative of wanted) {
      if (this.watchers.has(relative)) continue
      try {
        const target = await this.resolve(relative)
        if (generation !== this.watchGeneration || this.disposed) return {}
        const watcher = watch(target, () => this.notify(relative))
        watcher.on('error', () => { watcher.close(); this.watchers.delete(relative); this.onChange({ paths: [relative], error: '目录监听中断，可点击刷新重试' }) })
        this.watchers.set(relative, watcher)
      } catch { failures.push(relative || '/') }
    }
    return failures.length ? { error: `部分目录无法监听，可手动刷新：${failures.join('、')}` } : {}
  }

  private notify(relative: string): void {
    this.changed.add(relative)
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; const paths = [...this.changed]; this.changed.clear(); if (!this.disposed) this.onChange({ paths }) }, 150)
  }

  dispose(): void {
    this.disposed = true
    this.searchGeneration++
    this.watchGeneration++
    clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}

/** Only bundled PDF assets, never a renderer-supplied filesystem path. */
export async function readPdfResource(kind: PdfResourceKind, name: string): Promise<Uint8Array> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '..') throw new Error('无效的 PDF 资源名称')
  const folder = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind]
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  return new Uint8Array(await boundedRead(path.join(root, folder, name), 4 * 1024 * 1024))
}
