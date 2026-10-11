import {
  clipOf,
  IDLE_FALLBACK_MS,
  IDLE_TIMEOUT_MS,
  LOOP_HANDOFF_MS,
  nextStage,
  restStage,
  SHEETS,
  TAIL_FRAMES,
  wantBody,
  type MarkBody,
  type MarkClip,
  type MarkSpec,
  type MarkStage,
  type SheetInfo,
} from '../model/workingMark.js'
import { el } from './dom.js'
import { motionPolicy } from './motion.js'

/**
 * The working mark's view side: sprites, animation and timers. The decisions live in
 * `model/workingMark.ts`.
 */

/** The decoded sheets, as the controller reads them. */
export interface SpriteSheets {
  /** Relative to `index.html`, beside which `sprites/` is copied. */
  url(clip: MarkClip): string
  has(clip: MarkClip): boolean
  /** All three of the body's sheets decoded. */
  ready(body: MarkBody): boolean
}

export interface SheetStore {
  /** `undefined` until the first batch settles; the mark draws a dot meanwhile. */
  readonly resident: SpriteSheets | undefined
  /** Called now if resident, and again whenever more sheets decode. */
  subscribe(listener: (sheets: SpriteSheets) => void): () => void
  /** Starts decoding once the renderer is idle; later calls do nothing. The app calls it at boot. */
  prefetch(): void
}

const stagesOf = (body: MarkBody): MarkClip[] => [`${body}.in`, `${body}.loop`, `${body}.out`]

/** What a turn shows first: grow, the plain and thinking bodies, and blocked. */
const PRIORITY: readonly MarkClip[] = ['grow', ...(['default', 'think', 'blocked'] as const).flatMap(stagesOf)]
const LATER = (Object.keys(SHEETS) as MarkClip[]).filter((clip) => !PRIORITY.includes(clip))

/**
 * A sheet that fails to load stays undecoded, so any body needing it keeps the
 * dot — or `default`, through `wantBody` — rather than showing a broken image.
 */
export function createSheetStore(): SheetStore {
  const decoded = new Set<MarkClip>()
  const listeners = new Set<(sheets: SpriteSheets) => void>()
  const sheets: SpriteSheets = {
    url: (clip) => `sprites/${clip}.png`,
    has: (clip) => decoded.has(clip),
    ready: (body) => stagesOf(body).every((clip) => decoded.has(clip)),
  }
  let resident: SpriteSheets | undefined
  let started = false

  const decode = (clip: MarkClip): Promise<void> => {
    const image = new Image()
    image.src = sheets.url(clip)
    return image.decode().then(() => { decoded.add(clip) }, () => {})
  }
  const publish = () => {
    resident = sheets
    for (const listener of listeners) listener(sheets)
  }
  const load = async () => {
    await Promise.all(PRIORITY.map(decode))
    publish()
    await Promise.all(LATER.map(decode))
    publish()
  }

  return {
    get resident() { return resident },
    subscribe(listener) {
      listeners.add(listener)
      if (resident) listener(resident)
      return () => { listeners.delete(listener) }
    },
    prefetch() {
      if (started) return
      started = true
      const start = () => { load().catch(() => {}) }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS })
      else setTimeout(start, IDLE_FALLBACK_MS)
    },
  }
}

/** One per renderer: every mark shares the decoded sheets. */
export const sheetStore = createSheetStore()

/**
 * One transcript view's live mark. Its three carriers (the waiting line, a run's
 * head, a thinking head) never show at once, so one controller serves them all:
 * `attach` moves its node into whichever carrier this paint drew, and a
 * script-created animation survives the move without restarting.
 *
 * Frames are drawn through custom properties (`--mark-sheet`, `--mark-frames`,
 * `--mark-frame`) and the stylesheet does the rest; a running animation writes
 * `transform` over the held frame, with `steps(N, jump-none)` so each frame holds.
 */
export interface WorkingMark {
  /** Shows the mark in `host` for this paint; idempotent. */
  attach(host: HTMLElement, spec: MarkSpec): void
  setSpec(spec: MarkSpec): void
  /** No carrier this paint, the turn still running: the next `attach` resumes with `in`. */
  hide(): void
  /** The turn is over: the next `attach` grows in again. */
  end(): void
  /** `true` while the pane or window is out of sight; also re-reads reduced motion. */
  syncMotion(hidden: boolean): void
  dispose(): void
}

interface Layer {
  readonly box: HTMLElement
  readonly strip: HTMLElement
}

