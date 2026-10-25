/**
 * Device emulation for one tab: a phone's viewport, pixel ratio, touch and
 * user agent, through CDP's `Emulation` domain.
 *
 * Every override lives on the debugger attachment and dies with it, so an
 * emulated tab holds a lease on its `CdpSession` for as long as the emulation
 * lasts — the idle detach would otherwise quietly turn it back into a desktop.
 * The lease cannot survive the attachment being taken from outside (DevTools
 * opening, the renderer going away); `restoreEmulation` notices that from the
 * session's epoch and puts the overrides back before the next operation reads
 * or drives the page.
 *
 * Electron-free, like `cdpSession.ts`: it only needs the contents' debugger.
 */

import type { BrowserEmulatePreset, BrowserEmulateRequest } from '../../runtime/protocol/browserHost.js'
import { cdpSessionFor, type CdpContents } from './cdpSession.js'
import { abortedError, withinBounds, type CallBounds } from './bounds.js'
import { BrowserHostError } from './errors.js'

export interface EmulationSettings {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  /** Absent keeps the browser's own user agent. */
  userAgent?: string
  /** `navigator.platform` to report alongside a preset's user agent. */
  platform?: string
}

const IOS_UA = 'Mozilla/5.0 (%DEVICE%; CPU %OS% 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Current flagship sizes; a page's breakpoints care about the CSS width, not the model. */
export const EMULATION_PRESETS: Record<BrowserEmulatePreset, EmulationSettings> = {
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IOS_UA.replace('%DEVICE%', 'iPhone').replace('%OS%', 'iPhone OS'),
    platform: 'iPhone',
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: IOS_UA.replace('%DEVICE%', 'iPad').replace('%OS%', 'OS'),
    platform: 'iPad',
  },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
}

/**
 * The settings a request asks for: its preset, with each explicit field laid
 * over it. Without a preset, width and height are required and the rest
 * default to a plain desktop screen.
 */
export function resolveEmulation(request: BrowserEmulateRequest): EmulationSettings {
  const base = request.preset === undefined ? undefined : EMULATION_PRESETS[request.preset]
  const width = request.width ?? base?.width
  const height = request.height ?? base?.height
  if (width === undefined || height === undefined) {
    throw new BrowserHostError('INVALID_REQUEST', 'tab.emulate needs a preset, or both width and height.')
  }
  const settings: EmulationSettings = {
    width,
    height,
    deviceScaleFactor: request.deviceScaleFactor ?? base?.deviceScaleFactor ?? 1,
    mobile: request.mobile ?? base?.mobile ?? false,
  }
  const userAgent = request.userAgent ?? base?.userAgent
  if (userAgent !== undefined) settings.userAgent = userAgent
  // The preset's platform belongs to the preset's user agent, not to one the caller supplied.
  if (request.userAgent === undefined && base?.platform !== undefined) settings.platform = base.platform
  return settings
}

/** One line for the transcript: what the tab now pretends to be. */
export function describeEmulation(settings: EmulationSettings): string {
  const parts = [`${settings.width}x${settings.height} @${settings.deviceScaleFactor}x`]
  parts.push(settings.mobile ? 'mobile with touch' : 'desktop')
  parts.push(settings.userAgent === undefined ? 'default user agent' : 'user agent overridden')
  return parts.join(', ')
}

interface Active {
  settings: EmulationSettings
  release: () => void
  epoch: number
}

const active = new WeakMap<CdpContents, Active>()

interface EmulationBounds extends CallBounds {
  check?: () => void
}

function checkOperation(bounds?: EmulationBounds): void {
  if (bounds?.signal?.aborted) throw abortedError()
  bounds?.check?.()
}

function boundedSender(contents: CdpContents, bounds?: EmulationBounds) {
  return (method: string, params?: Record<string, unknown>) => withinBounds(bounds, `sending ${method}`, () => {
    checkOperation(bounds)
    return cdpSessionFor(contents).send(method, params)
  })
}

/** The tab's current emulation, if any. */
export function emulationOf(contents: CdpContents): EmulationSettings | undefined {
  return active.get(contents)?.settings
}

/** Replaces whatever the tab emulated before with `settings`, and keeps it. */
export async function applyEmulation(contents: CdpContents, settings: EmulationSettings, bounds?: EmulationBounds): Promise<void> {
  checkOperation(bounds)
  const session = cdpSessionFor(contents)
  const previous = active.get(contents)
  // The new lease first, so the count never touches zero between the two.
  const release = session.acquire()
  const epoch = session.epoch
  try {
    await sendOverrides(boundedSender(contents, bounds), settings)
    checkOperation(bounds)
  } catch (error) {
    release()
    if (previous) {
      previous.release()
      previous.epoch = -1
    }
    throw error
  }
  previous?.release()
  active.set(contents, { settings, release, epoch })
}

/**
 * Puts the overrides back when the attachment they rode on was lost since
 * they were set. With DevTools open there is nothing to put them back on;
 * the operation that follows still runs, and the next one tries again.
 */
export async function restoreEmulation(contents: CdpContents, bounds?: EmulationBounds): Promise<void> {
  checkOperation(bounds)
  const current = active.get(contents)
  if (current === undefined || contents.isDestroyed() || contents.isDevToolsOpened()) return
  const session = cdpSessionFor(contents)
  if (current.epoch === session.epoch) return
  const release = session.acquire()
  const epoch = session.epoch
  try {
    await sendOverrides(boundedSender(contents, bounds), current.settings)
    checkOperation(bounds)
  } catch (error) {
    release()
    current.release()
    throw error
  }
  current.release()
  active.set(contents, { settings: current.settings, release, epoch })
}

/** Clears the tab's emulation. `false` when it had none. */
export async function resetEmulation(contents: CdpContents, bounds?: EmulationBounds): Promise<boolean> {
  checkOperation(bounds)
  const current = active.get(contents)
  if (current === undefined) return false
  active.delete(contents)
  const session = cdpSessionFor(contents)
  try {
    // A lost attachment already took the overrides with it.
    if (current.epoch === session.epoch && !contents.isDestroyed()) {
      const send = boundedSender(contents, bounds)
      await send('Emulation.clearDeviceMetricsOverride')
      await send('Emulation.setTouchEmulationEnabled', { enabled: false })
      if (current.settings.userAgent !== undefined) {
        // An empty override is CDP's "no override".
        await send('Emulation.setUserAgentOverride', { userAgent: '' })
      }
      checkOperation(bounds)
    }
  } finally {
    current.release()
  }
  return true
}

async function sendOverrides(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  settings: EmulationSettings,
): Promise<void> {
  await send('Emulation.setDeviceMetricsOverride', {
    width: settings.width,
    height: settings.height,
    deviceScaleFactor: settings.deviceScaleFactor,
    mobile: settings.mobile,
  })
  await send('Emulation.setTouchEmulationEnabled', settings.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
  await send('Emulation.setUserAgentOverride', {
    userAgent: settings.userAgent ?? '',
    ...(settings.platform === undefined ? {} : { platform: settings.platform }),
  })
}
