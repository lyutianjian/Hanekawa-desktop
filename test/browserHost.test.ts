import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DesktopBrowserHost } from '../src/desktop/browser/host.js'
import { cdpSessionFor } from '../src/desktop/browser/cdpSession.js'
import type { BrowserTabHost } from '../src/desktop/browser/tabs.js'

class FakeDebugger extends EventEmitter {
  attached = false
  sent: string[] = []
  wait: (() => Promise<void>) | undefined
  isAttached() { return this.attached }
  attach() { this.attached = true }
  detach() { this.attached = false; this.emit('detach', {}, 'closed') }
  async sendCommand(method: string) {
    this.sent.push(method)
    await this.wait?.()
    return {}
  }
}

class FakeContents extends EventEmitter {
  debugger = new FakeDebugger()
  reads = 0
  isDestroyed() { return false }
  isDevToolsOpened() { return false }
  getURL() { return 'https://browser.test' }
  async executeJavaScriptInIsolatedWorld() { this.reads++; return { w: 390, h: 844, dpr: 3 } }
}

const caller = { sessionId: 'browser-session', turnId: 'browser-turn' }

test('the browser host propagates Stop through emulation and restoration before another action can run', { timeout: 2_000 }, async () => {
  const contents = new FakeContents()
  const noop = () => {}
  const host = new DesktopBrowserHost({
    laneForSession: () => 'lane',
    tabs: {
      onTakeOver: () => noop, onUserInput: () => noop, onRelease: () => noop,
      describe: () => [{ tabId: 'tab', lane: 'lane', url: 'https://browser.test', loading: false }],
      pageFor: () => ({ contents, generation: 1, domReady: true }), setTakenOver: noop, setAgentActive: noop,
    } as unknown as BrowserTabHost,
  })
  let release = noop
  try {
    for (const restore of [false, true]) {
      if (restore) {
        contents.debugger.wait = undefined
        await host.emulate(caller, 'tab', { preset: 'iphone' })
        contents.debugger.detach()
      }
      contents.debugger.sent = []
      contents.reads = 0
      const gate = new Promise<void>((resolve) => { release = resolve })
      contents.debugger.wait = () => gate
      const controller = new AbortController()
      const pending = restore
        ? host.type(caller, 'tab', { text: 'must not type', signal: controller.signal })
        : host.emulate(caller, 'tab', { preset: 'iphone', signal: controller.signal })
      const outcome = pending.then(() => 'success', (error: { code: string }) => error.code)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(contents.debugger.sent.length, 1)
      controller.abort()
      assert.equal(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('pending'), 60))]), 'OPERATION_ABORTED')
      assert.equal((cdpSessionFor(contents) as unknown as { users: number }).users, 0)
      release()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(contents.debugger.sent.length, 1)
      assert.equal(contents.reads, 0)
    }
    contents.debugger.wait = undefined
    await host.emulate(caller, 'tab', { preset: 'desktop' })
    assert.equal(contents.reads, 1, 'a later action still works')
  } finally {
    release()
    host.dispose()
    contents.debugger.detach()
  }
})
