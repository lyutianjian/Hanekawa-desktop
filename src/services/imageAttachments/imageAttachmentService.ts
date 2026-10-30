import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertSafeSessionId } from '../../sessions/service.js'
import { getProjectDataDir } from '../../utils/paths.js'
import {
  IMAGE_PROCESS_DEFAULTS,
  processImageBytes,
  renderThumbnailBytes,
  renderViewBytes,
  sniffImage,
} from '../../tools/imageFile.js'
import type { ImageProcessLimits } from '../../tools/imageFile.js'
import type {
  ImageAttachmentMetadata,
  ImageAttachmentRef,
  ImageMimeType,
} from '../../media/types.js'
import type { ImagePresentableErrorReason } from '../../media/imageErrors.js'

/**
 * Session image attachment storage (design doc §12.1, §12.2, §13).
 *
 * Layout under the project's data dir, `~/.hanekawa/projects/<key>/` (see
 * `getProjectDataDir`; the global workspace is keyed by the home directory):
 *
 * ```text
 * attachments/<ownerSessionId>/<imageId>/
 *   original.<ext>     the raw bytes the image arrived as — immutable
 *   image.<ext>        the normalized send version — immutable once committed
 *   thumbnail.png      small preview source
 *   metadata.json      registration; written LAST, so nothing before it exists
 * ```
 *
 * Rules the rest of the image-input work leans on:
 *
 *  - Files land on disk *before* any reference is returned; a failed write
 *    leaves no usable ref (metadata.json is the registration marker, and a
 *    partial directory without it is never resolvable).
 *  - Resolution is by `(ownerSessionId, imageId)` only — never by path. Ids
 *    are validated with `SessionStore`'s own validator, so a record cannot
 *    turn a lookup into an arbitrary read.
 *  - The original and the committed send version are immutable. Rebuilding a
 *    send version is a recovery path (corrupt or missing `image.*` with the
 *    original intact), not a mutation API; crops/converts make new files
 *    under new ids via `importImage`.
 *  - Previews are size-capped thumbnail data URLs, produced on demand — the
 *    only place image bytes ever become Base64, and never part of a snapshot.
 *  - Missing files are per-image errors (`file-missing`), never exceptions:
 *    one broken attachment must not cost the whole session.
 */

/** Bumped when the processing pipeline's output changes; caches rebuild lazily. */
export const IMAGE_PROCESSING_VERSION = 1

/** How long an unreferenced attachment outlives its last holder (design doc
 *  §12.2: the retention window that makes a crash between "written" and
 *  "referenced" survivable). */
export const DEFAULT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000

/** Storage-layer failure mode beside the shared input reasons: the bytes were
 *  fine, the disk was not. Defined in `media/imageErrors.ts` so the reason and
 *  the copy both UIs show for it cannot drift apart. */
export type ImageStoreErrorReason = ImagePresentableErrorReason

export type ImageStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ImageStoreErrorReason; message: string }

/** The identity half of a ref — enough to address an attachment. */
export type AttachmentRefLookup = Pick<ImageAttachmentRef, 'ownerSessionId' | 'id'>

/** What `importImage`/`resolveRef` hand back: the ref records carry, plus the
 *  original's facts (shared type) and the animated-source flag the UIs show. */
export interface StoredAttachment {
  ref: ImageAttachmentRef
  metadata: ImageAttachmentMetadata
  /** True when the source was animated and the send version is its first frame. */
  animated: boolean
}

export interface ImageAttachmentServiceOptions {
  retentionWindowMs?: number
}

export interface CollectGarbageOptions {
  /** Epoch ms the retention window is measured against; defaults to now. */
  now?: number
}

export function attachmentsDirFor(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'attachments')
}

export function sessionAttachmentsDir(cwd: string, sessionId: string): string {
  return path.join(attachmentsDirFor(cwd), sessionId)
}

