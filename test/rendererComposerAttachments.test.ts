import assert from 'node:assert/strict'
import test from 'node:test'

import type { ImageAttachmentRef } from '../src/media/types.js'
import {
  attachmentDraftsFull,
  attachmentDraftsIncomplete,
  attachmentStripView,
  beginAttachmentImport,
  imagePasteSources,
  isImageFile,
  MAX_DRAFT_IMAGES,
  readyAttachmentRefs,
  removeAttachmentDraft,
  restoredAttachmentDrafts,
  retryAttachmentImport,
  settleAttachmentImport,
  draftImageSources,
  type AttachmentDrafts,
  type AttachmentImportSource,
} from '../src/desktop/renderer/model/composerAttachments.js'

/** A `path` source, the way the picker's answer arrives. */
function pathSource(path: string, name?: string): AttachmentImportSource {
  return { kind: 'path', path, ...(name !== undefined ? { name } : {}) }
}

function ref(id: string, name = `${id}.png`, width = 64, height = 48): ImageAttachmentRef {
  return { id, ownerSessionId: 'sess-1', name, mimeType: 'image/png', width, height, byteLength: 2_000 }
}

const IMPORT_OK = { ok: true as const, ref: ref('img-1') }
const IMPORT_FAIL = { ok: false as const, reason: 'decode-failed', message: 'not decodable' }

// --- the state machine -----------------------------------------------------------

test('import settles importing into ready, keeping arrival order', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/a.png'), 'd1')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/b.png'), 'd2')
  assert.equal(attachmentDraftsIncomplete(drafts), true)

  const settled = settleAttachmentImport(drafts, 'd2', { ok: true, ref: ref('img-b') })
  assert.ok(settled)
  assert.equal(settled.find((draft) => draft.draftId === 'd2')?.kind, 'ready')

  const done = settleAttachmentImport(settled!, 'd1', IMPORT_OK)
  assert.ok(done)
  assert.deepEqual(
    done.map((draft) => draft.kind),
    ['ready', 'ready'],
  )
  assert.equal(attachmentDraftsIncomplete(done!), false)
  assert.deepEqual(readyAttachmentRefs(done!), [ref('img-1'), ref('img-b')])
})

test('one failure leaves the other drafts intact, and the failed entry keeps its source', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/a.png'), 'd1')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/broken.png'), 'd2')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/c.png'), 'd3')

  const settled = settleAttachmentImport(drafts, 'd2', IMPORT_FAIL)
  assert.ok(settled)
  const failed = settled.find((draft) => draft.draftId === 'd2')
  assert.equal(failed?.kind, 'failed')
  if (failed?.kind === 'failed') {
    assert.equal(failed.reason, 'decode-failed')
    assert.equal(failed.message, 'not decodable')
    assert.deepEqual(failed.source, pathSource('C:/pics/broken.png'), 'the retry needs the source back')
  }
  assert.equal(attachmentDraftsIncomplete(settled!), true, 'a failed draft blocks a silent partial send')
})

test('retry moves a failed draft back to importing with its source reattached', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/broken.png'), 'd1')
  drafts = settleAttachmentImport(drafts, 'd1', IMPORT_FAIL)!

  const retrying = retryAttachmentImport(drafts, 'd1')
  assert.ok(retrying)
  const entry = retrying.find((draft) => draft.draftId === 'd1')
  assert.equal(entry?.kind, 'importing')
  if (entry?.kind === 'importing') {
    assert.deepEqual(entry.source, pathSource('C:/pics/broken.png'))
  }

  assert.equal(retryAttachmentImport(drafts, 'missing'), undefined)
})

