import type { ImageAttachmentRef } from '../../../media/types.js'
import { formatImageFailure, imageErrorCopy } from '../../../media/imageErrors.js'

/**
 * The composer's draft image attachments (design §6.1, session S11).
 *
 * A draft is an image on its way into — or already in — the current pane's
 * next submission. The state machine is `importing → ready | failed`, and the
 * list is per pane: this module is pure so the pane, the composer strip, and
 * the send gate all read one shape.
 *
 * Renderer-owned copy, like `EFFORT_LABELS`: the labels are Chinese directly,
 * and the format matches the TUI's `formatImageAttachmentSummary`
 * (`src/tui/utils/imageDrafts.ts`) — kept as a twin rather than an import
 * because the renderer may not value-import `tui/`.
 */

/** What one import runs against: bytes the renderer read (paste, drop), or a path the host reads (picker). */
export type AttachmentImportSource =
  | { kind: 'bytes'; name: string; bytes: Uint8Array }
  | { kind: 'path'; path: string; name?: string }

/**
 * One draft entry. `failed` keeps its source so 重试 can run the same import
 * again — pasted bytes are unreadable any other way, so the list is the only
 * place the retry can come from. `ready` keeps it too: an attachment belongs to
 * one session, so moving the draft to another session imports it again.
 */
export type AttachmentDraft =
  | { kind: 'importing'; draftId: string; name: string; source: AttachmentImportSource }
  | { kind: 'ready'; draftId: string; ref: ImageAttachmentRef; animated?: boolean; source?: AttachmentImportSource }
  | {
    kind: 'failed'
    draftId: string
    name: string
    source: AttachmentImportSource
    reason: string
    message: string
  }

export type AttachmentDrafts = readonly AttachmentDraft[]

export interface AttachmentImportOutcome {
  ok: boolean
  reason: string
  message: string
}

/**
 * The per-input image quota the `@`-mention path already enforces
 * (`MAX_AT_MENTION_IMAGES`, explicit attachments included). The draft list is
 * capped at the same number so the two entrances cannot disagree about how
 * many images one input may carry.
 */
export const MAX_DRAFT_IMAGES = 10

function draftName(source: AttachmentImportSource): string {
  if (source.kind === 'bytes') return source.name
  return source.name ?? source.path.split(/[\\/]/).pop() ?? source.path
}

export function beginAttachmentImport(
  drafts: AttachmentDrafts,
  source: AttachmentImportSource,
  draftId: string,
): AttachmentDrafts {
  return [...drafts, { kind: 'importing', draftId, name: draftName(source), source }]
}

/** `undefined` when the draft is already gone (removed mid-flight). */
export function settleAttachmentImport(
  drafts: AttachmentDrafts,
  draftId: string,
  outcome:
    | { ok: true; ref: ImageAttachmentRef; animated?: boolean }
    | { ok: false; reason: string; message: string },
): AttachmentDrafts | undefined {
  const entry = drafts.find((draft) => draft.draftId === draftId)
  if (!entry || entry.kind !== 'importing') return undefined
  const settled: AttachmentDraft = outcome.ok
    ? { kind: 'ready', draftId, ref: outcome.ref, ...(outcome.animated ? { animated: true } : {}), source: entry.source }
    : {
      kind: 'failed',
      draftId,
      name: entry.name,
      source: entry.source,
      reason: outcome.reason,
      message: outcome.message,
    }
  return drafts.map((draft) => (draft.draftId === draftId ? settled : draft))
}

/** A failed draft back to `importing`, keeping its source for the re-run. */
export function retryAttachmentImport(drafts: AttachmentDrafts, draftId: string): AttachmentDrafts | undefined {
  const entry = drafts.find((draft) => draft.draftId === draftId)
  if (!entry || entry.kind !== 'failed') return undefined
  return drafts.map((draft) =>
    draft.draftId === draftId
      ? { kind: 'importing' as const, draftId, name: entry.name, source: entry.source }
      : draft,
  )
}

