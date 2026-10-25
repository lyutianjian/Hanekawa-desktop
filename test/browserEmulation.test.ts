import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { cdpSessionFor, type CdpContents } from '../src/desktop/browser/cdpSession.js'
import {
  applyEmulation,
  emulationOf,
  resetEmulation,
  resolveEmulation,
  restoreEmulation,
} from '../src/desktop/browser/emulation.js'

/** A `WebContents` reduced to a debugger that records what it was sent. */
class FakeDebugger extends EventEmitter {
  attached = false
  sent: string[] = []
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  async sendCommand(method: string): Promise<unknown> {
    this.sent.push(method)
    return {}
  }
  kick(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  isDestroyed(): boolean {
    return false
  }
  isDevToolsOpened(): boolean {
    return false
  }
}

function contents(): { fake: FakeContents; target: CdpContents } {
  const fake = new FakeContents()
  return { fake, target: fake as unknown as CdpContents }
}

test('a preset resolves with explicit fields laid over it', () => {
  const phone = resolveEmulation({ preset: 'iphone', width: 375 })
  assert.equal(phone.width, 375)
  assert.equal(phone.height, 844)
  assert.equal(phone.mobile, true)
  assert.match(phone.userAgent ?? '', /iPhone/)
  assert.equal(phone.platform, 'iPhone')
  // A caller's own user agent does not inherit the preset's platform.
  assert.equal(resolveEmulation({ preset: 'iphone', userAgent: 'X' }).platform, undefined)
  assert.deepEqual(resolveEmulation({ width: 500, height: 600 }), { width: 500, height: 600, deviceScaleFactor: 1, mobile: false })
  assert.throws(() => resolveEmulation({ width: 500 }), /preset, or both width and height/)
})

test('an emulated tab keeps its attachment, and reset gives it back', async () => {
  const { fake, target } = contents()
  const session = cdpSessionFor(target)
  await applyEmulation(target, resolveEmulation({ preset: 'iphone' }))
  assert.equal(fake.debugger.attached, true)
  assert.deepEqual(fake.debugger.sent, [
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setTouchEmulationEnabled',
    'Emulation.setUserAgentOverride',
  ])
  // Held: a lease-less command's idle timer never arms while the count is non-zero.
  assert.equal((session as unknown as { users: number }).users, 1)

  // Replacing keeps exactly one lease.
  await applyEmulation(target, resolveEmulation({ preset: 'desktop' }))
  assert.equal((session as unknown as { users: number }).users, 1)

  fake.debugger.sent = []
  assert.equal(await resetEmulation(target), true)
  assert.deepEqual(fake.debugger.sent, ['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled'])
  assert.equal((session as unknown as { users: number }).users, 0)
  assert.equal(emulationOf(target), undefined)
  assert.equal(await resetEmulation(target), false)
})

test('a lost attachment is re-emulated on the next operation, once', async () => {
  const { fake, target } = contents()
  await applyEmulation(target, resolveEmulation({ preset: 'ipad' }))
  fake.debugger.sent = []
  await restoreEmulation(target)
  assert.deepEqual(fake.debugger.sent, [], 'nothing to restore while the attachment holds')

  fake.debugger.kick()
  await restoreEmulation(target)
  assert.equal(fake.debugger.attached, true)
  assert.equal(fake.debugger.sent.length, 3)
  await restoreEmulation(target)
  assert.equal(fake.debugger.sent.length, 3)
  assert.equal((cdpSessionFor(target) as unknown as { users: number }).users, 1)

  // A reset after a loss the tab never came back from sends nothing: the overrides died with it.
  fake.debugger.kick()
  fake.debugger.sent = []
  assert.equal(await resetEmulation(target), true)
  assert.deepEqual(fake.debugger.sent, [])
})

for (const operation of ['apply', 'replace', 'restore', 'reset'] as const) {
  test(`${operation} emulation cancels a stuck command, releases its lease and ignores late replies`, async () => {
    const { fake, target } = contents()
    const settings = resolveEmulation({ preset: 'iphone' })
    if (operation !== 'apply') await applyEmulation(target, settings)
    if (operation === 'restore') fake.debugger.kick()
    fake.debugger.sent = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fake.debugger.sendCommand.bind(fake.debugger)
    fake.debugger.sendCommand = async (method) => {
      await original(method)
      await gate
      return {}
    }
    const controller = new AbortController()
    const options = { signal: controller.signal }
    const pending = operation === 'apply' || operation === 'replace' ? applyEmulation(target, settings, options)
      : operation === 'restore' ? restoreEmulation(target, options) : resetEmulation(target, options)
    const result = pending.then(() => 'success', (error: { code?: string }) => error.code)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(fake.debugger.sent.length, 1)
      controller.abort()
      assert.equal(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('pending'), 60))]), 'OPERATION_ABORTED')
      assert.equal((cdpSessionFor(target) as unknown as { users: number }).users, 0)
      release()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(fake.debugger.sent.length, 1, 'a late reply must not send another command')
      fake.debugger.sendCommand = original
      await applyEmulation(target, settings)
      assert.equal(emulationOf(target), settings, 'the next operation can acquire a fresh lease')
    } finally {
      release()
      await result
      fake.debugger.kick()
    }
  })
}

test('emulation commands time out and recheck ownership before sending follow-up commands', { timeout: 1_000 }, async () => {
  const { fake, target } = contents()
  const settings = resolveEmulation({ preset: 'iphone' })
  fake.debugger.sendCommand = async (method) => {
    fake.debugger.sent.push(method)
    return new Promise(() => {})
  }
  await assert.rejects(() => applyEmulation(target, settings, { timeoutMs: 5 }), { code: 'PAGE_NOT_READY' })
  assert.equal((cdpSessionFor(target) as unknown as { users: number }).users, 0)
  let allowed = true
  fake.debugger.sent = []
  fake.debugger.sendCommand = async (method) => {
    fake.debugger.sent.push(method)
    allowed = false
    return {}
  }
  await assert.rejects(() => applyEmulation(target, settings, { check: () => {
    if (!allowed) throw new Error('ownership changed')
  } }), /ownership changed/)
  assert.equal(fake.debugger.sent.length, 1)
  assert.equal((cdpSessionFor(target) as unknown as { users: number }).users, 0)
  fake.debugger.kick()
})