test('settling an already-removed or unknown draft is a no-op answer, not an exception', () => {
  const drafts = beginAttachmentImport([], pathSource('C:/pics/a.png'), 'd1')
  assert.equal(settleAttachmentImport(drafts, 'gone', IMPORT_OK), undefined)

  const removed = removeAttachmentImporting()
  assert.equal(settleAttachmentImport(removed.drafts, 'd1', IMPORT_OK), undefined, 'removed mid-flight')

  function removeAttachmentImporting() {
    const { drafts: after } = removeAttachmentDraft(drafts, 'd1')
    return { drafts: after }
  }
})

test('removing a ready draft reports the image id it held; other entries keep their positions', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/a.png'), 'd1')
  drafts = settleAttachmentImport(drafts, 'd1', { ok: true, ref: ref('img-a') })!
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/b.png'), 'd2')

  const removed = removeAttachmentDraft(drafts, 'd1')
  assert.deepEqual(removed.drafts.map((draft) => draft.draftId), ['d2'])
  assert.equal(removed.releasedImageId, 'img-a', 'the caller needs the id for remove-attachment')

  const importing = removeAttachmentDraft(removed.drafts, 'd2')
  assert.equal(importing.releasedImageId, undefined, 'an importing draft holds nothing in the store')
})

test('the draft list stops at the per-input image quota', () => {
  let drafts: ReturnType<typeof restoredAttachmentDrafts> = []
  for (let index = 0; index < MAX_DRAFT_IMAGES; index += 1) {
    drafts = beginAttachmentImport(drafts, pathSource(`C:/pics/${index}.png`), `d${index}`)
  }
  assert.equal(attachmentDraftsFull(drafts), true)
  assert.equal(attachmentDraftsFull(drafts.slice(0, MAX_DRAFT_IMAGES - 1)), false)
})

test('restored drafts are ready with no source, so retry is unavailable but sending is', () => {
  const drafts = restoredAttachmentDrafts([ref('img-1', 'one.png'), ref('img-2', 'two.png')])
  assert.deepEqual(drafts.map((draft) => draft.kind), ['ready', 'ready'])
  assert.equal(attachmentDraftsIncomplete(drafts), false)
  assert.deepEqual(readyAttachmentRefs(drafts).map((image) => image.name), ['one.png', 'two.png'])
  assert.equal(retryAttachmentImport(drafts, 'restored-0'), undefined)
})

// --- the strip and the send gate -------------------------------------------------

test('the strip labels every state, animates nothing, and renumbers on removal', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/shot.png'), 'd1')
  drafts = settleAttachmentImport(drafts, 'd1', { ok: true, ref: ref('img-1', 'shot.png', 1920, 1080), animated: true })!
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/waiting.png'), 'd2')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/bad.png'), 'd3')
  drafts = settleAttachmentImport(drafts, 'd3', IMPORT_FAIL)!

  const view = attachmentStripView(drafts, { supportsImageInput: true })
  assert.deepEqual(view.rows.map((row) => row.state), ['ready', 'importing', 'failed'])
  assert.equal(view.rows[0]?.label, '图片 1：shot.png，1920×1080，动画首帧')
  assert.equal(view.rows[1]?.label, '图片 2：waiting.png')
  assert.equal(view.rows[1]?.detail, '导入中…')
  assert.equal(view.rows[2]?.label, '图片 3：bad.png')
  // The failed row names the reason class, keeps the store's facts, and ends
  // with that reason's exit (S24) — never just the bare facts.
  assert.match(view.rows[2]?.detail ?? '', /^失败：图片无法解码：not decodable /)
  assert.match(view.rows[2]?.detail ?? '', /换一张图片。$/)
  assert.equal(view.readyCount, 1)
  assert.match(view.sendBlockNote ?? '', /导入中或未成功/, 'pending or failed drafts block sending')

  const after = removeAttachmentDraft(drafts, 'd1').drafts
  const renumbered = attachmentStripView(after, { supportsImageInput: true })
  assert.equal(renumbered.rows[0]?.label, '图片 1：waiting.png')
})