/**
 * The on-disk path of a ref's send version — the one attachment file whose
 * name is fully determined by the ref itself. UIs that render a link from a
 * bare ref (the TUI transcript, S14) use it; anything needing the original's
 * facts goes through `resolveRef` and its metadata instead.
 */
/**
 * Removes one session's attachment directory, without a live service.
 *
 * `deleteSessionArtifacts` runs from a path that has a project cwd and a
 * session id and nothing else, and the removal must not depend on whether that
 * project happens to have a service instance around. The class method delegates
 * here so "what a session owns on disk" has exactly one definition; it adds
 * only the in-memory dedup index the instance also holds. A stale index entry
 * left by this free function is harmless — `importImage` already re-stores an
 * id its index names but disk no longer has.
 */
export async function removeSessionAttachmentsAt(cwd: string, ownerSessionId: string): Promise<void> {
  assertSafeSessionId(ownerSessionId)
  await rm(sessionAttachmentsDir(cwd, ownerSessionId), { recursive: true, force: true })
}

export function attachmentSendVersionPath(cwd: string, ref: ImageAttachmentRef): string {
  return path.join(sessionAttachmentsDir(cwd, ref.ownerSessionId), ref.id, `image.${extForMime(ref.mimeType)}`)
}

const METADATA_FILE = 'metadata.json'
const THUMBNAIL_FILE = 'thumbnail.png'

/** The registered facts persisted beside the files; `metadata.json` on disk. */
interface StoredMetadata {
  version: 1
  ref: ImageAttachmentRef
  originalMimeType: string
  originalName: string
  /** Stored-original dimensions, before EXIF orientation is applied. */
  originalWidth: number
  originalHeight: number
  originalByteLength: number
  exifOrientation?: number
  /** Hex digest of the original bytes; same-session content dedup key. */
  checksum: string
  processingVersion: number
  animated: boolean
  /** Limits used at import, so a rebuild reproduces the same send version. */
  limits: ImageProcessLimits
  /** ISO string; the retention window's anchor. */
  createdAt: string
}

/** The preview data URL must stay small enough to fit a snapshot-free wire. */
const MAX_PREVIEW_DATA_URL_CHARS = 300_000

/**
 * The fullscreen viewer's data URL cap: the same bound as the thumbnail's, one
 * tier up. Base64 costs a third on top of the bytes, so this is `MAX_VIEW_BYTES`
 * plus that overhead with a little headroom — a viewer copy that cannot fit
 * here is one `renderViewBytes` already failed to shrink.
 */
const MAX_VIEW_DATA_URL_CHARS = 4_200_000

function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpeg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'bin'
  }
}

/** A send version is trustworthy when it exists, is the recorded size, and
 *  still sniffs as its recorded format — catching truncation and clobbering
 *  without paying for a decode. */
function sendBytesMatchFormat(bytes: Buffer, mimeType: ImageMimeType): boolean {
  const expected = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpeg' : 'webp'
  return sniffImage(bytes)?.format === expected
}

function serializeMetadata(stored: StoredMetadata): string {
  return `${JSON.stringify(stored, null, 2)}\n`
}

function storedAttachmentFor(
  cwd: string,
  sessionId: string,
  stored: StoredMetadata,
): StoredAttachment {
  return {
    ref: stored.ref,
    metadata: {
      originalMimeType: stored.originalMimeType,
      originalName: stored.originalName,
      originalWidth: stored.originalWidth,
      originalHeight: stored.originalHeight,
      exifOrientation: stored.exifOrientation,
      checksum: stored.checksum,
      processingVersion: stored.processingVersion,
      sentWidth: stored.ref.width,
      sentHeight: stored.ref.height,
      localPath: path.join(
        sessionAttachmentsDir(cwd, sessionId),
        stored.ref.id,
        `original.${extForMime(stored.originalMimeType)}`,
      ),
    },
    animated: stored.animated,
  }
}

