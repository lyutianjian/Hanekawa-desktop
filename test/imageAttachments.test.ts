import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  IMAGE_PROCESSING_VERSION,
  ImageAttachmentService,
  attachmentsDirFor,
  sessionAttachmentsDir,
} from '../src/services/imageAttachments/imageAttachmentService.js'
import type { StoredAttachment } from '../src/services/imageAttachments/imageAttachmentService.js'
import { loadFixtureBytes } from './helpers/imageFixtures.js'
import { getProjectDataDir } from '../src/utils/paths.js'

/**
 * S05: the session attachment store. Every test works on its own scratch
 * project so `<cwd>/.hanekawa` really is the store root — the same shape the
 * runtime will hand the service.
 */
let project = ''

function makeService(retentionWindowMs = 60_000): ImageAttachmentService {
  return new ImageAttachmentService(project, { retentionWindowMs })
}

async function importOk(
  service: ImageAttachmentService,
  sessionId: string,
  name: string,
  bytes?: Buffer,
): Promise<StoredAttachment> {
  const result = await service.importImage(sessionId, bytes ?? (await loadFixtureBytes(name)), name)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ok && result.value.ref.ownerSessionId, sessionId)
  return result.ok ? result.value : (undefined as never)
}

function imageDir(sessionId: string, imageId: string): string {
  return path.join(getProjectDataDir(project), 'attachments', sessionId, imageId)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

describe('ImageAttachmentService', () => {
  beforeEach(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-imgstore-'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('lays out the documented files before returning a ref', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'transparent.png')

    const dir = imageDir('session-a', stored.ref.id)
    assert.equal(stored.ref.mimeType, 'image/png')
    assert.equal(stored.ref.width, 64)
    assert.equal(stored.ref.height, 64)
    assert.equal(stored.ref.byteLength, (await stat(path.join(dir, 'image.png'))).size)
    for (const file of ['original.png', 'image.png', 'thumbnail.png', 'metadata.json']) {
      assert.equal(await exists(path.join(dir, file)), true, `${file} should exist`)
    }

    const resolved = await service.resolveRef(stored.ref)
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.value.ref.id, stored.ref.id)
    assert.equal(resolved.value.metadata.originalMimeType, 'image/png')
    assert.equal(resolved.value.metadata.originalWidth, 64)
    assert.equal(resolved.value.metadata.originalHeight, 64)
    assert.equal(resolved.value.metadata.sentWidth, 64)
    assert.equal(resolved.value.metadata.sentHeight, 64)
    assert.equal(resolved.value.metadata.processingVersion, IMAGE_PROCESSING_VERSION)
    assert.match(resolved.value.metadata.checksum, /^[0-9a-f]{64}$/)
    assert.equal(resolved.value.metadata.localPath, path.join(dir, 'original.png'))
    assert.equal(resolved.value.animated, false)
  })

  it('keeps EXIF facts in metadata and applies orientation to the send version', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'exif-orientation.jpg')

    assert.equal(stored.ref.width, 48)
    assert.equal(stored.ref.height, 64)
    const resolved = await service.resolveRef(stored.ref)
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.value.metadata.originalWidth, 64)
    assert.equal(resolved.value.metadata.originalHeight, 48)
    assert.equal(resolved.value.metadata.exifOrientation, 6)
    assert.equal(await exists(path.join(imageDir('session-a', stored.ref.id), 'original.jpeg')), true)
  })

  it('stores animated sources as first-frame send versions', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'animated.gif')

    assert.equal(stored.animated, true)
    assert.equal(stored.ref.mimeType, 'image/png')
    assert.equal(await exists(path.join(imageDir('session-a', stored.ref.id), 'original.gif')), true)
  })

  it('trusts content sniffing over the arrival file name', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'png-named-jpg.jpg')

    assert.equal(stored.ref.mimeType, 'image/png')
    const resolved = await service.resolveRef(stored.ref)
    assert.equal(resolved.ok && resolved.value.metadata.originalMimeType, 'image/png')
    assert.equal(await exists(path.join(imageDir('session-a', stored.ref.id), 'original.png')), true)
  })

  it('dedups identical content per session, not across sessions', async () => {
    const service = makeService()
    const bytes = await loadFixtureBytes('transparent.png')
    const first = await importOk(service, 'session-a', 'transparent.png', bytes)
    const again = await importOk(service, 'session-a', 'renamed.png', bytes)
    const other = await importOk(service, 'session-b', 'transparent.png', bytes)

    assert.equal(again.ref.id, first.ref.id)
    assert.notEqual(other.ref.id, first.ref.id)
  })

  it('passes processing failures through with their input reasons', async () => {
    const service = makeService()
    const corrupt = await service.importImage(
      'session-a',
      await loadFixtureBytes('corrupt.png'),
      'corrupt.png',
    )
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.ok === false && corrupt.reason, 'decode-failed')

    // A minimal BMP header: recognized, but outside the supported set.
    const bmp = Buffer.from([0x42, 0x4d, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])
    const unsupported = await service.importImage('session-a', bmp, 'flag.bmp')
    assert.equal(unsupported.ok, false)
    assert.equal(unsupported.ok === false && unsupported.reason, 'unsupported-format')
  })

  it('returns store-write-failed and no usable ref when the disk rejects the write', async () => {
    // A regular file where the data dir should be: every mkdir below it fails.
    await mkdir(path.dirname(getProjectDataDir(project)), { recursive: true })
    await writeFile(getProjectDataDir(project), 'not a directory')
    const service = makeService()
    const result = await service.importImage(
      'session-a',
      await loadFixtureBytes('transparent.png'),
      'transparent.png',
    )
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, 'store-write-failed')
  })

  it('keeps working after the source file is deleted', async () => {
    const source = path.join(project, 'source.png')
    await writeFile(source, await loadFixtureBytes('transparent.png'))
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'source.png', await readFile(source))
    await rm(source, { force: true })

    const send = await service.readSendBytes(stored.ref)
    assert.equal(send.ok, true)
    const preview = await service.previewDataUrl(stored.ref)
    assert.equal(preview.ok, true)
  })

  it('rebuilds a deleted send version from the immutable original', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'exif-orientation.jpg')
    const sendPath = path.join(imageDir('session-a', stored.ref.id), 'image.png')
    await unlink(sendPath)

    const rebuilt = await service.readSendBytes(stored.ref)
    assert.equal(rebuilt.ok, true)
    if (!rebuilt.ok) return
    assert.equal(rebuilt.value.mimeType, stored.ref.mimeType)
    assert.equal(rebuilt.value.bytes.byteLength, stored.ref.byteLength)
    const meta = await sharp(rebuilt.value.bytes).metadata()
    assert.equal(meta.width, stored.ref.width)
    assert.equal(meta.height, stored.ref.height)
    assert.equal(await exists(sendPath), true, 'rebuilt send version should be back on disk')
  })

  it('reports missing files as per-image errors without sinking the session', async () => {
    const service = makeService()
    const a = await importOk(service, 'session-a', 'transparent.png')
    const b = await importOk(service, 'session-a', 'static.webp')

    // Send version and original both gone: only that image errors.
    const dirA = imageDir('session-a', a.ref.id)
    await unlink(path.join(dirA, 'image.png'))
    await unlink(path.join(dirA, 'original.png'))
    const sendA = await service.readSendBytes(a.ref)
    assert.equal(sendA.ok, false)
    assert.equal(sendA.ok === false && sendA.reason, 'file-missing')
    assert.equal((await service.resolveRef(a.ref)).ok, true, 'metadata still resolves')
    assert.equal((await service.readSendBytes(b.ref)).ok, true)

    // A damaged registration breaks exactly its own image.
    await writeFile(path.join(imageDir('session-a', b.ref.id), 'metadata.json'), '{ not json')
    assert.equal((await service.resolveRef(b.ref)).ok, false)
    assert.equal((await service.readSendBytes(a.ref)).ok, false)
  })

  it('rejects unsafe ids as lookup errors, never as path reads', async () => {
    const service = makeService()
    for (const lookup of [
      { ownerSessionId: '../..', id: 'x' },
      { ownerSessionId: 'session-a', id: '..\\..\\config' },
      { ownerSessionId: 'session-a', id: '.' },
    ]) {
      assert.equal((await service.resolveRef(lookup)).ok, false)
      assert.equal((await service.readSendBytes(lookup)).ok, false)
      assert.equal((await service.previewDataUrl(lookup)).ok, false)
    }
  })

  it('does not resolve another session\'s attachment ids', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'transparent.png')
    const cross = await service.resolveRef({ ownerSessionId: 'session-b', id: stored.ref.id })
    assert.equal(cross.ok, false)
    assert.equal(cross.ok === false && cross.reason, 'file-missing')
  })

  it('serves a capped thumbnail data URL and regenerates a missing thumbnail', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'transparent.png')

    const preview = await service.previewDataUrl(stored.ref)
    assert.equal(preview.ok, true)
    if (!preview.ok) return
    assert.ok(preview.value.startsWith('data:image/png;base64,'))
    assert.ok(preview.value.length <= 300_000)
    const bytes = Buffer.from(preview.value.slice('data:image/png;base64,'.length), 'base64')
    const meta = await sharp(bytes).metadata()
    assert.equal(meta.format, 'png')

    const thumbnailPath = path.join(imageDir('session-a', stored.ref.id), 'thumbnail.png')
    await unlink(thumbnailPath)
    const again = await service.previewDataUrl(stored.ref)
    assert.equal(again.ok, true)
    assert.equal(await exists(thumbnailPath), true, 'thumbnail should be regenerated')
  })

  it('serves a screen-sized view data URL without caching it on disk', async () => {
    const service = makeService()
    const stored = await importOk(service, 'session-a', 'transparent.png')

    const view = await service.viewDataUrl(stored.ref)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.ok(view.value.startsWith('data:image/png;base64,'))
    const bytes = Buffer.from(view.value.slice('data:image/png;base64,'.length), 'base64')
    const meta = await sharp(bytes).metadata()
    assert.equal(meta.format, 'png')
    // Never enlarged: a small original comes back at its own size, and the
    // viewer's zoom is what magnifies it.
    assert.equal(meta.width, stored.ref.width)
    assert.equal(meta.height, stored.ref.height)

    // Rendered per call, so nothing new appears beside the two versions and the
    // thumbnail the store does keep.
    const entries = await readdir(imageDir('session-a', stored.ref.id))
    assert.equal(entries.includes('view.png'), false)

    // Unregistered and unsafe ids fail the way every other lookup here does.
    assert.equal((await service.viewDataUrl({ ownerSessionId: 'session-b', id: stored.ref.id })).ok, false)
    assert.equal((await service.viewDataUrl({ ownerSessionId: 'session-a', id: '..\\..\\config' })).ok, false)
  })

  describe('collection', () => {
    it('keeps unreferenced attachments inside the retention window', async () => {
      const service = makeService(60_000)
      const stored = await importOk(service, 'session-a', 'transparent.png')

      const fresh = await service.collectGarbage('session-a', [], { now: Date.now() })
      assert.equal(fresh.ok, true)
      assert.deepEqual(fresh.ok && fresh.value.removedImageIds, [])
      assert.equal(await exists(imageDir('session-a', stored.ref.id)), true)
    })

    it('collects unreferenced attachments once the window has passed', async () => {
      const service = makeService(60_000)
      const stored = await importOk(service, 'session-a', 'transparent.png')

      const sweep = await service.collectGarbage('session-a', [], { now: Date.now() + 120_000 })
      assert.equal(sweep.ok, true)
      assert.deepEqual(sweep.ok && sweep.value.removedImageIds, [stored.ref.id])
      assert.equal(await exists(imageDir('session-a', stored.ref.id)), false)
    })

    it('protects kept and in-flight attachments even past the window', async () => {
      const service = makeService(60_000)
      const kept = await importOk(service, 'session-a', 'transparent.png')
      const dropped = await importOk(service, 'session-a', 'static.webp')
      const inFlight = await importOk(service, 'session-a', 'single-frame.gif')

      const future = Date.now() + 120_000
      service.retain(inFlight.ref)
      const first = await service.collectGarbage(
        'session-a',
        [kept.ref, { ownerSessionId: 'session-b', id: dropped.ref.id }],
        { now: future },
      )
      assert.deepEqual(first.ok && first.value.removedImageIds, [dropped.ref.id])
      assert.equal(await exists(imageDir('session-a', kept.ref.id)), true)

      const guarded = await service.collectGarbage('session-a', [kept.ref], { now: future })
      assert.deepEqual(guarded.ok && guarded.value.removedImageIds, [])
      service.release(inFlight.ref)
      const released = await service.collectGarbage('session-a', [kept.ref], { now: future })
      assert.deepEqual(released.ok && released.value.removedImageIds, [inFlight.ref.id])
    })

    it('collects crashed-import leftovers (no metadata) after the window', async () => {
      const service = makeService(60_000)
      await importOk(service, 'session-a', 'transparent.png')
      const orphan = path.join(getProjectDataDir(project), 'attachments', 'session-a', 'orphan-dir')
      await mkdir(orphan)

      const fresh = await service.collectGarbage('session-a', [], { now: Date.now() })
      assert.deepEqual(fresh.ok && fresh.value.removedImageIds, [])
      const sweep = await service.collectGarbage('session-a', [], { now: Date.now() + 120_000 })
      assert.ok(sweep.ok && sweep.value.removedImageIds.includes('orphan-dir'))
      assert.equal(await exists(orphan), false)
    })

    it('stores content again after collection removed its earlier copy', async () => {
      const service = makeService(60_000)
      const bytes = await loadFixtureBytes('transparent.png')
      const first = await importOk(service, 'session-a', 'transparent.png', bytes)
      await service.collectGarbage('session-a', [], { now: Date.now() + 120_000 })

      const second = await importOk(service, 'session-a', 'transparent.png', bytes)
      assert.notEqual(second.ref.id, first.ref.id)
      assert.equal((await service.readSendBytes(second.ref)).ok, true)
    })
  })

  describe('copyToSession (S23)', () => {
    it('re-owns an attachment under the target session, leaving the source intact', async () => {
      const service = makeService()
      const original = await importOk(service, 'session-a', 'transparent.png')

      const copied = await service.copyToSession(original.ref, 'session-b')
      assert.equal(copied.ok, true, JSON.stringify(copied))
      if (!copied.ok) return

      assert.equal(copied.value.ref.ownerSessionId, 'session-b')
      assert.notEqual(copied.value.ref.id, original.ref.id)
      assert.equal(copied.value.ref.byteLength, original.ref.byteLength)
      assert.equal((await service.readSendBytes(copied.value.ref)).ok, true)
      // A copy, never a move: the old session's own history still points here.
      assert.equal((await service.readSendBytes(original.ref)).ok, true)
      assert.equal(await exists(imageDir('session-a', original.ref.id)), true)
    })

    it('copies from the send version when the original is gone', async () => {
      const service = makeService()
      const original = await importOk(service, 'session-a', 'transparent.png')
      await unlink(path.join(imageDir('session-a', original.ref.id), 'original.png'))

      const copied = await service.copyToSession(original.ref, 'session-b')
      assert.equal(copied.ok, true, JSON.stringify(copied))
      assert.equal(copied.ok && (await service.readSendBytes(copied.value.ref)).ok, true)
    })

    it('reports a per-image error for an unregistered or foreign ref', async () => {
      const service = makeService()
      const original = await importOk(service, 'session-a', 'transparent.png')

      const foreign = await service.copyToSession(
        { ownerSessionId: 'session-c', id: original.ref.id },
        'session-b',
      )
      assert.equal(foreign.ok, false)
      assert.equal(!foreign.ok && foreign.reason, 'file-missing')

      const unknown = await service.copyToSession(
        { ownerSessionId: 'session-a', id: 'img-nope' },
        'session-b',
      )
      assert.equal(unknown.ok, false)
      assert.equal(!unknown.ok && unknown.reason, 'file-missing')
    })

    it('is a no-op when the owner already is the target session', async () => {
      const service = makeService()
      const original = await importOk(service, 'session-a', 'transparent.png')
      const copied = await service.copyToSession(original.ref, 'session-a')
      assert.equal(copied.ok && copied.value.ref.id, original.ref.id)
    })
  })

  it('removes only the named session\'s attachments', async () => {
    const service = makeService()
    await importOk(service, 'session-a', 'transparent.png')
    await importOk(service, 'session-b', 'static.webp')

    await service.removeSessionAttachments('session-a')
    assert.equal(await exists(path.join(getProjectDataDir(project), 'attachments', 'session-a')), false)
    assert.equal(await exists(path.join(getProjectDataDir(project), 'attachments', 'session-b')), true)
  })

  it('anchors the store under the project\'s data directory', () => {
    assert.equal(attachmentsDirFor(project), path.join(getProjectDataDir(project), 'attachments'))
    assert.equal(
      sessionAttachmentsDir(project, 'session-a'),
      path.join(getProjectDataDir(project), 'attachments', 'session-a'),
    )
  })
})