test('a text-only model explains itself while drafts stay addable', () => {
  const drafts = restoredAttachmentDrafts([ref('img-1')])
  const view = attachmentStripView(drafts, { supportsImageInput: false })
  assert.match(view.sendBlockNote ?? '', /当前模型不支持图像输入/)
  assert.match(view.sendBlockNote ?? '', /模型芯片|\/model/, 'the way out names itself')
  assert.equal(view.readyCount, 1, 'adding, viewing and removing stay possible')

  const capable = attachmentStripView(drafts, { supportsImageInput: true })
  assert.equal(capable.sendBlockNote, undefined)
  // No snapshot yet: the host's submission gate (S15/S19) is the authority.
  const snapshotless = attachmentStripView(drafts, undefined)
  assert.equal(snapshotless.sendBlockNote, undefined)
})

test('a plain-text draft set against a text-only model has nothing to explain', () => {
  const view = attachmentStripView([], { supportsImageInput: false })
  assert.equal(view.rows.length, 0)
  assert.equal(view.sendBlockNote, undefined)
})

// --- the paste source ------------------------------------------------------------

test('only image files become paste sources; their bytes are copied out of the page', async () => {
  const png = new Uint8Array([1, 2, 3, 4])
  const files = [
    { name: 'shot.png', type: 'image/png', arrayBuffer: async () => png.buffer },
    { name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) },
    { name: 'blob', type: '', arrayBuffer: async () => new ArrayBuffer(0) },
  ]
  assert.deepEqual(isImageFile(files[1]!), false)

  const sources = await imagePasteSources(files)
  assert.deepEqual(sources, [{ kind: 'bytes', name: 'shot.png', bytes: png }])
})

// --- the thumbnail wiring on the strip view (S12) ---------------------------------

test('a ready row carries its image id and the cached thumbnail URL, or neither', () => {
  const drafts: AttachmentDrafts = [{ kind: 'ready', draftId: 'd1', ref: ref('img-1') }]

  const cold = attachmentStripView(drafts, { supportsImageInput: true })
  assert.equal(cold.rows[0]!.imageId, 'img-1')
  assert.equal(cold.rows[0]!.thumbUrl, undefined, 'no URL until the on-demand load settles')

  const warm = attachmentStripView(drafts, { supportsImageInput: true }, (id) =>
    id === 'img-1' ? 'data:image/png;base64,AA' : undefined)
  assert.equal(warm.rows[0]!.thumbUrl, 'data:image/png;base64,AA')

  // Importing and failed rows never claim an id: there is no attachment to preview.
  const mixed: AttachmentDrafts = [
    drafts[0]!,
    { kind: 'importing', draftId: 'd2', name: 'w.png', source: { kind: 'path', path: 'w.png' } },
    { kind: 'failed', draftId: 'd3', name: 'bad.png', source: { kind: 'path', path: 'bad.png' }, reason: 'decode-failed', message: 'nope' },
  ]
  const rows = attachmentStripView(mixed, { supportsImageInput: true }).rows
  assert.deepEqual(rows.map((row) => row.imageId), ['img-1', undefined, undefined])
})

test('every draft with a source can be imported again elsewhere, ready ones included', () => {
  let drafts = beginAttachmentImport([], pathSource('C:/pics/a.png'), 'd1')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/b.png'), 'd2')
  drafts = beginAttachmentImport(drafts, pathSource('C:/pics/c.png'), 'd3')
  drafts = settleAttachmentImport(drafts, 'd1', { ok: true, ref: ref('img-1') })!
  drafts = settleAttachmentImport(drafts, 'd2', { ok: false, reason: 'decode-failed', message: 'x' })!
  drafts = [...drafts, ...restoredAttachmentDrafts([ref('img-r')])]
  assert.deepEqual(draftImageSources(drafts), [
    pathSource('C:/pics/a.png'),
    pathSource('C:/pics/b.png'),
    pathSource('C:/pics/c.png'),
  ])
})
