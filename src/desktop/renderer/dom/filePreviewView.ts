import type { RenderTask } from 'pdfjs-dist/build/pdf.mjs'
import type { PdfResourceKind, WorkspaceFile } from '../../../runtime/protocol/workspaceFiles.js'
import { el, replace } from './dom.js'
import { button } from './controls.js'

export function imageDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mime }))
  })
}

export function createFilePreview(file: Exclude<WorkspaceFile, { kind: 'text' }>, readResource: (kind: PdfResourceKind, name: string) => Promise<Uint8Array>): { element: HTMLElement; dispose(): void } {
  const element = el('div', 'file-preview')
  const controls = el('div', 'file-preview-controls')
  const stage = el('div', 'file-preview-stage')
  element.append(controls, stage)
  let disposed = false
  let cleanup = () => {}
  if (file.kind === 'unsupported') stage.append(el('p', 'file-empty', file.reason))
  else if (file.kind === 'image') {
    const img = el('img', 'file-preview-image')
    img.alt = file.path
    let scale = 1
    const apply = () => { img.style.setProperty('--file-preview-width', `${Math.round(scale * 100)}%`); img.style.setProperty('--file-preview-max-width', 'none') }
    controls.append(
      button('file-button', '适应宽度', '适应宽度', () => { img.style.setProperty('--file-preview-width', 'auto'); img.style.setProperty('--file-preview-max-width', '100%'); scale = 1 }),
      button('file-button', '原始尺寸', '原始尺寸', () => { img.style.setProperty('--file-preview-width', `${img.naturalWidth}px`); img.style.setProperty('--file-preview-max-width', 'none') }),
      button('file-button', '缩小', '缩小', () => { scale = Math.max(0.1, scale / 1.25); apply() }),
      button('file-button', '放大', '放大', () => { scale = Math.min(8, scale * 1.25); apply() }))
    img.addEventListener('error', () => replace(stage, el('p', 'file-empty', '图片格式损坏或无法解码')))
    stage.append(img)
    void imageDataUrl(file.bytes, file.mime).then((url) => { if (!disposed) img.src = url }).catch((error) => { if (!disposed) replace(stage, el('p', 'file-empty', String(error))) })
  } else {
    void (async () => {
      const { getDocument, PDFWorker } = await import('pdfjs-dist/build/pdf.mjs')
      if (disposed) return
      const canvas = el('canvas')
      stage.append(canvas)
      const pageLabel = el('span')
      const worker = new Worker(new URL('./pdf.worker.mjs', location.href), { type: 'module' })
      const pdfWorker = PDFWorker.create({ port: worker })
      class BinaryDataFactory {
        fetch({ kind, filename }: { kind: PdfResourceKind; filename: string }): Promise<Uint8Array> { return readResource(kind, filename) }
      }
      const loading = getDocument({ data: file.bytes.slice(), worker: pdfWorker, BinaryDataFactory, useWorkerFetch: false, useWasm: false, maxImageSize: 40_000_000 })
      loading.onPassword = () => { replace(stage, el('p', 'file-empty', '此 PDF 需要密码，请在外部应用打开')); void loading.destroy() }
      let render: RenderTask | undefined
      let pageNumber = 1
      let zoom = 1
      let fit = true
      let revision = 0
      cleanup = () => { revision++; render?.cancel(); void loading.destroy(); pdfWorker.destroy(); worker.terminate() }
      void loading.promise.then((pdf) => {
        if (disposed) return
        async function paint(): Promise<void> {
          const own = ++revision
          render?.cancel()
          await render?.promise.catch(() => {})
          if (disposed || own !== revision) return
          const page = await pdf.getPage(pageNumber)
          if (disposed || own !== revision) return
          const original = page.getViewport({ scale: 1 })
          const width = Math.max(200, stage.clientWidth - 32)
          const scale = fit ? Math.min(3, width / original.width) : zoom
          zoom = scale
          const viewport = page.getViewport({ scale })
          const ratio = Math.min(2, window.devicePixelRatio || 1)
          canvas.width = Math.ceil(viewport.width * ratio)
          canvas.height = Math.ceil(viewport.height * ratio)
          canvas.style.setProperty('--file-pdf-width', `${viewport.width}px`)
          canvas.style.setProperty('--file-pdf-height', `${viewport.height}px`)
          pageLabel.textContent = `${pageNumber} / ${pdf.numPages} · ${Math.round(scale * 100)}%`
          render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
          try { await render.promise } catch (error) { if (!disposed && own === revision && (error as Error).name !== 'RenderingCancelledException') replace(stage, el('p', 'file-empty', String(error))) }
        }
        const draw = () => { void paint().catch((error) => { if (!disposed) replace(stage, el('p', 'file-empty', String(error))) }) }
        controls.append(button('file-button', '上一页', '上一页', () => { pageNumber = Math.max(1, pageNumber - 1); draw() }), pageLabel,
          button('file-button', '下一页', '下一页', () => { pageNumber = Math.min(pdf.numPages, pageNumber + 1); draw() }),
          button('file-button', '适应宽度', '适应宽度', () => { fit = true; draw() }),
          button('file-button', '缩小', '缩小', () => { fit = false; zoom = Math.max(0.25, zoom / 1.25); draw() }),
          button('file-button', '放大', '放大', () => { fit = false; zoom = Math.min(3, zoom * 1.25); draw() }))
        const observer = new ResizeObserver(() => { if (fit) draw() })
        observer.observe(stage)
        const release = cleanup
        cleanup = () => { observer.disconnect(); release() }
        draw()
      }).catch((error) => { if (!disposed) replace(stage, el('p', 'file-empty', `PDF 无法预览：${(error as Error).message}`)) })
    })().catch((error) => { if (!disposed) replace(stage, el('p', 'file-empty', `PDF 无法预览：${String(error)}`)) })
  }
  return { element, dispose: () => { disposed = true; cleanup(); element.remove() } }
}