/**
 * Removes one draft. A `ready` entry answers the image id it held, so the
 * caller can drop the host-side draft hold (`remove-attachment`); importing
 * and failed entries own nothing the store knows about.
 */
export function removeAttachmentDraft(
  drafts: AttachmentDrafts,
  draftId: string,
): { drafts: AttachmentDrafts; releasedImageId?: string } {
  const entry = drafts.find((draft) => draft.draftId === draftId)
  if (!entry) return { drafts }
  return {
    drafts: drafts.filter((draft) => draft.draftId !== draftId),
    ...(entry.kind === 'ready' ? { releasedImageId: entry.ref.id } : {}),
  }
}

/** The refs a submission would carry; order is list order, which is arrival order. */
export function readyAttachmentRefs(drafts: AttachmentDrafts): ImageAttachmentRef[] {
  return drafts.flatMap((draft) => (draft.kind === 'ready' ? [draft.ref] : []))
}

/** What importing this list into another session runs, in list order; restored entries have no source and are left out. */
export function draftImageSources(drafts: AttachmentDrafts): AttachmentImportSource[] {
  return drafts.flatMap((draft) => (draft.source === undefined ? [] : [draft.source]))
}

/** True while any draft is still importing or has failed — the input is not complete yet. */
export function attachmentDraftsIncomplete(drafts: AttachmentDrafts): boolean {
  return drafts.some((draft) => draft.kind !== 'ready')
}

export function attachmentDraftsFull(drafts: AttachmentDrafts): boolean {
  return drafts.length >= MAX_DRAFT_IMAGES
}

/** Drafts rebuilt from an interrupt's `restore-input` images; no source, so no retry. */
export function restoredAttachmentDrafts(images: readonly ImageAttachmentRef[]): AttachmentDrafts {
  return images.map((ref, index) => ({ kind: 'ready' as const, draftId: `restored-${index}`, ref }))
}

// --- the paste/drop source -----------------------------------------------------

/**
 * The structural half of a `File` the paste and drop handlers read. Kept
 * minimal so a DOM stub can fake it without a `File` implementation.
 */
export interface ImageFileLike {
  readonly name: string
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
}

export function isImageFile(file: ImageFileLike): boolean {
  return file.type.startsWith('image/')
}

/**
 * Reads the image files out of a paste or a drop. Only images become
 * attachments — anything else the clipboard carried is text-paste business,
 * and anything else a drag carried is not this composer's to interpret.
 */