export function createWorkingMark(store: SheetStore = sheetStore): WorkingMark {
  const root = el('span', 'mark is-dot')
  root.setAttribute('aria-hidden', 'true')
  const layers = new Map<MarkClip, Layer>()

  let spec: MarkSpec = { body: 'default', state: 'working' }
  /** `undefined` while nothing plays: before the first attach, after hide/end, or as a dot. */
  let stage: MarkStage | undefined
  /** The frame on screen when nothing animates it; where a pause resumes. */
  let held = 0
  let live = false
  let paused = false
  let needsGrow = true
  let anim: { readonly animation: Animation; readonly from: number; readonly sheet: SheetInfo } | undefined
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSwitch: ReturnType<typeof setTimeout> | undefined

  const sheets = () => (store.resident?.ready('default') ? store.resident : undefined)
  const want = () => wantBody(spec, (body) => store.resident?.ready(body) === true)

  function layerFor(clip: MarkClip, resident: SpriteSheets): Layer {
    let layer = layers.get(clip)
    if (!layer) {
      const strip = el('span', 'mark-strip')
      strip.style.setProperty('--mark-sheet', `url("${resident.url(clip)}")`)
      strip.style.setProperty('--mark-frames', String(SHEETS[clip].frames))
      layer = { box: el('span', 'mark-layer', strip), strip }
      root.appendChild(layer.box)
      layers.set(clip, layer)
    }
    // The others stay composited at a near-zero opacity, so a switch never waits on a paint.
    for (const [other, { box }] of layers) box.classList.toggle('is-warm', other !== clip)
    return layer
  }

  function show(clip: MarkClip, frame: number): Layer {
    const layer = layerFor(clip, sheets()!)
    layer.strip.style.setProperty('--mark-frame', String(frame))
    root.dataset.clip = clip
    held = frame
    return layer
  }

  function frameNow(): number {
    if (!anim) return held
    const elapsed = Number(anim.animation.currentTime ?? 0)
    return Math.min(anim.sheet.frames - 1, anim.from + Math.floor(elapsed / anim.sheet.speed))
  }

  function stop(): void {
    clearTimeout(pendingSwitch)
    clearTimeout(frameTimer)
    pendingSwitch = frameTimer = undefined
    if (anim) {
      const { animation } = anim
      const frame = frameNow()
      anim = undefined
      show(clipOf(stage!), frame)
      animation.cancel()
    }
  }

  function run(next: MarkStage, from: number): void {
    stop()
    stage = next
    if (paused) {
      show(clipOf(next), from)
      return
    }
    if (!motionPolicy().animate) {
      const rest = restStage(want())
      stage = rest.stage
      show(clipOf(rest.stage), rest.frame)
      return
    }
    const clip = clipOf(next)
    const sheet = SHEETS[clip]
    const start = Math.min(sheet.frames - 1, Math.max(from, next.kind === 'tail' ? sheet.frames - TAIL_FRAMES : 0))
    const { strip } = show(clip, start)
    const count = sheet.frames - start
    if (count < 2 || typeof strip.animate !== 'function') {
      const tick = (frame: number) => {
        frameTimer = setTimeout(() => {
          frameTimer = undefined
          if (frame + 1 < sheet.frames) {
            show(clip, frame + 1)
            tick(frame + 1)
          } else advance()
        }, sheet.speed)
      }
      tick(start)
      return
    }
    const keyframes = Array.from({ length: count }, (_, i) => ({ transform: `translateY(${(-100 * (start + i)) / sheet.frames}%)` }))
    const animation = strip.animate(keyframes, {
      duration: sheet.speed * count,
      easing: `steps(${count}, jump-none)`,
      fill: 'forwards',
    })
    anim = { animation, from: start, sheet }
    animation.finished.then(() => {
      if (anim?.animation !== animation) return
      anim = undefined
      held = sheet.frames - 1
      advance()
    }, () => {})
  }

  function advance(): void {
    run(nextStage(stage!, want()), 0)
  }

  function begin(): void {
    const resident = sheets()
    root.classList.toggle('is-dot', !resident)
    if (!resident) return
    const first: MarkStage = needsGrow && resident.has('grow') ? { kind: 'grow' } : { kind: 'in', body: want() }
    needsGrow = false
    run(first, 0)
  }

  /**
   * The activity changed mid-loop: leave at the next seam, through the loop's
   * tail if a lot of it is left, or when it plays out. Any other stage hands
   * over when it ends, in `advance`.
   */
  function requestSwitch(): void {
    clearTimeout(pendingSwitch)
    pendingSwitch = undefined
    if (stage?.kind !== 'loop' || (!anim && frameTimer === undefined)) return
    const body = stage.body
    if (want() === body) return
    const sheet = SHEETS[`${body}.loop`]
    const at = frameNow() * sheet.speed
    const seam = sheet.seams?.map((frame) => frame * sheet.speed).find((time) => time > at + 50)
    if (seam !== undefined) {
      pendingSwitch = setTimeout(() => run({ kind: 'out', body }, 0), seam - at)
    } else if (sheet.frames * sheet.speed - at > LOOP_HANDOFF_MS) {
      run({ kind: 'tail', body }, 0)
    }
  }

  function setSpec(next: MarkSpec): void {
    if (next.body === spec.body && next.state === spec.state) return
    spec = next
    if (stage === undefined || paused) return
    if (!motionPolicy().animate) run(stage, held)
    else requestSwitch()
  }

  function hide(): void {
    live = false
    stop()
    stage = undefined
  }

  const unsubscribe = store.subscribe(() => {
    if (live && stage === undefined) begin()
  })

  return {
    attach(host, next) {
      if (root.parentElement !== host) host.appendChild(root)
      live = true
      if (stage !== undefined) return setSpec(next)
      spec = next
      begin()
    },
    setSpec,
    hide,
    end() {
      hide()
      needsGrow = true
    },
    syncMotion(hidden) {
      paused = hidden
      if (stage === undefined) return
      stop()
      if (hidden) return
      run(stage, held)
      requestSwitch()
    },
    dispose() {
      hide()
      unsubscribe()
      root.remove()
    },
  }
}
