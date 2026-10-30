import { IMAGE_INPUT_ERROR_REASONS } from './types.js'
import type { ImageInputErrorReason } from './types.js'

/**
 * The user-facing half of image failures (design §13, session S24): one place
 * that turns a distinguishable reason into words and into the way out.
 *
 * The layers that *detect* a failure already name it — the processing pipeline,
 * the attachment store, the turn-image gate, the provider's final check all
 * answer with a reason plus the facts (file name, byte counts, limits). What
 * they do not carry is what the user can do next, and both shells were showing
 * only the facts. This module supplies the missing half, so the desktop strip,
 * the desktop notices, and the TUI system messages say the same thing about the
 * same reason instead of each inventing copy.
 *
 * Pure, like `types.ts`, and for the same reason: the renderer, the TUI, the
 * harness, and the protocol host all read it, and the renderer may not
 * value-import `harness/` or `services/`.
 *
 * Deliberately *not* a catch-all error formatter. `imageBlockReasonOf` answers
 * `undefined` for anything that is not a recognized image block, so an HTTP
 * error, a bad endpoint, or a provider outage keeps its own words — claiming an
 * image reason for those would be a lie about what went wrong (design §13:
 * 不谎称已避免).
 */

/** Every reason a user-visible image failure can carry: the input reasons plus the store's own. */
export type ImagePresentableErrorReason = ImageInputErrorReason | 'store-write-failed'

export const IMAGE_PRESENTABLE_ERROR_REASONS: readonly ImagePresentableErrorReason[] = [
  ...IMAGE_INPUT_ERROR_REASONS,
  'store-write-failed',
]

/** What a reason is called, and what the user can do about it. */
export interface ImageErrorCopy {
  /** Short name of the failure class, never an HTTP status. */
  label: string
  /** The actionable exit: switch model / remove the image / crop it / retry. */
  action: string
}

const COPY: Record<ImagePresentableErrorReason, ImageErrorCopy> = {
  'model-not-capable': {
    label: '当前模型不支持图像输入',
    action: '用 /model 切换到支持图像的模型，或移除图片后重发。',
  },
  'unsupported-format': {
    label: '图片格式不支持',
    action: '先把它转换成 PNG 或 JPEG，再重新附加。',
  },
  'decode-failed': {
    label: '图片无法解码',
    action: '确认文件完整（能被看图工具打开），或换一张图片。',
  },
  'file-missing': {
    // Both origins land here: a cached attachment whose files are gone, and an
    // `@` mention pointing at a path that is not there — so the exit names
    // both the source file and the re-attach.
    label: '图片文件已丢失',
    action: '确认文件仍在原路径，或重新附加这张图片后再发送。',
  },
  'image-too-large': {
    label: '单张图片超出限额',
    action: '裁剪这张图片或换用更小的版本后重发。',
  },
  'request-too-large': {
    label: '本次请求超出限额',
    action: '移除部分图片，或先用 /compact 压缩较早的对话，再重发。',
  },
  'too-many-images': {
    label: '图片数量超出上限',
    action: '移除部分图片后重发。',
  },
  'store-write-failed': {
    label: '附件保存失败',
    action: '确认项目的 .hanekawa 目录可写后重试。',
  },
}

export function isImagePresentableErrorReason(value: unknown): value is ImagePresentableErrorReason {
  return typeof value === 'string'
    && (IMAGE_PRESENTABLE_ERROR_REASONS as readonly string[]).includes(value)
}

/** `undefined` for reasons this module does not own — the caller keeps its own words. */
export function imageErrorCopy(reason: string): ImageErrorCopy | undefined {
  return isImagePresentableErrorReason(reason) ? COPY[reason] : undefined
}

/**
 * The one line both shells show for a settled failure: the reason's name, the
 * detecting layer's facts, and the way out. An unknown reason keeps just the
 * facts rather than being labelled with a class it does not belong to.
 */
export function formatImageFailure(reason: string, message: string): string {
  const copy = imageErrorCopy(reason)
  if (!copy) return message
  return `${copy.label}：${message} ${copy.action}`
}

/**
 * The reason behind a thrown error, or `undefined` when it is not an image
 * block. Structural rather than `instanceof`: `TurnImageBlockError` lives in
 * `harness/`, which the renderer may not value-import, and the same error also
 * crosses process boundaries where the class does not survive.
 */
export function imageBlockReasonOf(error: unknown): ImagePresentableErrorReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const reason = (error as { imageInputBlock?: unknown }).imageInputBlock
  return isImagePresentableErrorReason(reason) ? reason : undefined
}

/**
 * A thrown error's message with its image exit appended — and untouched when it
 * is not an image block. The gate sites use this so a rejection that crosses a
 * boundary carrying only a string (the protocol's `fail`, a session notice)
 * still arrives with something the user can act on.
 *
 * The action is appended rather than substituted: the thrown message names the
 * images and the limits, which the reason alone cannot.
 */
export function describeImageBlockError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const reason = imageBlockReasonOf(error)
  if (reason === undefined) return message
  return `${message} ${COPY[reason].action}`
}