export async function imagePasteSources(files: readonly ImageFileLike[]): Promise<AttachmentImportSource[]> {
  const sources: AttachmentImportSource[] = []
  for (const file of files) {
    if (!isImageFile(file)) continue
    sources.push({ kind: 'bytes', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  }
  return sources
}

// --- the strip the composer draws ----------------------------------------------

export interface AttachmentRowView {
  readonly draftId: string
  readonly state: 'importing' | 'ready' | 'failed'
  /** The whole fact, for the tile's `title` and its accessible name. */
  readonly label: string
  /** Just the file name — the tile is pixels, so this is the `alt` behind them. */
  readonly name: string
  /** The state's own words: 导入中… / 失败：…. */
  readonly detail?: string
  /** A ready row's attachment id, for the thumbnail lookup and the preview ask. */
  readonly imageId?: string
  /**
   * The thumbnail's data URL when the pane already has it (S12). Absent until
   * the on-demand load settles; a row gains it exactly once — the arrival is a
   * real content change, so it repaints the row, and an unchanged view still
   * rebuilds nothing.
   */
  readonly thumbUrl?: string
}

export interface AttachmentStripView {
  readonly rows: readonly AttachmentRowView[]
  /** How many images would ride the next submission. */
  readonly readyCount: number
  /**
   * Why the send button should explain itself instead of sending: pending or
   * failed drafts, or images against a model that cannot take them. Absent
   * when there is nothing to say.
   */
  readonly sendBlockNote?: string
}

/**
 * The send gate's own words, built from the shared reason copy (S24) so the
 * pre-flight note and the host's rejection name the same exit. Only the
 * composer-specific affordance (the model chip) is added on top.
 */
const NOT_CAPABLE_COPY = imageErrorCopy('model-not-capable')!
const NOT_CAPABLE_NOTE = `${NOT_CAPABLE_COPY.label}。可点击输入栏的模型芯片切换模型。${NOT_CAPABLE_COPY.action}`
const INCOMPLETE_NOTE = '还有附件在导入中或未成功；处理后才能发送。'

/**
 * The strip plus the send gate. The runtime arrives as the snapshot's
 * capability subset: `undefined` means no snapshot yet, in which case nothing
 * is blocked — the host's submission gate (S15/S19) is the authority and the
 * renderer's copy is the *why*, shown before the round trip that would fail.
 *
 * `previews` answers a ready row's attachment id with the thumbnail data URL
 * the pane already holds, or `undefined` when it does not. The lookup (not the
 * map) keeps this pure and lets the pane own the LRU.
 */
export function attachmentStripView(
  drafts: AttachmentDrafts,
  runtime: { status?: 'ready' | 'needs_configuration'; supportsImageInput?: boolean } | undefined,
  previews: (imageId: string) => string | undefined = () => undefined,
): AttachmentStripView {
  const rows: AttachmentRowView[] = drafts.map((draft, index) => {
    const number = index + 1
    if (draft.kind === 'importing') {
      return {
        draftId: draft.draftId,
        state: 'importing',
        label: `图片 ${number}：${draft.name}`,
        name: draft.name,
        detail: '导入中…',
      }
    }
    if (draft.kind === 'failed') {
      return {
        draftId: draft.draftId,
        state: 'failed',
        label: `图片 ${number}：${draft.name}`,
        name: draft.name,
        // The reason's name and its exit, not just the facts (S24): a row that
        // only says "…is a BMP image" leaves the user nothing to do next.
        detail: `失败：${formatImageFailure(draft.reason, draft.message)}`,
      }
    }
    const thumbUrl = previews(draft.ref.id)
    return {
      draftId: draft.draftId,
      state: 'ready',
      label: `图片 ${number}：${draft.ref.name}，${imageDimensions(draft.ref, draft.animated)}`,
      name: draft.ref.name,
      imageId: draft.ref.id,
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
    }
  })

  const readyCount = rows.filter((row) => row.state === 'ready').length
  let sendBlockNote: string | undefined
  if (runtime?.status === 'needs_configuration') sendBlockNote = '请先配置可用模型。点击“配置模型”打开设置，草稿会保留。'
  else if (attachmentDraftsIncomplete(drafts)) sendBlockNote = INCOMPLETE_NOTE
  else if (readyCount > 0 && runtime !== undefined && runtime.supportsImageInput !== true) {
    sendBlockNote = NOT_CAPABLE_NOTE
  }

  return { rows, readyCount, ...(sendBlockNote ? { sendBlockNote } : {}) }
}

// --- the fullscreen viewer ---------------------------------------------------
//
// A tile's click used to open a small popover anchored above the composer bar,
// built from the same 256px thumbnail the tile paints. It opens the window's
// fullscreen viewer now (`model/imageViewer.ts`), which asks the host for a
// screen-sized copy — so there is no view model here any more: the pane hands
// the viewer a `ref`, not a picture.

/** A ready draft's facts, for the viewer the pane opens from a tile's click. */
export function readyDraftRef(
  drafts: AttachmentDrafts,
  draftId: string,
): { ref: ImageAttachmentRef; animated: boolean } | undefined {
  const entry = drafts.find((draft) => draft.draftId === draftId)
  if (entry?.kind !== 'ready') return undefined
  return { ref: entry.ref, animated: entry.animated === true }
}

/** `W×H`, with ，动画首帧 appended when the import took the first frame. */
export function imageDimensions(ref: ImageAttachmentRef, animated = false): string {
  return `${ref.width}×${ref.height}${animated ? '，动画首帧' : ''}`
}