function notRegistered(ref: AttachmentRefLookup): ImageStoreResult<never> {
  return {
    ok: false,
    reason: 'file-missing',
    message: `Attachment ${ref.id} is not registered in session ${ref.ownerSessionId}.`,
  }
}

/** Reuses `SessionStore`'s validator as the single rule for path-component
 *  ids; callers that only *read* convert the throw into a per-image error. */
function isSafeId(id: string): boolean {
  try {
    assertSafeSessionId(id)
    return true
  } catch {
    return false
  }
}

function inUseKey(sessionId: string, imageId: string): string {
  return `${sessionId}\u0000${imageId}`
}

/** `stored.limits` comes off disk, so it is validated before a rebuild trusts it. */
function isImageProcessLimits(value: unknown): value is ImageProcessLimits {
  if (value === null || typeof value !== 'object') return false
  const limits = value as Record<string, unknown>
  return (
    typeof limits.maxInputBytes === 'number' &&
    limits.maxInputBytes > 0 &&
    typeof limits.maxDecodedPixels === 'number' &&
    limits.maxDecodedPixels > 0 &&
    typeof limits.sendLongEdge === 'number' &&
    limits.sendLongEdge > 0 &&
    typeof limits.maxSendBytes === 'number' &&
    limits.maxSendBytes > 0
  )
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath)
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ImageAttachmentService {
  private readonly cwd: string
  private readonly retentionWindowMs: number
  /** sessionId → checksum → imageId; accelerator, disk stays the truth. */
  private readonly checksumIndex = new Map<string, Map<string, string>>()
  /** Attachments currently importing or sending; collection skips them. */
  private readonly inUse = new Set<string>()
  /** Serialises imports so same-content dedup cannot race itself. */
  private imports: Promise<unknown> = Promise.resolve()

  constructor(cwd: string, options: ImageAttachmentServiceOptions = {}) {
    this.cwd = cwd
    this.retentionWindowMs = options.retentionWindowMs ?? DEFAULT_ATTACHMENT_RETENTION_MS
  }

  /**
   * Process raw image bytes through the shared pipeline and persist them as a
   * new attachment. The original is stored verbatim; the send version and
   * thumbnail come from `processImageBytes`, and the ref is returned only once
   * every file (metadata last) is on disk.
   */
  async importImage(
    ownerSessionId: string,
    bytes: Buffer,
    name: string,
    options: Partial<ImageProcessLimits> = {},
  ): Promise<ImageStoreResult<StoredAttachment>> {
    assertSafeSessionId(ownerSessionId)
    const run = this.imports.then(() =>
      this.importImageSerialized(ownerSessionId, bytes, name, options),
    )
    this.imports = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async importImageSerialized(
    ownerSessionId: string,
    bytes: Buffer,
    name: string,
    options: Partial<ImageProcessLimits>,
  ): Promise<ImageStoreResult<StoredAttachment>> {
    const processed = await processImageBytes(bytes, { name, ...options })
    if (!processed.ok) return processed
    const image = processed.image
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const limits: ImageProcessLimits = { ...IMAGE_PROCESS_DEFAULTS, ...options }

    const index = await this.loadSessionIndex(ownerSessionId)
    const existingId = index.get(checksum)
    if (existingId !== undefined) {
      const existing = await this.readStored(ownerSessionId, existingId)
      if (existing && existing.checksum === checksum) {
        return { ok: true, value: storedAttachmentFor(this.cwd, ownerSessionId, existing) }
      }
      // Indexed but gone on disk (collected underneath us): store it again.
      index.delete(checksum)
    }

    const imageId = `img-${randomBytes(8).toString('hex')}`
    const dir = this.dirFor(ownerSessionId, imageId)
    const useKey = inUseKey(ownerSessionId, imageId)
    this.inUse.add(useKey)
    try {
      const stored: StoredMetadata = {
        version: 1,
        ref: {
          id: imageId,
          ownerSessionId,
          name: image.name,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          byteLength: image.bytes.byteLength,
        },
        originalMimeType: image.originalMimeType,
        originalName: image.name,
        originalWidth: image.originalWidth,
        originalHeight: image.originalHeight,
        originalByteLength: bytes.byteLength,
        exifOrientation: image.exifOrientation,
        checksum,
        processingVersion: IMAGE_PROCESSING_VERSION,
        animated: image.animated,
        limits,
        createdAt: new Date().toISOString(),
      }
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, `original.${extForMime(image.originalMimeType)}`), bytes)
        await writeFile(path.join(dir, `image.${extForMime(image.mimeType)}`), image.bytes)
        await writeFile(path.join(dir, THUMBNAIL_FILE), await renderThumbnailBytes(image.bytes))
        // Registration is the last write: nothing before this line resolves.
        await writeFile(path.join(dir, METADATA_FILE), serializeMetadata(stored), 'utf8')
      } catch (error) {
        // Best effort: the half-written directory may not be reachable at all —
        // a regular file where `.hanekawa` should be makes the removal itself
        // fail with ENOTDIR, which `force` does not cover — and a cleanup that
        // throws would replace the answer the caller is owed with the error of
        // the tidy-up.
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        return {
          ok: false,
          reason: 'store-write-failed',
          message: `Storing ${name} failed: ${errorMessage(error)}`,
        }
      }
      index.set(checksum, imageId)
      return { ok: true, value: storedAttachmentFor(this.cwd, ownerSessionId, stored) }
    } finally {
      this.inUse.delete(useKey)
    }
  }

  /** The registered facts of a ref, without loading any image bytes. */
  async resolveRef(ref: AttachmentRefLookup): Promise<ImageStoreResult<StoredAttachment>> {
    const stored = await this.readStored(ref.ownerSessionId, ref.id)
    if (stored === null) return notRegistered(ref)
    return { ok: true, value: storedAttachmentFor(this.cwd, ref.ownerSessionId, stored) }
  }

  /**
   * The send version's bytes. A missing, truncated, or clobbered `image.*` is
   * rebuilt from the immutable original (design doc §12.1); when the original
   * is gone too, the result is a per-image `file-missing` error.
   */
  async readSendBytes(
    ref: AttachmentRefLookup,
  ): Promise<ImageStoreResult<{ bytes: Buffer; mimeType: ImageMimeType }>> {
    const stored = await this.readStored(ref.ownerSessionId, ref.id)
    if (stored === null) return notRegistered(ref)
    return this.ensureSendVersion(ref.ownerSessionId, stored)
  }

  /**
   * A size-capped `data:image/png;base64,…` preview from the thumbnail. The
   * only API that produces Base64; callers keep it out of snapshots and
   * records, re-deriving it on demand.
   */
  async previewDataUrl(ref: AttachmentRefLookup): Promise<ImageStoreResult<string>> {
    const stored = await this.readStored(ref.ownerSessionId, ref.id)
    if (stored === null) return notRegistered(ref)
    const send = await this.ensureSendVersion(ref.ownerSessionId, stored)
    if (!send.ok) return send

    const dir = this.dirFor(ref.ownerSessionId, stored.ref.id)
    let thumbnail = await readFileOrNull(path.join(dir, THUMBNAIL_FILE))
    if (thumbnail === null || sniffImage(thumbnail)?.format !== 'png') {
      thumbnail = await renderThumbnailBytes(send.value.bytes)
      try {
        await writeFile(path.join(dir, THUMBNAIL_FILE), thumbnail)
      } catch (error) {
        return {
          ok: false,
          reason: 'store-write-failed',
          message: `Restoring the preview of ${stored.ref.name} (${stored.ref.id}) failed: ${errorMessage(error)}`,
        }
      }
    }
    const dataUrl = `data:image/png;base64,${thumbnail.toString('base64')}`
    if (dataUrl.length > MAX_PREVIEW_DATA_URL_CHARS) {
      return {
        ok: false,
        reason: 'image-too-large',
        message: `The preview thumbnail of ${stored.ref.name} (${stored.ref.id}) exceeds the preview size cap.`,
      }
    }
    return { ok: true, value: dataUrl }
  }

  /**
   * A screen-sized `data:image/png;base64,…` of the send version, for the
   * desktop's fullscreen viewer. The second and last API that produces Base64.
   *
   * Rendered on demand and never written to disk: `thumbnail.png` earns its
   * place because every tile in every strip needs it, and this one is wanted
   * only while a viewer is open. Same failure vocabulary as `previewDataUrl`,
   * so the renderer explains both with one `formatImageFailure`.
   */
  async viewDataUrl(ref: AttachmentRefLookup): Promise<ImageStoreResult<string>> {
    const stored = await this.readStored(ref.ownerSessionId, ref.id)
    if (stored === null) return notRegistered(ref)
    const send = await this.ensureSendVersion(ref.ownerSessionId, stored)
    if (!send.ok) return send

    let view: Buffer
    try {
      view = await renderViewBytes(send.value.bytes)
    } catch (error) {
      return {
        ok: false,
        reason: 'decode-failed',
        message: `Rendering the fullscreen view of ${stored.ref.name} (${stored.ref.id}) failed: ${errorMessage(error)}`,
      }
    }
    const dataUrl = `data:image/png;base64,${view.toString('base64')}`
    if (dataUrl.length > MAX_VIEW_DATA_URL_CHARS) {
      return {
        ok: false,
        reason: 'image-too-large',
        message: `The fullscreen view of ${stored.ref.name} (${stored.ref.id}) exceeds the preview size cap.`,
      }
    }
    return { ok: true, value: dataUrl }
  }

  /**
   * Mark an attachment as in flight (importing or sending). Collection skips
   * in-flight attachments even past the retention window.
   */
  retain(ref: AttachmentRefLookup): void {
    if (isSafeId(ref.ownerSessionId) && isSafeId(ref.id)) {
      this.inUse.add(inUseKey(ref.ownerSessionId, ref.id))
    }
  }

  release(ref: AttachmentRefLookup): void {
    this.inUse.delete(inUseKey(ref.ownerSessionId, ref.id))
  }

  /**
   * Delete this session's attachments that nothing references any more and
   * whose retention window has passed (design doc §12.2). `keep` is the set
   * still referenced by messages, the queue, or active drafts — the caller
   * owns that truth; this sweep owns the window and the in-flight guard.
   */
  async collectGarbage(
    ownerSessionId: string,
    keep: readonly AttachmentRefLookup[],
    options: CollectGarbageOptions = {},
  ): Promise<ImageStoreResult<{ removedImageIds: string[] }>> {
    assertSafeSessionId(ownerSessionId)
    const now = options.now ?? Date.now()
    const keepIds = new Set(
      keep.filter((entry) => entry.ownerSessionId === ownerSessionId).map((entry) => entry.id),
    )
    const sessionDir = sessionAttachmentsDir(this.cwd, ownerSessionId)
    let entries
    try {
      entries = await readdir(sessionDir, { withFileTypes: true })
    } catch {
      return { ok: true, value: { removedImageIds: [] } }
    }

    const removed: string[] = []
    const index = this.checksumIndex.get(ownerSessionId)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const imageId = entry.name
      if (keepIds.has(imageId) || this.inUse.has(inUseKey(ownerSessionId, imageId))) continue
      const dir = path.join(sessionDir, imageId)
      const anchor = await retentionAnchor(dir)
      if (anchor === null) continue // unreadable: leave it alone this sweep
      if (now - anchor < this.retentionWindowMs) continue
      try {
        await rm(dir, { recursive: true, force: true })
        removed.push(imageId)
        if (index) {
          for (const [checksum, indexedId] of index) {
            if (indexedId === imageId) index.delete(checksum)
          }
        }
      } catch {
        // One unremovable directory must not abort the sweep.
      }
    }
    return { ok: true, value: { removedImageIds: removed } }
  }

  /**
   * Re-register an attachment under another session, returning the new ref.
   *
   * `/clear` carries the pending queue into a fresh session log (design
   * §12.3). A migrated message that kept its old ref would still resolve
   * today — the old session's files stay put — but deleting that session
   * later would leave the queue holding a dangling reference, which §12.3's
   * last paragraph rules out. Copy, never move: the old session's own history
   * still references the original files.
   *
   * Goes back through `importImage`, so the copy is dedup-checked against the
   * target session and gets its own thumbnail and metadata rather than a
   * hand-rewritten `metadata.json`. The immutable original is the preferred
   * source; when it is gone but the send version survives, that is copied
   * instead — the same degradation `readSendBytes` already accepts.
   */
  async copyToSession(
    ref: AttachmentRefLookup,
    nextOwnerSessionId: string,
  ): Promise<ImageStoreResult<StoredAttachment>> {
    assertSafeSessionId(nextOwnerSessionId)
    const stored = await this.readStored(ref.ownerSessionId, ref.id)
    if (stored === null) return notRegistered(ref)
    if (ref.ownerSessionId === nextOwnerSessionId) {
      return { ok: true, value: storedAttachmentFor(this.cwd, ref.ownerSessionId, stored) }
    }

    const original = await readFileOrNull(
      path.join(this.dirFor(ref.ownerSessionId, stored.ref.id), `original.${extForMime(stored.originalMimeType)}`),
    )
    if (original !== null && createHash('sha256').update(original).digest('hex') === stored.checksum) {
      const limits = isImageProcessLimits(stored.limits) ? stored.limits : IMAGE_PROCESS_DEFAULTS
      return this.importImage(nextOwnerSessionId, original, stored.originalName, limits)
    }
    const send = await this.ensureSendVersion(ref.ownerSessionId, stored)
    if (!send.ok) return send
    return this.importImage(nextOwnerSessionId, send.value.bytes, stored.ref.name)
  }

  /**
   * Delete every attachment a session owns. Called from the session/project
   * deletion paths (never for drafts, whose files the retention window
   * guards); never touches files outside `attachments/<sessionId>`.
   */
  async removeSessionAttachments(ownerSessionId: string): Promise<void> {
    this.checksumIndex.delete(ownerSessionId)
    await removeSessionAttachmentsAt(this.cwd, ownerSessionId)
  }

  // ---------------------------------------------------------------------------

  private dirFor(sessionId: string, imageId: string): string {
    return path.join(sessionAttachmentsDir(this.cwd, sessionId), imageId)
  }

  /**
   * Reads (and shape-checks) an attachment's registration. `null` means "not
   * registered here" — a missing id, an unparsable metadata file, or an id
   * that is not path-safe all collapse into the same per-image answer, so a
   * damaged record cannot take the session down with it.
   */
  private async readStored(sessionId: string, imageId: string): Promise<StoredMetadata | null> {
    if (!isSafeId(sessionId) || !isSafeId(imageId)) return null
    const raw = await readFileOrNull(this.dirFor(sessionId, imageId) + path.sep + METADATA_FILE)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as StoredMetadata
      if (
        parsed.version !== 1 ||
        !parsed.ref ||
        parsed.ref.id !== imageId ||
        parsed.ref.ownerSessionId !== sessionId ||
        typeof parsed.checksum !== 'string'
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  private async ensureSendVersion(
    sessionId: string,
    stored: StoredMetadata,
  ): Promise<ImageStoreResult<{ bytes: Buffer; mimeType: ImageMimeType }>> {
    const sendPath = path.join(
      this.dirFor(sessionId, stored.ref.id),
      `image.${extForMime(stored.ref.mimeType)}`,
    )
    const raw = await readFileOrNull(sendPath)
    if (
      raw !== null &&
      raw.byteLength === stored.ref.byteLength &&
      sendBytesMatchFormat(raw, stored.ref.mimeType)
    ) {
      return { ok: true, value: { bytes: raw, mimeType: stored.ref.mimeType } }
    }
    return this.rebuildSendVersion(sessionId, stored)
  }

  private async rebuildSendVersion(
    sessionId: string,
    stored: StoredMetadata,
  ): Promise<ImageStoreResult<{ bytes: Buffer; mimeType: ImageMimeType }>> {
    const dir = this.dirFor(sessionId, stored.ref.id)
    const original = await readFileOrNull(
      path.join(dir, `original.${extForMime(stored.originalMimeType)}`),
    )
    if (original === null) {
      return {
        ok: false,
        reason: 'file-missing',
        message: `Both the send version and the cached original of ${stored.ref.name} (${stored.ref.id}) are gone.`,
      }
    }
    const checksum = createHash('sha256').update(original).digest('hex')
    if (checksum !== stored.checksum) {
      return {
        ok: false,
        reason: 'file-missing',
        message: `The cached original of ${stored.ref.name} (${stored.ref.id}) no longer matches its recorded checksum.`,
      }
    }
    const limits = isImageProcessLimits(stored.limits) ? stored.limits : IMAGE_PROCESS_DEFAULTS
    const rebuilt = await processImageBytes(original, { name: stored.originalName, ...limits })
    if (!rebuilt.ok) return rebuilt
    const image = rebuilt.image
    try {
      await writeFile(path.join(dir, `image.${extForMime(image.mimeType)}`), image.bytes)
      await writeFile(path.join(dir, THUMBNAIL_FILE), await renderThumbnailBytes(image.bytes))
    } catch (error) {
      return {
        ok: false,
        reason: 'store-write-failed',
        message: `Rebuilding ${stored.ref.name} (${stored.ref.id}) failed: ${errorMessage(error)}`,
      }
    }
    if (
      image.mimeType !== stored.ref.mimeType ||
      image.width !== stored.ref.width ||
      image.height !== stored.ref.height ||
      image.bytes.byteLength !== stored.ref.byteLength
    ) {
      // Pipeline drift: the ref keeps describing the bytes actually sent.
      const updated: StoredMetadata = {
        ...stored,
        ref: {
          ...stored.ref,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          byteLength: image.bytes.byteLength,
        },
      }
      try {
        await writeFile(path.join(dir, METADATA_FILE), serializeMetadata(updated), 'utf8')
      } catch {
        // Best effort: the rebuilt files are already on disk and returned.
      }
    }
    return { ok: true, value: { bytes: image.bytes, mimeType: image.mimeType } }
  }

  /** Scans a session's registrations once; later calls reuse the cache. */
  private async loadSessionIndex(sessionId: string): Promise<Map<string, string>> {
    const cached = this.checksumIndex.get(sessionId)
    if (cached) return cached
    const index = new Map<string, string>()
    try {
      const entries = await readdir(sessionAttachmentsDir(this.cwd, sessionId), {
        withFileTypes: true,
      })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const stored = await this.readStored(sessionId, entry.name)
        if (stored) index.set(stored.checksum, entry.name)
      }
    } catch {
      // No session directory yet: an empty index is the correct answer.
    }
    this.checksumIndex.set(sessionId, index)
    return index
  }
}

/**
 * When an attachment became collectable: its registration's `createdAt`, or —
 * for a directory with no readable metadata (a crashed import's leftovers) —
 * the directory's own mtime. `null` means "could not tell"; the sweep leaves
 * those alone.
 */
async function retentionAnchor(dir: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(dir, METADATA_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { createdAt?: unknown }
    if (typeof parsed.createdAt === 'string') {
      const time = Date.parse(parsed.createdAt)
      if (Number.isFinite(time)) return time
    }
  } catch {
    // Fall through to the directory's own timestamp.
  }
  try {
    return (await stat(dir)).mtimeMs
  } catch {
    return null
  }
}
